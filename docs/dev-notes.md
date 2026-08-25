# Dev Notes — NRPC Interactive Map

## Stack
Pure static site. No build step, no package manager. Deployed via GitHub Pages from `master`.

| Dependency | Source |
|---|---|
| ArcGIS JS API 4.29 | CDN (AMD/Dojo loader) |
| JSZip 3.10.1 | CDN |

**Important:** JSZip must load **before** the ArcGIS script tag in `index.html`. Loading it after causes a Dojo AMD `multipleDefine` conflict that breaks city layer queries.

---

## File Structure

```
index.html          — app shell, script loading order
styles.css          — all custom styles
js/
  shp-writer.js     — binary SHP/SHX/DBF/PRJ encoder (pure JS, no ArcGIS)
  export-utils.js   — GeoJSON builder, safeName() (pure JS, no ArcGIS)
  main.js           — all ArcGIS/UI logic (~1000 lines)
docs/
  hub_site_text.html — embeddable content for ArcGIS Hub site (6-tab CSS interface)
  NRPC-use-cases.md  — source document for use case narratives
  dev-notes.md       — this file
```

`shp-writer.js` and `export-utils.js` expose globals consumed by `main.js`. All three load in the `<body>` after ArcGIS.

---

## Map Data
All layers, symbology, and default visibility are managed in **ArcGIS Online**.
Portal item ID: `d664f1d163544d25bb92921e5c4bf214`

The map must be publicly shared — there is no auth in the app.

---

## main.js Structure

| Section | What it does |
|---|---|
| `queryAllFeatures()` | Paginates feature queries in batches of 1,000 via OID-first strategy |
| `getExportableLayers()` | Walks visible layers, skips Boundaries group and graphics layers |
| `view.when()` | Everything below runs after the map loads |
| Toggle bar | Builds the top-left button bar (Legend, Layers, Basemap, Zoom to..., Clip & Zip, Contribute) |
| LayerList setup | Opacity sliders on all layers/groups; group click expands and turns on all children |
| City/county dropdown | Multi-select cities or full county; highlights extent on map; feeds clip geometry |
| Clip & Zip | Queries, encodes, and packages visible non-Boundaries layers to SHP or GeoJSON ZIP |
| Basemap dropdown | Switches between Light Gray Canvas, Imagery, Navigation; per-basemap opacity slider |
| Contribute panel | ArcGIS Editor widget in a top-right panel; auto-turns on NRPC Opportunity Layers on open |
| Legend auto-show | Legend starts hidden; auto-opens the first time any non-Boundaries group is turned on |
| Layer visibility watchers | Keep Clip & Zip panel state (warning vs. ready) in sync as layers are toggled |

---

## Layer Visibility Behavior

When a group layer is toggled **on** by the user, two things happen:
1. The group expands in the LayerList (`item.open = true`)
2. All children of that group are turned visible

When a group layer is toggled **off**, the group collapses.

This is driven by `layer.watch("visible", ...)` in `listItemCreatedFunction`.

**Important — `propagatingDepth` counter:** When a child group turning on causes its parent to also turn on (upward propagation), that parent's watcher must not then cascade back down to all siblings. The `propagatingDepth` counter is incremented before setting a parent visible and decremented after. The child-cascade step is skipped when `propagatingDepth > 0`.

**Important — `skipChildCascade` flag:** Used exclusively in the Contribute toggle handler. When Contribute opens, only "NRPC Opportunity Layers" and its children should turn on — not every layer in the parent "NRPC Data" group. The flag is set before making ancestor groups visible, preventing their watchers from cascading to all siblings. It is reset via `Promise.resolve().then()` after all async ArcGIS watchers have fired.

---

## Notable Constraints / Known Issues

- **Large layer exports:** The "Parcel Prioritization Model Results" polygon layer can freeze the browser if exported alongside several other layers simultaneously. Root cause is cumulative ZIP memory. Feature arrays are nulled after encoding to give GC a hint, but no hard limit is enforced. A warning prompt is shown when this layer is included in the export.
- **No error UI:** If the WebMap fails to load (e.g. portal item permissions), there is no user-facing error message.
- **Authentication (TODO):** There is currently no auth in the app — all layers are publicly shared. The "NRPC Opportunity Layers" used by the Contribute panel are public **and editable**, meaning anyone can submit edits without logging in. This is a known risk. Future work should add ArcGIS OAuth (via `esri/identity/OAuthInfo` + `esri/identity/IdentityManager`) so that only authenticated users (e.g. NRPC staff with an ArcGIS Online org account) can submit contributions. The editable layer's sharing should also be tightened in ArcGIS Online once auth is in place.
- **Basemap IDs:** Only use verified ArcGIS basemap string IDs. `"osm"` was removed — it returns "Access Blocked" in this context. Valid options in use: `"satellite"`, `"streets-navigation-vector"`.
- **Fullscreen in iframe:** The ArcGIS Hub embed blocks the browser Fullscreen API. The fullscreen button is replaced with an open-in-new-tab button (`window.open`) that works from within the iframe.
- **Contribute panel placement:** The Editor widget panel is added via `view.ui.add()` at top-right rather than the left panel stack, to avoid crowding when Legend and Layers are open simultaneously.

---

## Parcel Report (branch `parcel-report`)

Click any point in Hennepin County → a right-hand panel of everything the map
can pull for that parcel → **Generate report** → a written site brief from
Claude, streamed into the panel.

All of it lives in `js/parcel-report.js`. `main.js` carries a single hook at the
end of `view.when()`:

```js
if (window.NRPCParcelReport) {
  window.NRPCParcelReport.init({ view, Graphic, GraphicsLayer });
}
```

Nothing else in `main.js` changes, so the feature can be dropped by deleting one
file and one script tag.

### Where the numbers come from

| Source | Endpoint | What it gives |
|---|---|---|
| Hennepin **Parcel Base** | `Maps/NATURALRESOURCES/MapServer/2` | PID, address, acreage, property type, assessed values, sale history |
| **Parcel Prioritization Model (Parcel View)** | `Hennepin_Suitability_Model_Results_parcel_detail/FeatureServer/97` | seven component scores, Overall Value, county Rank |
| Nine context layers | parks, DNR public waters, regional trails, Met Council eco-significant / eco-sensitive / protection / improvement, public parcels, watershed districts | what falls on or near the parcel |

The click is a point-in-polygon query against Parcel Base. The model layer joins
on `PID`. Context layers are matched against the parcel's **bounding box padded
by 250 m** — so a hit means "on or near", never "inside", and the prompt tells
the model to word it that way.

Two facts worth not re-deriving:

- **`PARCEL_AREA` is square feet.** For PID `1111823340002` it reads 880 848.5
  while the same layer's `SHAPE.STArea()` reads 81 765.4 m². 880 848.5 / 43 560
  = 20.22 acres and 81 765.4 / 4 046.86 = 20.21 acres — same parcel, so the
  field is ft². That is the only conversion `parcelAcres` does.
- **Rank 1 is the best parcel.** PID `1111823340002` is Rank 36 768 with Overall
  Value 17.117; PID `0102724110003` is Rank 430 463 with Overall Value 0.022. A
  smaller rank number goes with a larger Overall Value. The total for the
  percentile is fetched live (`returnCountOnly`), never hard-coded, because the
  layer gets republished.

### The API key

There is no key in this repo and there must never be one. The user types their
own Anthropic key into the panel; it is kept in `localStorage` under
`nrpc-parcel-report.apiKey` on that one browser and sent only to
`api.anthropic.com`. "Forget key" deletes it.

The request needs `anthropic-dangerous-direct-browser-access: true` — without it
the API sends no CORS headers and the browser blocks the call. The header is the
API saying out loud what this design is: the key lives in the browser, and
anyone with the browser has the key. That is acceptable for a key the user
supplies for themselves; it is **not** acceptable for an org key handed out to
site visitors. If this ever needs to serve the public, put a small proxy in
front of it and keep the key server-side.

Request shape: `POST /v1/messages`, `anthropic-version: 2023-06-01`,
`stream: true`, `thinking: {type: "adaptive"}`,
`output_config: {effort: "medium"}`, `max_tokens: 8000`. Default model
`claude-sonnet-5`, switchable to `claude-opus-5` in the panel. Streaming is SSE
parsed by hand — the deltas we care about are `content_block_delta` /
`text_delta`.

### Privacy

`OWNER_NM` and the `TAXPAYER_NM*` fields carry a private individual's name and
mailing address. They are public record, but a conservation-priority summary
does not need them, so they are **withheld from the API payload by default** and
sent only if the user ticks "Send owner name to Claude". The panel still shows
what the county publishes; the toggle only governs what leaves the browser.

### Guardrails on the model

The system prompt forbids any fact not in the supplied JSON, requires missing
fields to be named as missing, and requires "on or near" wording for the
buffered context hits. Model output is HTML-escaped before the tiny Markdown
renderer touches it, so a response can never inject markup into the page.

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

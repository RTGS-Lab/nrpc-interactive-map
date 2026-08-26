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
| Five **NRPC contribution layers** | the two NRPC Opportunity Layers plus the three Winter Workshop 2025 layers | what coalition members themselves put on the map — see "Shared opportunities" below |

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

### Shared opportunities

The report's fourth section is what NRPC coalition members have themselves put
on the map on or near the parcel — as distinct from every other layer above,
which is a dataset somebody else publishes.

**Where it comes from.** Five feature layers, all under the webmap's `NRPC Data`
group, all on `services.arcgis.com/8df8p0NlLFEShl0r`:

| Layer in the map | Service | Geometry | Features on 2026-08-26 |
|---|---|---|---|
| Opportunity Area (Polygon) | `NRPC_Opportunity_Layer/FeatureServer/1` | polygon | **0** |
| Opportunity Area (Point) | `NRPC_Opportunity_Layer/FeatureServer/0` | point | **0** |
| Winter Workshop 2025 — Activity 1 | `Winter_Workshop_Activity_1/FeatureServer/0` | point | 162 |
| Activity 2: Physical Connection | `Winter_Workshop_Activity_2/FeatureServer/1` | polygon | 21 |
| Activity 2: Thematic Connection | `Winter_Workshop_Activity_2/FeatureServer/0` | polyline | 49 |

The first two are the layers the Contribute panel's Editor widget writes to.
**Both are empty**, so a report built on those alone would print "none recorded"
on every parcel in the county. The three Winter Workshop layers carry the
identical contribution schema — the Contribute form was clearly built from the
workshop form — and hold every opportunity anyone has recorded so far, so all
five are queried and each contribution is labelled with the layer it came from.
When contributions start arriving through Contribute they appear with no code
change.

**There is no "opportunity type" field.** The schema is: `name` (Your Name),
`organization`, `describe_opportunity`, `potential_funder`, `CreationDate`, plus
either `three_years` / `easy_start` / `what_smooth` / `what_challenging` (the
opportunity schema) or `connection_needs` / `rate_priority` /
`rate_feasibility` (the connection schema). The layer a contribution sits in is
the only type distinction the data carries, and that is what the report prints
as the type. Do not invent one.

Two gotchas in that schema, both verified against the live services:

- `rate_feasibility` is an **integer** on the polyline layer and a **string** on
  the polygon layer. Same survey question, two published types.
- `CreationDate` comes back as an **ISO string** from these hosted layers, not
  the epoch-milliseconds Hennepin's services use. `contributedOn()` takes
  either.

**The join is two queries per layer**, not the padded bounding box the nine
context layers use:

1. `spatialRel=esriSpatialRelIntersects` against the **parcel polygon itself**
   → "on the parcel";
2. the same query plus `distance=<D>&units=esriSRUnit_Meter` → everything
   within D, where D is computed from the adjacent parcels — see "Parcel
   adjacency" below. It was a fixed 250 m until that section landed.

(2) minus (1), by `OBJECTID`, is sorted into the other two tiers. The server
does the topology for tier 1; the distance in metres is computed in
`minDistanceM()` because ArcGIS will not report it. That function projects both
geometries with the same 111 320 m/degree local equirectangular approximation
`padBBox()` uses — accurate to well under a metre over a parcel and its
neighbourhood — and takes the minimum vertex-to-segment distance in both
directions. It is only ever called on features the server has already said do
**not** intersect the parcel, so boundary-to-boundary is the true distance and
there is no containment case.

---

## Parcel adjacency (branch `parcel-report`)

"Within 250 m" and "next door" are different questions, and the second is the
one a land manager asks. A neighbouring 213-acre park **touches** the clicked
parcel, but something drawn at its far end sits a kilometre away — and a radius
wide enough to catch it catches everything else at that radius too.

So the search is topological, and the results are tiered:

| Tier | Test | Kept |
|---|---|---|
| `on the parcel` | server: intersects the parcel polygon | always |
| `on an adjacent parcel` | client: intersects a parcel within 30 m of it | always, with the PID |
| `nearby` | within 250 m of the parcel boundary | always |
| — | none of the above | **dropped, and counted** |

That last row is the whole reason the section does not balloon: D can be
1,500 m, but nothing between 250 m and 1,500 m survives unless it is standing
on a parcel that touches this one.

**One extra query, run concurrently.** `fetchAdjacentParcels()` asks Parcel Base
for everything within `ADJ_TOLERANCE_M` (30 m) of the clicked polygon — the same
layer and the same spatial index the click itself used. It is fired in the same
tick as the nine context fetches, not after them; the opportunity queries then
chain off it, because they cannot know how far to look until they know what
touches the parcel. Measured: the adjacency query is 0.4–1.0 s and the nine
context layers are slower than that, so on most parcels it costs nothing at all.

**The constants and what they are for.** `ADJ_TOLERANCE_M` 30 (a road
right-of-way — on PID 2411921110001, 15 m finds 9 neighbours and 30 m finds 13;
the four extra are across 83rd Ave N). `ADJ_MAX` 40 parcels searched, nearest
first by envelope distance, the rest counted and named in one line.
`ADJ_MAX_D_M` 1,500 m ceiling on D. `PANEL_OPP_LIMIT` 12, `PRINT_OPP_LIMIT` 50,
`OPP_PROMPT_LIMIT` 12.

D itself is `min(1500, max(250, farthest envelope corner of any kept adjacent
parcel))`.

### Three gotchas, all verified against the live services on 2026-08-26

- **Hennepin's Parcel Base returns twelve fewer features than
  `resultRecordCount` asks for.** Ask 30 → 19, ask 41 → 29, ask 50 → 38, ask
  60 → 48, ask 80 → 68, ask 100 → 88, ask 150 → all 121. `exceededTransferLimit`
  is the only trustworthy "there are more" signal. `ADJ_FETCH` is therefore
  `ADJ_MAX + 20`.

- **`minDistanceM()` cannot stand in for `intersects()`.** On PID
  `2411921110001` against Winter Workshop Activity 2 polygon `OBJECTID` 5 the
  server says they intersect, and they do — but `minDistanceM()` returns
  **0.64 m**, because the two boundaries cross *between* vertices and a
  vertex-to-segment minimum never reaches zero there. Any "distance ≈ 0 means
  on it" rule silently mis-tiers that contribution. Hence the geometry engine.

- **The geometry engine is loaded by this file, for itself.** `index.html`
  provides the ArcGIS AMD loader, so `parcel-report.js` calls
  `require(["esri/geometry/geometryEngine", "esri/geometry/support/jsonUtils"])`
  on its own. `init()`'s signature and `main.js` are untouched, so the feature
  still drops out by deleting one file and one script tag — the property the
  previous commit protected. If the require fails or takes longer than 12 s,
  `geometryEngine()` resolves `null`, the middle tier is skipped, and the
  section says so in one line and behaves exactly as the old 250 m one did.

### Deliberately not done

- **No `maxAllowableOffset` on the adjacent-parcel geometry.** Generalizing it
  to the current scale would halve the payload (46 kB → 27 kB on the densest
  parcel in the county), but the tiering is a *topological* test against those
  rings, so a scale-dependent generalization would make the same parcel report
  different tiers at different zoom levels. A reproducible report is worth
  20 kB.

### Known limits

- The nearest-40 cap and D are computed from what one query returned. On a
  parcel with more than ~48 neighbours *and* a far-reaching one among the ones
  the server did not send, D can be short. The densest parcel found in the
  county (PID `3602924210376`, 121 neighbours) is not such a case — all 121 are
  small and close — but the shape is possible.
- Tiers are computed against parcel boundaries, so a contribution drawn in the
  road between two parcels lands in `nearby`, not on either.
- `NRPCParcelReport.dev.timings` carries wall-clock per stage for the last
  parcel loaded. Nothing in the UI reads it; it is how the ~1 s budget gets
  re-checked when a service gets slower.

**Degrading.** Every contribution query carries a 12 s `AbortController`
deadline (`OPP_TIMEOUT_MS`) and its own try/catch, and `fetchOpportunities()`
cannot reject. Three outcomes read differently on purpose: nothing found, some
layers unreachable (the list is a floor), and every layer unreachable (unknown,
not empty). The nine older context layers still have **no** timeout — a wedged
one of those will hang the panel indefinitely. Worth fixing; not fixed here.

**In the prompt.** `compactOpportunities()` trims to the first 12 items,
truncates each description at 400 characters and drops null keys, then the
system prompt gains a `## Shared opportunities` section and a rule that these
are proposals typed into the map, not funded projects or county policy.

### Privacy

Contributor names (`name`) are real people who filled in a workshop form. They
are printed in the panel and on the PDF — for outreach, who to call is the
actionable field — but `stripOpportunityContributors()` removes them from the
API payload always. `Creator` / `Editor` are not fetched at all; on the workshop
layers they are the facilitator's account (`runcklab_UMN`), not the contributor.

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

### Export as PDF

The panel grows an **Export as PDF** button the moment a report finishes
rendering, and loses it again the moment a new parcel is clicked or a new
generation starts. `showReport()` is the one place that decides a report is
finished — both the streamed path and the dev hooks go through it — so "the
button is showing" always means "that exact render succeeded".

**No PDF library.** The button builds a print-only copy of the report into
`#pr-print` and calls `window.print()`; the browser's own "Save as PDF"
destination writes the file. `html2canvas` + `jsPDF` would rasterise the panel,
so the text would stop being text — unselectable, unsearchable, soft on any
printer — and would add a pinned CDN script to a feature that has no dependency
at all today. Printing keeps real vector text, lets the browser paginate and
honour the user's paper size, and costs one extra click in the print dialog.
The button's helper text says so.

The print stylesheet is armed by `body.pr-print-ready`, which only the export
adds. Before any export, plain Ctrl+P still prints the map exactly as it always
did. Once armed, `body.pr-print-ready > *:not(#pr-print) { display: none }`
hides the map, the panel and every control, so a page of paper carries the
report and nothing else. Sections flow across pages; the atoms that never split
are table rows and headings.

The printed document is built from the same `facts` object the panel and the
API payload come from, so it carries more than the panel's summary table: full
assessment fields, all seven model scores with the rank and percentile, every
context layer including the ones that matched nothing, every shared opportunity
in full (the panel shows the first ten), the brief, the generation timestamp,
and a sources footer. **Owner and taxpayer names are left out**, exactly as they
are left out of the API request; opportunity contributors are not.

Two printing-only data fixes live in `buildPrintDoc()`: an all-zero `ZIP_CD` is
dropped rather than printed as "00000", and the last-sale row is suppressed
unless there is a sale date, so an empty record cannot read as "$0".

### Dev hooks

`NRPCParcelReport.dev` — `loadParcel(lon, lat)`, `showReport(markdown)`,
`buildPrintDoc()`. Nothing in the UI calls them. They exist so the export path
can be exercised end to end without an Anthropic key and without spending a
token: load a real parcel, push a canned brief through the same `showReport()` a
streamed one ends in, then fill `#pr-print` without opening a modal dialog.
That is how the sample PDF in the chief-of-staff folder was produced, headless.

---

## Mobile — the parcel you are standing on (branch `mobile`)

Branched from `parcel-report` at df482bb. One tap on a phone uses the device's
location to select the parcel you are standing on and opens the same context a
desktop click opens: facts, seven model scores and county rank, nine context
layers, shared opportunities by adjacency tier, the LLM brief, the PDF export.

### What is mobile, and what is not

`js/mobile.js` decides. `init()` returns immediately unless
`(max-width: 768px)` or `(pointer: coarse)` matches — `?mobile=1` / `?mobile=0`
overrides it for testing. Detection is by viewport and pointer, never by
user-agent string.

Everything the feature styles is gated on a single `nrpc-mobile` class that
`init()` puts on `<html>`. Nothing in the mobile CSS can reach the desktop
layout even by accident, because on a desktop the class is never added.

The desktop path is untouched: same `view.on("click")` handler, same pipeline,
same panel.

### The seam

`parcel-report.js` used to have one `loadParcel(lon, lat)`. It is now three:

| function | does |
|---|---|
| `beginLoad()` | reset the panel to "loading", start the clock |
| `selectParcelFeature(feature, lon, lat)` | outline it, assemble facts, render |
| `loadParcel(lon, lat)` | `beginLoad()` → fetch the parcel at the point → `selectParcelFeature()` |

The desktop click and the mobile locate both end in `selectParcelFeature()`, so
the two paths cannot drift. `init()` publishes them, plus the panel nodes, as
`window.NRPCParcelReport.api`, and calls `window.NRPCMobile.init(api)` at the
end of its own setup. `main.js` is unchanged.

### Location

`navigator.geolocation.getCurrentPosition` with `enableHighAccuracy: true`,
a 10 s timeout and `maximumAge: 0`, always from a button press — browsers, iOS
Safari especially, will not prompt outside a user gesture.

The accuracy radius is drawn as a polygon and stated in words ("accurate to
about 12 m"). A blue dot on a grey basemap does not tell anyone whether the
report they are about to read is about the parcel they are standing on; the
radius does. Above 100 m the line turns amber and a "no parcel here" message
says the fix was probably the culprit.

"Follow me" is `watchPosition`, off by default — high-accuracy watching holds
the GPS on and this gets opened in the field on a battery that has to last the
site visit. When on, the dot tracks every fix but the parcel is re-selected
only once the fix has moved more than 30 m, because a metre of GPS jitter must
not cost a round trip. It is cleared on `visibilitychange` and restored when
the page comes back.

Every failure gets plain language, including the one the error codes miss: an
`http://` origin, where the API exists and always fails. Each message ends with
"tap the map to pick a parcel by hand", which still works.

### No parcel layer on a phone

The webmap's Boundaries ▸ Parcels layer is the Hennepin Parcel Base — 445,517
features — and it is the slowest thing on screen over a phone radio. The locate
path never needs it: the parcel is one REST query at the point, drawn as a
single graphic. So it is switched off at init (matched by service URL, not by
title, which is editable in ArcGIS Online) and there is a "Parcel outlines"
toggle in the drawer to put it back.

### Menu management: one surface, always

On a 1440px desktop the toolbar's six tools are independent widgets and it does
not matter that two can be open at once. At 390px it matters: two open panels
cover the map completely, including the position dot. So on mobile the six
tools, the drawer and the report sheet are ONE stack with one rule — exactly
one is open at a time.

The manager does not reimplement `main.js`'s open/close logic. Every tool
represents "open" the same way — `hidden` off the panel, `active` on its
button — so a `MutationObserver` per tool enforces exclusivity *around* the
desktop handlers, which still own opening and closing. What the manager owns is
what else must close, and how the result is sized for a phone: the `mb-surface`
class re-anchors it full width above the locate bar with a capped height,
overriding the inline `top`/`left` `main.js` computed from a toolbar button
that was inside the drawer being closed.

- Landing is a clear map: hamburger, "Use my location", "Follow me".
- The hamburger is the way in and the way out — if anything covers the map it
  closes that first.
- Selecting a parcel closes any open tool. The sheet wins.
- A closed sheet stays recoverable: the desktop's side tab becomes a "Parcel
  report" chip above the locate bar, appended to `<body>` rather than left
  inside the panel — a transformed ancestor is the containing block for
  `position: fixed` descendants, so left in place the chip rides off-screen
  with the sheet it exists to bring back.
- Escape and the back gesture each close one layer.

**The bug this cost, worth knowing before writing another observer:**
`classList.add()` on a token that is already present still rewrites the class
attribute, and a rewritten attribute still queues a `MutationRecord`. An
observer that "closes what is already closed" therefore wakes itself, and six
observers that close each other wake each other forever inside the microtask
queue. It does not throw and it does not log — it freezes the renderer before
first paint. Instrumented 2026-08-26: all six observers hit a 300-callback
debug cap during page load and the tab stopped answering CDP. Every class write
in the manager now goes through `setClass()`, which writes only on a real
change.

### The sheet

The desktop's right-hand panel becomes a bottom sheet with three stops — peek
30%, half 58%, full 93% of `100dvh` (`100vh` fallback; the difference is the
collapsing URL bar). A grip drags between them and taps cycle. Only the grip
takes pointer capture, so `#pr-body` keeps its own scrolling. Heights use `dvh`
because `100vh` on a phone includes the URL bar and puts the sheet's bottom
edge underneath it.

### Testing without a phone

Chrome device emulation is not reachable through the extension, so
`mobile-harness.html` loads the app in a 390×844 iframe. Media queries inside
an iframe evaluate against the iframe's viewport, so the real detection fires
rather than being forced.

Two traps, both cost time:

1. **A background tab freezes CSS transitions mid-flight.** The sheet and the
   drawer then measure as stuck part-way — off-screen, in the sheet's case, so
   a wheel aimed at it hits the map and "the sheet does not scroll" looks like
   a bug in the sheet. Inject
   `*{transition:none!important;animation:none!important}` before measuring or
   screenshotting anything.
2. **Geolocation must be mocked, not prompted.** The permission prompt is
   browser chrome and cannot be driven. Replace `navigator.geolocation` with a
   stub that calls back with a known point.

### HTTPS

`serve-mobile.sh` serves the repo over TLS on the LAN so a real phone can use
geolocation at all — it is a secure-context API, and a phone is never on
localhost. It generates a self-signed certificate with `openssl` (or `mkcert`
if installed) into `.dev-certs/`, which it adds to `.gitignore` itself; the
`subjectAltName` carries the LAN IP, because every current browser ignores CN.
It prints the URL and a QR code if `qrencode` is present. Accept the
certificate warning once per device.

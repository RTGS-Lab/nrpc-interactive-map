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

## Street View Panel (branch `street-view`)

A slide-in panel on the right half of the viewport. Clicking the map opens it on
the clicked location and shows a **live Google panorama** —
`google.maps.StreetViewPanorama` from the Maps JavaScript API, not a photo.

That one object is why the panel does what it does: the chevron arrows along the
road are `linksControl`, walking to the next scene by clicking the road is
`clickToGo`, and dragging to look around and the keyboard arrows come free once
the panorama has focus. Earlier revisions faked all of this with a static `<img>`
and a heading slider; both are gone.

**There is no aerial view in this panel any more.** The map underneath has an
aerial basemap, which is the aerial view; a second one inside the panel was a
workaround for having no key, and it made the panel lie about what it was. With
no usable key the panel now says so plainly instead of showing something else.

### What the key needs

The key needs **two** things, and they are separate switches in the Google Cloud
console. Enabling the API on the project is only half of it:

1. The **Maps JavaScript API** and the **Street View Static API** enabled on the
   project (APIs & Services → Enable APIs).
2. Both of them present in the key's own **API restrictions** allow-list
   (Credentials → the key → API restrictions).

Miss the second and the panorama fails with `ApiTargetBlockedMapError` in the
console while the project looks correctly configured. Note the metadata endpoint
travels with the *Static* API, not the JS one.

Billing changes with this branch: the panel used to bill **Static Street View**
(per image) and now bills **Dynamic Street View** (per panorama load), which is
a Pro-tier SKU. The metadata endpoint remains free and consumes no quota.

Referrer restrictions need two entries per host — the bare origin and `/*`:
`http://127.0.0.1:8766` and `http://127.0.0.1:8766/*` for the local demo,
`https://rtgs-lab.github.io` and `https://rtgs-lab.github.io/*` for Pages.

The key resolution order (localStorage → `config.js` → ask in the panel) is
unchanged; see below. One new constraint: **the Maps JS API bootstraps once per
page load and keeps the key it was given.** A key changed after the API has
loaded cannot be swapped in underneath it, so the panel says "reload the page to
use it" rather than failing silently.

### The imagery date

`StreetViewPanoramaData.imageDate`, rendered centred at the bottom of the
picture ("Imagery: October 2023") and refreshed on every `pano_changed`. It is
not a property of the panorama object, so it comes from a `StreetViewService`
lookup of the pano id currently on screen.

Google documents the format as `YYYY-MM` but warns that granularity varies, so
it is parsed defensively: a bare `YYYY` renders as the year rather than being
forced into a wrong month, and **no date means no badge** — never a placeholder.

### The dates row ("Other dates")

**No supported Google API lists a location's other capture dates.**
`StreetViewPanoramaData` carries one `imageDate`, and its `links` are the
adjacent panoramas of the same survey, not earlier ones. "See more dates" is a
Google Maps end-user feature with no developer equivalent.

There is an **undocumented `time` array** on `StreetViewPanoramaData` that does
carry the history — verified live returning 11 dates from 2007 to 2023 for
downtown Minneapolis. The panel uses it, but treats it as weather: the id and
date keys inside each entry are minified symbols that Google renames between
releases, so `svOtherDates()` *searches* each entry for something pano-shaped
and something date-shaped rather than reading fixed key names, and renders
nothing if it finds neither. When the array is absent the row says "not
published by the Maps API" and hands the current pano to Google Maps via a
documented Maps URL (`map_action=pano&pano=<id>`), which is the one place the
feature genuinely exists.

Do not build anything load-bearing on `time`. It can empty out with no
deprecation notice.

### The map ↔ panorama link

While the panel is open the map carries a **pulsing dot** at the camera position
and a **wedge** showing which way it is facing, and it recentres to follow as the
user walks down the road. Both appear when the panel opens and go when it closes.

The dot is an HTML element in `view.container`, positioned from `view.toScreen()`
— ArcGIS symbols cannot animate, and a CSS keyframe pulse is the plainest way to
get one. It carries `pointer-events: none` so it does not swallow map clicks. The
wedge stays a `Graphic` because it is a real geographic shape that should scale
with the zoom.

Four things here are easy to get wrong, and all four were:

- **`view.toScreen()` does not autocast.** `Graphic` happily accepts a
  `{type:"point", …}` literal; `toScreen()` throws
  `mapview:projection-not-possible` on one. Pass a real `esri/geometry/Point`.
- **The view declines to project while it is still settling**, which is exactly
  when the dot is first placed. A refusal is retried on the next frame.
- **A plain map click emits drag `start` and `end` with no `update`.** Treating
  `start` as user interaction made every first click skip its own recentre. Only
  a drag that actually moves counts, and the flag has a watchdog so a `start`
  whose `end` never arrives cannot disable recentring for the session.
- **The panel takes 0.3s to slide in.** Measuring how much map it covers
  mid-slide gives the wrong answer, and that recentre then races the corrected
  one. Wait for `transitionend`, and allow only one `goTo` in flight.

The recentre aims at the middle of the *visible* map, not the container centre,
because the panel covers the right half — and it stands down while the user is
dragging or wheeling. Zoom is never changed; recentring alone always brings an
off-screen dot into view.

### Error states

`window.gm_authFailure` is the Maps JS API's only authentication signal. It tells
you *that* the key was refused and nothing about why — the reason is console-only
(`ApiTargetBlockedMapError`, `RefererNotAllowedMapError`, …). `StreetViewStatus`
has no auth value at all, so both paths need handling:

| What happened | What the panel shows |
|---|---|
| `StreetViewStatus.OK` | the panorama, with its date badge |
| `ZERO_RESULTS` | "No Street View imagery available near this location." |
| other `StreetViewStatus` | "Street View could not be loaded (Google returned …)." |
| `gm_authFailure` | "Google rejected this API key for Street View…" plus a **Change key** link |
| the JS API script fails to load | "Could not load the Google Maps JavaScript API…" plus **Change key** |
| no key at all | "Street View needs a Google Maps API key." and the key form, once |

On an auth failure the panel additionally probes the free Static metadata
endpoint for Google's own sentence, which for a referrer-restricted key names the
referer it actually saw. It is best-effort and clearly attributed, because that
endpoint reports on the *Static* API and can therefore be healthy while the JS
API is blocked — which is precisely the `ApiTargetBlockedMapError` case.

A `svPanoToken` counter discards a slow lookup whose click has been superseded.

### One state at a time

The stage has four mutually exclusive states — `placeholder`, `checking`,
`message`, `pano` — tracked in `svStageState`. The date badge and the dates row
belong to the picture and render only over `pano`. Without that guard a
`StreetViewService` callback still in flight when an error lands paints the date
and the chips on top of the error message.

### The API key

The key can be typed into the panel — no `config.js`, no redeploy — which is
the same deal the Parcel Report makes for its Anthropic key. Resolution order,
first hit wins:

1. **localStorage**, under `nrpc-street-view.apiKey` — what the user typed into
   the panel on this browser. Never committed, never logged, sent only to
   `maps.googleapis.com`.
2. **`window.STREET_VIEW_API_KEY`** from `js/config.js`, which is
   **git-ignored**. `.github/workflows/deploy.yml` writes it from the repository
   secret `GOOGLE_STREET_VIEW_API_KEY` before uploading the Pages artifact;
   locally, `cp js/config.example.js js/config.js` and paste a key.
3. **Ask** — on the first Street View request of the session with no key, the
   panel opens an in-page key form. Declining ("Not now") is remembered for the
   session; it does not ask again.

The footer carries the control: `Add key` / `Change key`, and `Clear key` when
the key came from localStorage. Clearing a typed key falls back to `config.js`
rather than to nothing, which is why `Clear key` is hidden when the key is the
deploy-time one — there is nothing in this browser to clear.

The key entry is an in-page `<input>`, never `window.prompt` — a blocking
dialog freezes anything driving the page.

Any key is served to every visitor of a public site, so it **must** be
HTTP-referrer-restricted. There is no way to hide it — the restriction is the
control.

Never reference `STREET_VIEW_API_KEY` directly; use the `svKey` variable, which
is `null` when no usable key is present, and re-resolve through `svResolveKey()`
after any change.

### Interaction with other panels

`#street-view-panel` is `position: fixed` at `z-index: 150` over the right half
of the window. The Contribute (Editor) panel is added at `top-right` through
`view.ui`, so an open Street View panel covers it. Close one before using the
other.

// Parcel Prioritization Model v1.0: legend, one model layer, and a labelled Water layer.
//
// Everything here is applied in the browser after the web map loads; the web map item
// (d664f1d163544d25bb92921e5c4bf214) is not changed. Layers are matched by service URL + layer id,
// with the title as a fallback, so the overrides survive edits to the web map.
//
// Decisions (Bryan, 2026-11-11): classes high to low; labels factually correct, words kept but
// clarified; rectangle swatches in one continuous column; clearer class separation; one header,
// "Parcel Prioritization Model v1.0"; a Water layer with good labels; one way to switch views.
//
// Exposes window.NRPCModelV1.apply(view, deps) -> {model, water}; main.js calls it before it builds
// the Legend and LayerList widgets (water names and rivers arrive later, on water.ready).

window.NRPCModelV1 = (() => {
  const MODEL_TITLE = "Parcel Prioritization Model v1.0";

  // Model sublayers in the web map. Both hold the same 445,517 parcels (Rank 1 = highest).
  const MODEL_COUNTY = { service: "Hennepin_Suitability_Model_Results_PublicView", id: 96 };
  const MODEL_PARCEL = { service: "Hennepin_Suitability_Model_Results_parcel_detail", id: 97 };
  const WATER_BASINS = { service: "HennepinCounty_PublicWaterBasins_Clipped", id: 99 };
  // Hennepin County GIS, Natural Resources map service, "Rivers, Streams, Ditches" (lines).
  const RIVERS_URL = "https://gis.hennepin.us/arcgis/rest/services/Maps/NATURALRESOURCES/MapServer/55";

  // The seven classes, top first. Breaks are the web map's own (Rank <= max); only the labels and
  // colours change. Colours: navy-teal to pale yellow, larger lightness steps at the top
  // (CIELAB L* 24, 43, 58, 73, 85, 95, 98); see the task notes for the colour-difference check.
  const CLASSES = [
    { max: 4455,   label: "Extremely high -- top 1%",          color: "#0B3D5C" },
    { max: 22276,  label: "Very high -- top 1 to 5%",          color: "#13706F" },
    { max: 44552,  label: "High -- top 5 to 10%",              color: "#2E9C6A" },
    { max: 111379, label: "Moderately high -- top 10 to 25%",  color: "#7CC46A" },
    { max: 222758, label: "Moderate -- top 25 to 50%",         color: "#C2E08A" },
    { max: 334138, label: "Low -- top 50 to 75%",              color: "#EEF4C6" },
    { max: 445517, label: "Very low -- bottom 25%",            color: "#FAFBF2" },
  ];

  // Scale rule, on the model-explorer precedent (Bryan, 2026-11-10): parcels drawn at every scale
  // (there is no grid-cell layer in this web map); parcel outlines from the zoom where a 100 px
  // scale bar reads 1000 ft. Explorer: MapLibre zoom 13.15 = ArcGIS zoom 14.15 = 1:32,546.
  const OUTLINE_SCALE = 32546;
  const MODEL_MIN_SCALE = 1123071;   // web map's county-view limit, kept

  const WATER_FILL = [181, 211, 234, 1];        // #B5D3EA, light and cool against the ramp
  const WATER_EDGE = [95, 146, 189, 0.9];       // #5F92BD
  const WATER_TEXT = "#1D5A8E";

  const matches = (layer, ref) =>
    layer && layer.type === "feature" && layer.layerId === ref.id &&
    typeof layer.url === "string" && layer.url.includes(`/${ref.service}/FeatureServer`);

  function findLayer(map, ref, titleTest) {
    return map.allLayers.find(l => matches(l, ref)) ||
           map.allLayers.find(l => l.type === "feature" && titleTest(l.title || ""));
  }

  function modelRenderer() {
    const outline = { color: [40, 40, 40, 0.35], width: 0.4 };
    let min = 0.5;
    const infos = CLASSES.map(c => {
      const info = { minValue: min, maxValue: c.max + 0.5, label: c.label,
                     symbol: { type: "simple-fill", color: c.color, outline } };
      min = c.max + 0.5;
      return info;
    });
    return {
      type: "class-breaks",
      field: "Rank",
      legendOptions: { title: MODEL_TITLE },
      classBreakInfos: infos,
      // outline width by scale: none above 1:33,000, 0.4 px from 1:32,546 in
      visualVariables: [{
        type: "size", target: "outline", valueExpression: "$view.scale",
        stops: [{ value: OUTLINE_SCALE, size: 0.4 }, { value: OUTLINE_SCALE * 1.02, size: 0 }],
      }],
    };
  }

  // ── Model: one layer, one row, one legend ────────────────────────────────────────────────
  function applyModel(map, keepRef) {
    const county = findLayer(map, MODEL_COUNTY, t => /County Wide View/i.test(t));
    const parcel = findLayer(map, MODEL_PARCEL, t => /Parcel View/i.test(t));
    const keep = keepRef === MODEL_COUNTY ? county || parcel : parcel || county;
    if (!keep) { console.warn("model-v1: model layer not found"); return null; }
    const drop = keep === county ? parcel : county;
    if (drop && drop.parent && drop.parent.remove) drop.parent.remove(drop);

    keep.title = MODEL_TITLE;
    keep.minScale = MODEL_MIN_SCALE;
    keep.maxScale = 0;
    keep.renderer = modelRenderer();
    keep.legendEnabled = false;       // drawn by the custom legend below
    const group = keep.parent && keep.parent.type === "group" ? keep.parent : null;
    if (group) {
      group.title = MODEL_TITLE;
      group.listMode = "hide-children";
    }
    return { layer: keep, group };
  }

  // A point inside the polygon for a label: the centroid if it falls inside, else the midpoint of
  // the longest horizontal chord through the centroid's latitude.
  function interiorPoint(poly, geometryEngine, Polyline) {
    const c = poly.centroid;
    if (c && geometryEngine.contains(poly, c)) return c;
    const e = poly.extent;
    const y = c ? c.y : (e.ymin + e.ymax) / 2;
    const line = new Polyline({ paths: [[[e.xmin - 1, y], [e.xmax + 1, y]]],
                                spatialReference: poly.spatialReference });
    const cut = geometryEngine.intersect(line, poly);
    if (!cut || !cut.paths || !cut.paths.length) return poly.extent.center;
    let best = null, bestLen = -1;
    cut.paths.forEach(p => {
      const a = p[0], b = p[p.length - 1], len = Math.abs(b[0] - a[0]);
      if (len > bestLen) { bestLen = len; best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    });
    return { type: "point", x: best[0], y: best[1], spatialReference: poly.spatialReference };
  }

  const isName = s => typeof s === "string" && /[A-Za-z]/.test(s) && !/^\s*unnamed\s*$/i.test(s);
  // "Pool 1" / "Pool 2" are the GNIS names of the Mississippi lock-and-dam pools; the river's own
  // label already names that water, so the pool numbers are left off.
  const isLakeName = s => isName(s) && !/^\s*Pool\s+\d+\s*$/i.test(s);

  function waterLabelClasses() {
    const font = (size, weight = "normal") =>
      ({ family: "Noto Serif", style: "italic", weight, size });
    const cls = (where, size, minScale, weight) => ({
      labelExpressionInfo: { expression: "$feature.name" },
      labelPlacement: "center-center",
      where,
      minScale,
      maxScale: 0,
      deconflictionStrategy: "static",
      symbol: { type: "text", color: WATER_TEXT, haloColor: [255, 255, 255, 0.95], haloSize: 1.2,
                font: font(size, weight) },
    });
    // sized by area, coming in as the view zooms (acres = whole lake, sub-basins summed)
    return [
      cls("kind = 'lake' AND acres >= 1000", 10.5, 600000, "bold"),
      cls("kind = 'lake' AND acres >= 250 AND acres < 1000", 10, 300000),
      cls("kind = 'lake' AND acres >= 60 AND acres < 250", 9, 150000),
      cls("kind = 'lake' AND acres >= 15 AND acres < 60", 8.5, 72000),
      cls("kind = 'lake' AND acres < 15", 8, 36000),
      cls("kind = 'bay'", 8.5, 40000),
    ];
  }

  // ── Water: basins (fill) + names (one label per lake) + named rivers and creeks ───────────
  function applyWater(view, deps, modelGroup) {
    const { FeatureLayer, GroupLayer } = deps;
    const map = view.map;
    const source = findLayer(map, WATER_BASINS, t => /Public Water Basins/i.test(t));
    if (!source) { console.warn("model-v1: Public Water Basins not found"); return null; }

    const fill = new FeatureLayer({
      url: source.url, layerId: source.layerId,
      title: "Water",
      outFields: ["gnis_name", "pw_basin_n", "acres"],
      popupEnabled: false,
      labelsVisible: false,
      legendEnabled: false,           // drawn by the custom legend
      listMode: "hide",
      renderer: { type: "simple",
                  symbol: { type: "simple-fill", color: WATER_FILL,
                            outline: { color: WATER_EDGE, width: 0.5 } } },
    });
    const group = new GroupLayer({ title: "Water", visible: true, listMode: "hide-children",
                                   layers: [fill] });
    group.nrpcWater = true;
    // In the "Public Data - Natural Systems" group, on at load (Bryan, 2026-11-12: "add the water
    // to the Public Data - Natural Systems set of layers, but start with it on still"). That group
    // draws above the model group, so lakes still draw over the model fill. Its other layers stay
    // off: they are off in the web map, and the LayerList's "turn on all children" watcher is not
    // registered yet when this runs. Fallback: directly above the model group, as before.
    const natsys = map.layers.find(l => l.type === "group" && /Public Data\s*-\s*Natural Systems/i.test(l.title || ""));
    if (natsys) {
      natsys.add(group, natsys.layers.length);          // top of the group
      natsys.visible = true;
    } else {
      const idx = modelGroup ? map.layers.indexOf(modelGroup) : -1;
      map.layers.add(group, idx >= 0 ? idx + 1 : map.layers.length);
    }
    const water = { group, fill, natsys, names: null, rivers: null };
    water.ready = buildWaterNames(view, deps, source, group, water);
    return water;
  }

  async function buildWaterNames(view, deps, source, group, water) {
    const { FeatureLayer, geometryEngine, Polyline } = deps;

    // One label per lake: group basins by GNIS name + the 6-digit Division of Waters (DOW) lake
    // number, so the nine "Lake Minnetonka" sub-basins get one label and two different lakes that
    // share a name each keep theirs. The label sits in the group's largest basin. Minnetonka bays
    // (sub-basin names "Minnetonka-<X> Bay|Arm") get their own small labels when zoomed in.
    await source.load();
    const q = source.createQuery();
    q.where = "1=1";
    q.outFields = ["gnis_name", "pw_sub_nam", "sub_flag", "dowlknum", "acres"];
    q.returnGeometry = true;
    q.outSpatialReference = view.spatialReference;
    const feats = [];
    for (let start = 0; ; start += 2000) {
      q.start = start; q.num = 2000;
      const r = await source.queryFeatures(q);
      feats.push(...r.features);
      if (!r.exceededTransferLimit || !r.features.length) break;
    }
    const groups = new Map();
    const bays = [];
    feats.forEach(f => {
      const a = f.attributes, name = (a.gnis_name || "").trim();
      const sub = (a.pw_sub_nam || "").trim();
      const bay = /^Minnetonka-(.+\b(Bay|Arm))$/.exec(sub);
      // a bay label only where the sub-basin has no GNIS name of its own beyond "Lake Minnetonka"
      // (e.g. St. Albans Bay is already labelled by its GNIS name "Saint Albans Bay")
      if (bay && f.geometry && (!isName(name) || name === "Lake Minnetonka"))
        bays.push({ name: bay[1], acres: a.acres, geometry: f.geometry });
      if (!isLakeName(name) || !f.geometry) return;
      const key = `${name}|${String(a.dowlknum || "").slice(0, 6)}`;
      const g = groups.get(key) || { name, acres: 0, best: null };
      g.acres += a.acres || 0;
      if (!g.best || (a.acres || 0) > (g.best.attributes.acres || 0)) g.best = f;
      groups.set(key, g);
    });
    let oid = 1;
    const labelGraphics = [];
    groups.forEach(g => labelGraphics.push({
      geometry: interiorPoint(g.best.geometry, geometryEngine, Polyline),
      attributes: { oid: oid++, name: g.name, kind: "lake", acres: Math.round(g.acres) },
    }));
    bays.forEach(b => labelGraphics.push({
      geometry: interiorPoint(b.geometry, geometryEngine, Polyline),
      attributes: { oid: oid++, name: b.name, kind: "bay", acres: Math.round(b.acres) },
    }));
    const names = new FeatureLayer({
      title: "Water names",
      source: labelGraphics,
      objectIdField: "oid",
      fields: [{ name: "oid", type: "oid" }, { name: "name", type: "string" },
               { name: "kind", type: "string" }, { name: "acres", type: "integer" }],
      geometryType: "point",
      spatialReference: view.spatialReference,
      renderer: { type: "simple", symbol: { type: "simple-marker", size: 0,
                  color: [0, 0, 0, 0], outline: null } },
      labelingInfo: waterLabelClasses(),
      popupEnabled: false, legendEnabled: false, listMode: "hide",
    });
    names.nrpcHelper = true;

    // Named rivers and creeks, one feature per name (the Mississippi has both a PWI line and a
    // river centreline in the source; merging by name stops the double label).
    let rivers = null;
    try {
      const src = new FeatureLayer({ url: RIVERS_URL });
      await src.load();
      const rq = src.createQuery();
      // named rivers and creeks; the flow connectors drawn through lakes are left out
      rq.where = "(KITTLE_NAME LIKE '%River%' OR KITTLE_NAME LIKE '%Creek%') AND " +
                 "Strm_type_desc NOT LIKE '%Connector%'";
      rq.outFields = ["KITTLE_NAME"];
      rq.returnGeometry = true;
      rq.outSpatialReference = view.spatialReference;
      rq.maxAllowableOffset = 5;
      const rr = await src.queryFeatures(rq);
      const byName = new Map();
      rr.features.forEach(f => {
        const n = (f.attributes.KITTLE_NAME || "").trim();
        if (!isName(n) || !f.geometry) return;
        (byName.get(n) || byName.set(n, []).get(n)).push(f.geometry);
      });
      let rid = 1;
      const graphics = [];
      byName.forEach((geoms, n) => graphics.push({
        geometry: geoms.length > 1 ? geometryEngine.union(geoms) : geoms[0],
        attributes: { oid: rid++, name: n, kind: /River/.test(n) ? "river" : "creek" },
      }));
      const lineText = (size) => ({ type: "text", color: WATER_TEXT, haloColor: [255, 255, 255, 0.95],
        haloSize: 1.2, font: { family: "Noto Serif", style: "italic", size } });
      rivers = new FeatureLayer({
        title: "Rivers and creeks",
        source: graphics,
        objectIdField: "oid",
        fields: [{ name: "oid", type: "oid" }, { name: "name", type: "string" },
                 { name: "kind", type: "string" }],
        geometryType: "polyline",
        spatialReference: view.spatialReference,
        renderer: { type: "unique-value", field: "kind",
          defaultSymbol: { type: "simple-line", color: WATER_EDGE, width: 0.75 },
          uniqueValueInfos: [
            { value: "river", symbol: { type: "simple-line", color: WATER_EDGE, width: 1.5 } },
            { value: "creek", symbol: { type: "simple-line", color: [95, 146, 189, 0.75], width: 0.8 } },
          ] },
        labelingInfo: [
          { where: "kind = 'river'", labelExpressionInfo: { expression: "$feature.name" },
            labelPlacement: "center-along", repeatLabel: true, repeatLabelDistance: 500,
            minScale: 600000, maxScale: 0, symbol: lineText(10) },
          { where: "kind = 'creek'", labelExpressionInfo: { expression: "$feature.name" },
            labelPlacement: "center-along", repeatLabel: true, repeatLabelDistance: 400,
            minScale: 72000, maxScale: 0, symbol: lineText(8.5) },
        ],
        popupEnabled: false, legendEnabled: false, listMode: "hide",
      });
      rivers.nrpcHelper = true;
    } catch (err) {
      console.warn("model-v1: rivers not loaded --", err && err.message);
    }

    // river lines under the lake fill (a creek's line through a lake is hidden; its name still shows)
    if (rivers) group.add(rivers, 0);
    group.add(names);
    water.names = names; water.rivers = rivers;
    return water;
  }

  // ── Legend block: one header, seven rectangles high to low, one Water row ──────────────────
  function buildLegend(container, view, model, water) {
    const box = document.createElement("div");
    box.id = "model-legend";
    const head = document.createElement("div");
    head.className = "ml-title";
    head.textContent = MODEL_TITLE;
    const ramp = document.createElement("div");
    ramp.className = "ml-ramp";
    CLASSES.forEach(c => {
      const row = document.createElement("div");
      row.className = "ml-row";
      row.innerHTML = `<span class="ml-swatch" style="background:${c.color}"></span>` +
                      `<span class="ml-label"></span>`;
      row.querySelector(".ml-label").textContent = c.label;
      ramp.appendChild(row);
    });
    const note = document.createElement("div");
    note.className = "ml-note";
    const waterRow = document.createElement("div");
    waterRow.className = "ml-row ml-water";
    waterRow.innerHTML = `<span class="ml-swatch" style="background:rgb(${WATER_FILL.slice(0, 3)});` +
      `border-color:rgb(${WATER_EDGE.slice(0, 3)})"></span><span class="ml-label">Water</span>`;
    const modelBlock = document.createElement("div");
    modelBlock.append(head, ramp, note);
    // one status line: "Zoom in to see parcels" beyond the model's scale; "Drawing parcels..."
    // while the model layer draws (UI review findings 18, 19)
    const status = document.createElement("div");
    status.className = "ml-status";
    status.setAttribute("role", "status");
    box.append(status, modelBlock, waterRow);
    container.prepend(box);

    const on = l => { let p = l; while (p && p !== view.map) { if (!p.visible) return false; p = p.parent; } return true; };
    let drawing = false;
    function refresh() {
      const s = view.scale;
      const layerOn = model && on(model.layer);
      const modelOn = layerOn && s <= MODEL_MIN_SCALE;
      modelBlock.style.display = modelOn ? "" : "none";
      note.textContent = s <= OUTLINE_SCALE ? "" : "Parcel outlines appear when zoomed in.";
      note.style.display = note.textContent ? "" : "none";
      status.textContent = layerOn && s > MODEL_MIN_SCALE ? `${MODEL_TITLE}: zoom in to see parcels.`
        : modelOn && drawing ? "Drawing parcels..." : "";
      status.style.display = status.textContent ? "" : "none";
      waterRow.style.display = water && on(water.fill) ? "" : "none";
      box.style.display = modelBlock.style.display === "none" && waterRow.style.display === "none"
        && status.style.display === "none" ? "none" : "";
    }
    if (model && model.layer) view.whenLayerView(model.layer).then(lv => {
      lv.watch("updating", u => { drawing = u; refresh(); });
      drawing = lv.updating; refresh();
    }).catch(() => {});
    view.watch("stationary", refresh);
    [model && model.layer, model && model.group, water && water.group, water && water.fill,
     water && water.natsys]
      .filter(Boolean).forEach(l => l.watch("visible", refresh));
    refresh();
    return { refresh };
  }

  // The basemap's own water names (grey, upright) duplicate ours; hide them while Water is on.
  // Island names stay. Applies to whichever basemap is current (Esri vector tile reference layers).
  const BASEMAP_WATER_LABEL = /^(Water line\/label|Water area.*\/label\/(?!.*island)|Marine)/i;
  function syncBasemapWaterLabels(view, water) {
    const apply = async () => {
      const on = water.group.visible;
      const bm = view.map.basemap;
      if (!bm) return;
      for (const l of [...bm.baseLayers.toArray(), ...bm.referenceLayers.toArray()]) {
        if (l.type !== "vector-tile") continue;
        try {
          await l.load();
          const style = l.currentStyleInfo && l.currentStyleInfo.style;
          (style ? style.layers : []).forEach(sl => {
            if (BASEMAP_WATER_LABEL.test(sl.id)) l.setStyleLayerVisibility(sl.id, on ? "none" : "visible");
          });
        } catch (err) { /* basemap without a style: nothing to hide */ }
      }
    };
    water.group.watch("visible", apply);
    view.watch("map.basemap", apply);
    apply();
  }

  function apply(view, deps, opts = {}) {
    // Keep the county-view service (96) for every scale: it holds the same parcels and drew the
    // whole county in 16 s cold against 173 s for the parcel-detail service (97), headless
    // Chromium, 2026-11-11 (task notes). ?model=97 keeps the other one for comparison.
    const keep = new URLSearchParams(location.search).get("model") === "97" || opts.keep === "parcel"
      ? MODEL_PARCEL : MODEL_COUNTY;
    const model = applyModel(view.map, keep);
    const water = applyWater(view, deps, model && model.group);
    if (water) syncBasemapWaterLabels(view, water);
    if (water) water.ready = water.ready.catch(err => {
      console.warn("model-v1: water names failed --", err && err.message); return water;
    });
    return { model, water };
  }

  return { apply, buildLegend, CLASSES, MODEL_TITLE, OUTLINE_SCALE };
})();

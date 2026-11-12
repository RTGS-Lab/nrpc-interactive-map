// Metropolitan Council layers for one parcel: which of the six layers in the web map's
// "Metropolitan Council Data" group the parcel falls in, the layer's category value there, and the
// share of the parcel area. Shared by the Parcel card (a checklist) and the export (a table), so
// the two always say the same thing; results are cached per PID, so an export after the card
// does not query again.
//
// Asks (Bryan, 2026-11-12): "also include a summary of the METC layers" (export); "Also add those
// METC checkboxes in the parcel report that shows in the app".
//
// Read-only spatial queries with the parcel polygon against the layers' own services, in
// parallel. Share of parcel area from the returned geometries (planar Web Mercator: the distortion
// is the same for parcel and overlap, so the share holds). The services are the map's hosted
// copies of Metropolitan Council data, so sources print as plain text (no link: they are not the
// full source layer). The reference export (branch multi-parcel @891c06a, parcel-report.js
// CONTEXT_LAYERS / fetchContext) queried four of these layers with the same URLs and fields.
//
// Exposes window.NRPCMetc: { LAYERS, summary(pid, geometry) -> Promise<rows>, cached(pid),
// valueText(row), sourceText(row) }.

window.NRPCMetc = (() => {
  "use strict";
  const BASE = "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/";
  const LAYERS = [
    { label: "Protection Opportunities", url: BASE + "Met_Council_Data_Protection_Opportunities/FeatureServer/103", field: "source" },
    { label: "Improvement Opportunities", url: BASE + "Met_Council_Data_Improvement_Opportunities/FeatureServer/104", field: "source" },
    { label: "Existing Natural Systems -- Aquatic", url: BASE + "Met_Council_Data_Existing_Natural_Systems/FeatureServer/105", field: "system", where: "system = 'Aquatic'" },
    { label: "Existing Natural Systems -- Terrestrial", url: BASE + "Met_Council_Data_Existing_Natural_Systems/FeatureServer/105", field: "system", where: "system = 'Terrestrial'" },
    { label: "Ecologically Sensitive Areas", url: BASE + "Met_Council_Data_Ecologically_Sensitive_Areas/FeatureServer/108", field: "source" },
    { label: "Ecologically Significant Areas", url: BASE + "Met_Council_Data_Ecologically_Significant_Areas/FeatureServer/106", field: "source" },
  ];
  const cache = new Map();          // pid -> Promise<rows>
  const done = new Map();           // pid -> rows
  let mods = null;
  const clean = v => (v == null ? "" : String(v).trim());

  function modules() {
    if (mods) return Promise.resolve(mods);
    return new Promise((resolve, reject) => require(["esri/geometry/geometryEngine", "esri/geometry/Polygon"],
      (geometryEngine, Polygon) => { mods = { geometryEngine, Polygon }; resolve(mods); }, reject));
  }

  async function query(parcelGeom) {
    const m = await modules();
    const g = parcelGeom.toJSON ? parcelGeom.toJSON() : parcelGeom;
    const wkid = (g.spatialReference && (g.spatialReference.latestWkid || g.spatialReference.wkid)) || 3857;
    const area = Math.abs(m.geometryEngine.planarArea(parcelGeom, "square-meters")) || 0;
    const body = l => new URLSearchParams({ where: l.where || "1=1", geometry: JSON.stringify(g),
      geometryType: "esriGeometryPolygon", inSR: String(wkid), spatialRel: "esriSpatialRelIntersects",
      outFields: `${l.field},CTU_NAME`, returnGeometry: "true", outSR: String(wkid), f: "json" });
    return Promise.all(LAYERS.map(async l => {
      try {
        const [q, info] = await Promise.all([
          fetch(l.url + "/query", { method: "POST", body: body(l) }).then(r => r.json()),
          fetch(l.url + "?f=json").then(r => r.json()).catch(() => ({})),
        ]);
        if (q.error) throw new Error(q.error.message);
        const feats = q.features || [];
        let overlap = 0;
        feats.forEach(ft => {
          try {
            const poly = new m.Polygon({ ...ft.geometry, spatialReference: g.spatialReference });
            const x = m.geometryEngine.intersect(poly, parcelGeom);
            if (x) overlap += Math.abs(m.geometryEngine.planarArea(x, "square-meters"));
          } catch (e) { /* a geometry that will not intersect cleanly adds nothing */ }
        });
        const values = [...new Set(feats.map(ft => clean(ft.attributes[l.field])).filter(Boolean))];
        const edited = info.editingInfo && info.editingInfo.dataLastEditDate
          ? new Date(info.editingInfo.dataLastEditDate).toISOString().slice(0, 10) : null;
        return { label: l.label, count: feats.length, values, share: area ? Math.min(1, overlap / area) : null, edited, error: null };
      } catch (e) {
        return { label: l.label, count: 0, values: [], share: null, edited: null, error: e.message };
      }
    }));
  }

  function summary(pid, parcelGeom) {
    if (!cache.has(pid)) {
      const p = query(parcelGeom).then(rows => { done.set(pid, rows); return rows; });
      p.catch(() => cache.delete(pid));
      cache.set(pid, p);
    }
    return cache.get(pid);
  }

  // the short value, the same words in the card and the export
  function valueText(r) {
    if (r.error) return "could not check";
    if (!r.count) return "none at this parcel";
    const share = r.share == null ? "" : `; ${r.share >= 0.995 ? "100" : (100 * r.share).toFixed(r.share < 0.01 ? 1 : 0)}% of the parcel area`;
    return `${r.values.join("; ") || "included"}${share}`;
  }
  const sourceText = r => `Source: Metropolitan Council, the map's hosted copy${r.edited ? `, data last edited ${r.edited}` : ""}.`;

  return { LAYERS, summary, cached: pid => done.get(pid) || null, valueText, sourceText };
})();

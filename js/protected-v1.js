// Already-protected parcels: greyed on the map and left out of the model's ranking.
//
// Ask (Bryan, 2026-11-12): "grey out the already protected areas and do the ranking step without
// them included", reusing the NRPC model explorer's rule (Kristine Maurer via Bryan, 2026-11-10):
// a parcel is already protected when at least 50% of its area lies in the V2 protected set (2020
// Protected_Areas_ANALYSIS composite + 2026 easement compilation + Three Rivers gap parks + parks
// of natural resource significance). Data: js/protected-v1-data.js and
// data/protected-parcels.geojson, both generated (see the header of protected-v1-data.js).
//
// Everything happens in the browser; the web map and its services are not changed. The model
// layer's published Rank (all 445,517 parcels) stays the field the renderer reads. Removing the
// protected parcels does not change the order of the rest, so the seven classes over the 443,067
// unprotected parcels are exact as Rank thresholds (T below), and a parcel's rank among the
// unprotected is Rank minus the number of protected parcels with a smaller Rank. Both rules were
// checked parcel by parcel against the explorer's re-rank when the data file was built.
//
// Exposes window.NRPCProtected.apply(view, deps, model) and .decorateLegend(legendWrapper, view).

window.NRPCProtected = (() => {
  const D = window.NRPCProtectedV1;
  const LABEL = "Already protected -- not ranked";
  // CIM colours in the JS API are [r, g, b, alpha 0-255]
  const GREY_FILL = [217, 217, 217, 255];  // #D9D9D9, opaque: hides the class colour underneath
  const GREY_LINE = [128, 128, 128, 255];  // #808080: the city mask's grey (branch city-mask)
  const fmt = n => n.toLocaleString("en-US");

  // Classes from model-v1.js (labels and colours kept), breaks moved to the unprotected ranking.
  function classBreakInfos(classes) {
    const outline = { color: [40, 40, 40, 0.35], width: 0.4 };
    let min = 0.5;
    return classes.map((c, i) => {
      const max = D.thresholds_published_rank[i] + 0.5;
      const info = { minValue: min, maxValue: max, label: c.label,
                     symbol: { type: "simple-fill", color: c.color, outline } };
      min = max;
      return info;
    });
  }

  // Grey fill + #808080 diagonal hatch + outline: the explorer's "hatched, not ranked" look in
  // the city mask's grey. Drawn above the model fill so the old class colour does not show.
  function hatchSymbol() {
    return {
      type: "cim",
      data: {
        type: "CIMSymbolReference",
        symbol: {
          type: "CIMPolygonSymbol",
          symbolLayers: [
            { type: "CIMSolidStroke", enable: true, width: 0.6, color: GREY_LINE },
            { type: "CIMHatchFill", enable: true, rotation: 45, separation: 5,
              lineSymbol: { type: "CIMLineSymbol",
                            symbolLayers: [{ type: "CIMSolidStroke", enable: true, width: 0.6,
                                             color: GREY_LINE }] } },
            { type: "CIMSolidFill", enable: true, color: GREY_FILL },
          ],
        },
      },
    };
  }

  // Popup for the model layer: rank among the unprotected parcels, or "already protected".
  function popupTemplate() {
    const status = `
      var pids = ${JSON.stringify(D.pids)};
      var pr = ${JSON.stringify(D.protected_ranks)};
      var r = $feature.Rank;
      if (Includes(pids, $feature.PID)) { return "${LABEL}"; }
      var lo = 0; var hi = Count(pr);
      while (lo < hi) { var mid = Floor((lo + hi) / 2); if (pr[mid] < r) { lo = mid + 1; } else { hi = mid; } }
      return Text(r - lo, "#,###") + " of ${fmt(D.parcels_ranked)} unprotected parcels";`;
    return {
      title: "Parcel {PID}",
      expressionInfos: [{ name: "rank_unprot", title: "Rank among unprotected parcels", expression: status }],
      content: [{
        type: "fields",
        fieldInfos: [
          { fieldName: "expression/rank_unprot", label: "Rank among unprotected parcels" },
          { fieldName: "Rank", label: "Published rank, all parcels (v1.0)",
            format: { digitSeparator: true, places: 0 } },
          { fieldName: "Overall_Va", label: "Overall Value", format: { digitSeparator: false, places: 4 } },
        ],
      }],
    };
  }

  function apply(view, deps, model) {
    if (!D || !model || !model.layer) { console.warn("protected: data or model layer missing"); return null; }
    const { GeoJSONLayer } = deps;
    const layer = model.layer;
    const classes = window.NRPCModelV1.CLASSES;
    const r = layer.renderer.clone();
    r.classBreakInfos = classBreakInfos(classes);
    layer.renderer = r;
    layer.outFields = ["PID", "Rank", "Overall_Va"];
    layer.popupTemplate = popupTemplate();

    const overlay = new GeoJSONLayer({
      url: "data/protected-parcels.geojson",
      title: "Already protected",
      copyright: "Protected set: Hennepin County 2020 composite, 2026 easements, Three Rivers, parks",
      popupEnabled: false,              // the model layer's popup says "already protected"
      legendEnabled: false,             // drawn by the custom legend
      listMode: "hide",
      minScale: layer.minScale, maxScale: 0,
      renderer: { type: "simple", symbol: hatchSymbol() },
    });
    overlay.nrpcHelper = true;          // not offered by Clip & Zip
    if (model.group) model.group.add(overlay);          // top of the model group
    else view.map.add(overlay, view.map.layers.indexOf(layer) + 1);
    return { overlay };
  }

  // Legend: one hatched row under the seven classes, and a line saying what the classes rank.
  function decorateLegend(wrapper) {
    const box = wrapper.querySelector("#model-legend");
    if (!box || !D) return;
    const ramp = box.querySelector(".ml-ramp");
    const row = document.createElement("div");
    row.className = "ml-row ml-protected";
    row.innerHTML = `<span class="ml-swatch"></span><span class="ml-label"></span>`;
    row.querySelector(".ml-label").textContent = LABEL;
    const scope = document.createElement("div");
    scope.className = "ml-note ml-scope";
    scope.textContent = `Classes rank the ${fmt(D.parcels_ranked)} parcels not already protected ` +
      `(${fmt(D.parcels_protected)} protected parcels, ${fmt(Math.round(D.acres_protected))} acres, ` +
      `left out).`;
    ramp.after(row);
    row.after(scope);
  }

  return { apply, decorateLegend, LABEL };
})();

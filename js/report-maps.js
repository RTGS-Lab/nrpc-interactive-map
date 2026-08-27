/**
 * report-maps.js — the maps that go in the exported report.
 *
 * WHY A SECOND VIEW
 * -----------------
 * The obvious way to capture a map is to drive the one on screen: switch the
 * basemap to imagery, zoom to the parcel, `view.takeScreenshot()`, put it back.
 * It works, and it is horrible to watch — four captures means four basemap
 * swaps and four camera flights across the user's map, and any failure leaves
 * the map somewhere they did not put it.
 *
 * So the captures run on a SECOND MapView, off-screen, that shares nothing with
 * the on-screen one except the layer definitions it re-creates. The user's map
 * never moves. This also means the capture extent, size and basemap are exactly
 * what the print layout asks for rather than whatever the window happens to be.
 *
 * WHAT IT DRAWS
 * -------------
 * Three inline figures and three 8.5 x 11 plates, each making one argument:
 *
 *   facts        the parcel outline on aerial imagery — "this is the parcel"
 *   context      parcel + the 250 m ring — "this is what 'within 250 m' means"
 *   opportunity  parcel + adjacent parcels (dashed) + contributions by tier —
 *                the adjacency argument, which is the one a reader disputes
 *   plate        PLATE 1. The parcel in its neighbourhood: parcel, the parcels
 *                touching it, the contributions by tier. NO 250 m ring — Bryan,
 *                27 Aug: "For the final map, remove the 250m buffer." Figure 2
 *                keeps its ring, because explaining the 250 m IS that figure.
 *   eco          PLATE 2. Ecological sensitivity and suitability: the two Met
 *                Council area layers over the Hennepin prioritization model's
 *                own five published class breaks, framed ~500 m around the
 *                parcel.
 *   sites        PLATE 3. The nearest shared opportunities, landscape, with the
 *                five numbered on the map and a legend column carrying the
 *                whole card for each — on this plate the legend IS the data.
 *
 * All three plates are composed by ONE furniture function (composeFurniture),
 * so the title block, scale bar, north arrow, legend, corner coordinates, date
 * and sources cannot drift apart between them.
 *
 * Aerial imagery is Esri's World Imagery, per Bryan ("Basemap should be aerial
 * imagery"). Esri's terms require the attribution line, which is why the
 * furniture always carries a sources block and why the inline maps carry a
 * source line under the caption.
 *
 * EVERYTHING IS BEST-EFFORT
 * -------------------------
 * A capture that fails returns null and the export goes ahead without that
 * figure, saying so in the document. An export that fails because a basemap
 * tile did not load is a worse outcome than an export with three maps.
 */
window.NRPCReportMaps = (function () {
  "use strict";

  // Esri World Imagery. The id ArcGIS knows it by; `satellite` is the alias.
  const AERIAL_BASEMAP = "satellite";

  const ESRI_ATTRIB =
    "Imagery: Esri World Imagery — Esri, Maxar, Earthstar Geographics, and the GIS User Community";
  const DATA_ATTRIB =
    "Parcels: Hennepin County Survey Division · Opportunities: NRPC coalition contributions";

  // Inline figures: 2x the printed width so they stay sharp on paper.
  const INLINE_W = 1600;
  const INLINE_H = 1000;

  // 8.5 x 11 at 300 dpi. Portrait unless the parcel is clearly wider than tall.
  const PLATE_PORTRAIT = { w: 2550, h: 3300 };
  const PLATE_LANDSCAPE = { w: 3300, h: 2550 };

  const SYM = {
    parcel: {
      type: "simple-fill",
      color: [255, 190, 60, 0.18],
      outline: { color: [255, 150, 0, 1], width: 4 },
    },
    adjacent: {
      type: "simple-fill",
      color: [255, 255, 255, 0.06],
      outline: { color: [255, 255, 255, 0.95], width: 1.6, style: "dash" },
    },
    ring: {
      type: "simple-fill",
      color: [80, 190, 255, 0.10],
      outline: { color: [80, 200, 255, 0.95], width: 2.5, style: "short-dash" },
    },
    // One colour per adjacency tier — the legend is keyed to these.
    tier: {
      "on the parcel": [255, 70, 70],
      "on an adjacent parcel": [255, 200, 40],
      nearby: [120, 220, 255],
      // Only present when the report's widen-once pass fired: fewer than five
      // contributions were in the normal scope, so the list reached further
      // out to fill itself. Deliberately the dimmest of the four — it is the
      // furthest thing on the map and the least about this parcel.
      "wider search": [170, 170, 190],
    },
  };

  const TIER_LABEL = {
    "on the parcel": "On the parcel",
    "on an adjacent parcel": "On an adjacent parcel",
    nearby: "Nearby (within 250 m)",
    "wider search": "Found by the wider search",
  };

  // ── Plate 2's two thematic layers ────────────────────────────────────────
  //
  // Both read off the live `?f=json` on 2026-08-27; evidence kept beside this
  // work in context/live-2026-08-27/.
  //
  // THE MET COUNCIL LAYERS DO NOT PUBLISH A CLASS FIELD. The design asked for
  // "its class field, e.g. Outstanding / High / Moderate" — there is none. Each
  // layer's whole schema is OBJECTID, source, CTU_NAME, Shape__Area,
  // Shape__Length, its renderer is a SIMPLE renderer (one symbol, no field),
  // and `returnDistinctValues` on `source` returns exactly one value per layer:
  // "Ecologically Significant Area" (51 features) and "Ecologically Sensitive
  // Area" (60 features). So the classification IS the layer: two layers, two
  // classes, and that is what the legend says. Symbolising by a field that does
  // not exist would have been an invented class.
  const METC_SIGNIFICANT =
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Ecologically_Significant_Areas/FeatureServer/106";
  const METC_SENSITIVE =
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Ecologically_Sensitive_Areas/FeatureServer/108";

  // Hennepin County Parcel Prioritization Model results — the same service
  // js/parcel-report.js reads the seven scores and the rank from, so the fill
  // under the parcel and the number printed beside it are the same layer.
  const MODEL_PARCEL =
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Hennepin_Suitability_Model_Results_parcel_detail/FeatureServer/97";

  // The model's OWN breaks, not ours. The service publishes a classBreaks
  // renderer on `Overall_Va` with these five classes and these five colours
  // (a YlOrRd ramp); copying them means the plate matches what anyone sees in
  // the web map or in ArcGIS Online rather than inventing a quantile that
  // disagrees with both. Read from drawingInfo.renderer.classBreakInfos.
  const MODEL_FIELD = "Overall_Va";
  const MODEL_BREAKS = [
    { max: 10.0705, label: "0.00 – 10.07", rgb: [255, 255, 204] },
    { max: 15.3075, label: "10.07 – 15.31", rgb: [254, 217, 118] },
    { max: 19.8327, label: "15.31 – 19.83", rgb: [253, 141, 60] },
    { max: 33.3379, label: "19.83 – 33.34", rgb: [227, 26, 28] },
    { max: 78.0392, label: "33.34 – 78.04", rgb: [128, 0, 38] },
  ];

  // Ecologically significant / sensitive areas, drawn OVER the model fill.
  // Green and cyan because the model ramp owns yellow through dark red, and
  // two ramps that share a hue cannot be told apart on a printed page.
  const ECO_SYM = {
    significant: {
      rgb: [40, 190, 90],
      label: "Met Council ecologically significant area",
    },
    sensitive: {
      rgb: [60, 210, 220],
      label: "Met Council ecologically sensitive area",
    },
  };

  // Plate 2's frame: this far out from the parcel boundary, all round. Wide
  // enough to read the neighbourhood's pattern of scores, tight enough that
  // the subject parcel is still obviously the subject. The realised ground
  // width is measured per capture and printed in the plate's own furniture.
  const ECO_FRAME_M = 500;

  // Plate 3: a legend row's description is a survey free-text field and can run
  // for paragraphs. Past this it is cut at a word boundary with an ellipsis —
  // the full text is in the report's card, three pages earlier.
  const CARD_DESC_MAX = 220;

  // Plate 3's inset trigger. Framing on a contribution a kilometre out can
  // shrink the subject parcel to a smudge; below this share of the map window's
  // width the parcel gets its own inset box and the furniture says so.
  const INSET_TRIGGER = 0.10;

  let modules = null;
  let hiddenView = null;
  let hiddenContainer = null;

  function loadModules() {
    if (modules) return Promise.resolve(modules);
    return new Promise((resolve, reject) => {
      if (typeof require !== "function") return reject(new Error("ArcGIS AMD loader not present"));
      require(
        [
          "esri/Map",
          "esri/views/MapView",
          "esri/layers/GraphicsLayer",
          "esri/layers/FeatureLayer",
          "esri/Graphic",
          "esri/geometry/Polygon",
          "esri/geometry/geometryEngine",
          "esri/geometry/support/webMercatorUtils",
        ],
        (Map, MapView, GraphicsLayer, FeatureLayer, Graphic, Polygon, geometryEngine, webMercatorUtils) => {
          modules = {
            Map,
            MapView,
            GraphicsLayer,
            FeatureLayer,
            Graphic,
            Polygon,
            geometryEngine,
            webMercatorUtils,
          };
          resolve(modules);
        },
        reject
      );
    });
  }

  /**
   * The off-screen view. Built once and reused; sized per capture.
   *
   * `position: fixed; left: -20000px` rather than `display:none` on purpose —
   * a MapView with no layout box never lays out its canvas, and
   * takeScreenshot() then hands back a blank image. It has to be rendered,
   * just not anywhere the user can see.
   */
  async function ensureView(w, h) {
    const m = await loadModules();
    if (!hiddenView) {
      hiddenContainer = document.createElement("div");
      hiddenContainer.id = "nrpc-report-map-stage";
      hiddenContainer.setAttribute("aria-hidden", "true");
      Object.assign(hiddenContainer.style, {
        position: "fixed",
        left: "-20000px",
        top: "0",
        width: w + "px",
        height: h + "px",
        pointerEvents: "none",
      });
      document.body.appendChild(hiddenContainer);

      hiddenView = new m.MapView({
        container: hiddenContainer,
        map: new m.Map({ basemap: AERIAL_BASEMAP }),
        ui: { components: [] },
        constraints: { snapToZoom: false, rotationEnabled: false },
      });
      await hiddenView.when();
    }
    if (hiddenContainer.style.width !== w + "px" || hiddenContainer.style.height !== h + "px") {
      hiddenContainer.style.width = w + "px";
      hiddenContainer.style.height = h + "px";
      // Let the view pick the new container size up before anything is drawn.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return hiddenView;
  }

  const ring4326 = rings => ({ type: "polygon", rings, spatialReference: { wkid: 4326 } });

  // ── Plate 2's operational layers ─────────────────────────────────────────
  //
  // Drawn by ArcGIS as real FeatureLayers rather than fetched and pushed into a
  // GraphicsLayer by hand. The model layer holds 445,517 parcels: a hand-rolled
  // query would have to page it, and a FeatureLayer already fetches only what
  // the extent needs. Built once and reused across exports.

  // Keyed on the line scale, because the outline widths are baked into the
  // renderer and a plate captured at a different width needs different ones.
  const ecoLayerCache = new Map();

  function alpha(rgb, a) {
    return [rgb[0], rgb[1], rgb[2], a];
  }

  function ecoLayerSet(m, k) {
    const key = k.toFixed(3);
    if (ecoLayerCache.has(key)) return ecoLayerCache.get(key);
    const model = new m.FeatureLayer({
      url: MODEL_PARCEL,
      outFields: [MODEL_FIELD, "PID", "Rank"],
      listMode: "hide",
      renderer: {
        type: "class-breaks",
        field: MODEL_FIELD,
        // Below the first break's minimum the service draws nothing; ours
        // starts at -1 so a legitimate 0.0 parcel is coloured rather than
        // silently dropped out of the picture.
        classBreakInfos: MODEL_BREAKS.map((b, i) => ({
          minValue: i === 0 ? -1 : MODEL_BREAKS[i - 1].max,
          maxValue: b.max,
          symbol: {
            type: "simple-fill",
            // 0.72, not 1: the aerial imagery has to stay legible under the
            // choropleth or the plate stops being a map of a real place.
            color: alpha(b.rgb, 0.72),
            outline: { color: [255, 255, 255, 0.45], width: 0.4 * k },
          },
        })),
      },
    });
    const areaLayer = (url, sym, dashed) =>
      new m.FeatureLayer({
        url,
        outFields: ["source", "CTU_NAME"],
        listMode: "hide",
        renderer: {
          type: "simple",
          symbol: {
            type: "simple-fill",
            color: alpha(sym.rgb, 0.34),
            outline: {
              color: alpha(sym.rgb, 1),
              width: 3.2 * k,
              style: dashed ? "dash" : "solid",
            },
          },
        },
      });
    const set = {
      model,
      significant: areaLayer(METC_SIGNIFICANT, ECO_SYM.significant, false),
      sensitive: areaLayer(METC_SENSITIVE, ECO_SYM.sensitive, true),
    };
    ecoLayerCache.set(key, set);
    return set;
  }

  function geomFromEsriJson(g) {
    if (!g) return null;
    if (g.rings) return { type: "polygon", rings: g.rings, spatialReference: { wkid: 4326 } };
    if (g.paths) return { type: "polyline", paths: g.paths, spatialReference: { wkid: 4326 } };
    if (typeof g.x === "number") return { type: "point", x: g.x, y: g.y, spatialReference: { wkid: 4326 } };
    return null;
  }

  /**
   * ArcGIS symbol widths are in POINTS, so they do not grow with the capture
   * size: the same 3 pt outline is proportionally thinner on a 2330 px plate
   * than on a 1600 px inline figure, and on paper it disappears. Everything
   * that draws a line therefore scales its width by the capture's width
   * relative to the inline figures.
   */
  function scaleWidths(sym, k) {
    const out = JSON.parse(JSON.stringify(sym));
    if (out.outline && out.outline.width) out.outline.width *= k;
    if (out.type === "simple-line" && out.width) out.width *= k;
    if (out.type === "simple-marker") {
      out.size *= k;
      if (out.outline && out.outline.width) out.outline.width *= k;
    }
    return out;
  }

  /** Every vertex of a polygon/polyline/point autocast object, flat. */
  function verticesOf(geom) {
    if (!geom) return [];
    if (geom.type === "point") return [[geom.x, geom.y]];
    const parts = geom.rings || geom.paths || [];
    const out = [];
    parts.forEach(part => part.forEach(v => out.push(v)));
    return out;
  }

  /** The mean of a ring's vertices. Not a true centroid; a target to aim at. */
  function meanPoint(geom) {
    const vs = verticesOf(geom);
    if (!vs.length) return null;
    let sx = 0;
    let sy = 0;
    vs.forEach(v => {
      sx += v[0];
      sy += v[1];
    });
    return { x: sx / vs.length, y: sy / vs.length, spatialReference: { wkid: 4326 } };
  }

  /**
   * Where a number goes for one contributed geometry: the vertex of it nearest
   * the parcel.
   *
   * Two things forced this, both found by looking at the first version's
   * output — where only the one POINT contribution got a number and the
   * polygon and the three polylines got nothing at all:
   *
   *   - `geomFromEsriJson()` returns plain autocast JSON, not an esri geometry
   *     instance, so `.centroid` and `.extent` are undefined on everything but
   *     a point. Anything relying on them silently produced no label. The
   *     arithmetic here needs neither, and works on exactly what is drawn;
   *   - a contributed corridor can be kilometres long. Its centre lands
   *     outside a frame built around the parcel and its neighbours, so the
   *     number would be off the picture even once it existed. The nearest
   *     vertex is by construction the end that is about THIS parcel, and it
   *     is roughly where the row's distance was measured to.
   *
   * Nearest VERTEX, not nearest point on the nearest segment: the difference
   * is metres on geometry that is already only a key into a list, and this
   * needs no projection to get right.
   */
  function labelPoint(geom, toward) {
    if (!geom) return null;
    if (geom.type === "point") return geom;
    const vs = verticesOf(geom);
    if (!vs.length) return null;
    const t = toward || meanPoint(geom);
    if (!t) return null;
    // Latitude-corrected so "nearest" means nearest on the ground, not
    // nearest in degrees, which at 45 N is 1.4× wrong in x.
    const kx = Math.cos((t.y * Math.PI) / 180);
    let best = null;
    let bestD = Infinity;
    vs.forEach(v => {
      const dx = (v[0] - t.x) * kx;
      const dy = v[1] - t.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    });
    return best ? { type: "point", x: best[0], y: best[1], spatialReference: { wkid: 4326 } } : null;
  }

  // Two contributions 5 m and 7 m from the same parcel boundary put their
  // numbers on top of each other — measured on PID 2411921110001, where rows
  // 2 and 3 printed as one illegible blob. Anything whose label lands within
  // this many metres of one already placed is pushed up the screen by a fixed
  // number of points, so a cluster reads as a stack.
  //
  // Metres, not pixels, because the label is placed before the camera's extent
  // is known. The figures frame a parcel and its neighbours — a few hundred
  // metres across 1,600 px — so 20 m is comfortably tens of pixels at the
  // scales this map is ever drawn at.
  const LABEL_CLUSTER_M = 20;
  const LABEL_STACK_PT = 15;

  /** Metres between two 4326 points, flat-earth — a declutter test, not a measurement. */
  function labelGapM(a, b) {
    const mPerDeg = 111320;
    const dx = (a.x - b.x) * mPerDeg * Math.cos((a.y * Math.PI) / 180);
    const dy = (a.y - b.y) * mPerDeg;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function tierSymbol(relation, geometryType) {
    const rgb = SYM.tier[relation] || [200, 200, 200];
    if (geometryType === "polyline") {
      return { type: "simple-line", color: [...rgb, 1], width: 4 };
    }
    if (geometryType === "point") {
      return {
        type: "simple-marker",
        style: "circle",
        size: 13,
        color: [...rgb, 0.95],
        outline: { color: [20, 20, 20, 0.9], width: 1.5 },
      };
    }
    return {
      type: "simple-fill",
      color: [...rgb, 0.35],
      outline: { color: [...rgb, 1], width: 2.5 },
    };
  }

  /**
   * Build the graphics for one map kind and return them plus the extent they
   * should be framed by.
   */
  function buildGraphics(m, facts, kind, lineScale) {
    const k = lineScale || 1;
    const g = [];
    // What the camera is framed on. Deliberately NOT every graphic: a
    // contributed opportunity can be a corridor kilometres long, and framing
    // on its full extent shrank the subject parcel to a sliver in the corner
    // (measured: PID 2902924410044 filled about 4% of the plate). The map is
    // about THIS parcel and its neighbourhood; a contribution that runs off
    // the edge is clipped, which reads correctly — it continues past the frame.
    const frameOn = [];
    const parcel = facts.parcelRings ? ring4326(facts.parcelRings) : null;
    if (!parcel) return null;

    const opps = facts.sharedOpportunities;
    const mg = opps && opps.mapGeometry ? opps.mapGeometry : { adjacentParcels: [], features: [] };

    // A geodesic buffer is the honest 250 m: a planar buffer in Web Mercator
    // at 45 N is short by the cosine of the latitude, ~29% here.
    //
    // Figure 2 ONLY. The plate used to draw it too; Bryan, 27 Aug: "For the
    // final map, remove the 250m buffer." Figure 2 keeps it because that figure
    // exists to show what "within 250 m" covers — take the ring out of it and
    // there is no figure left. The plate's job is the parcel and its
    // neighbours, and the ring was a second, weaker argument on the same sheet.
    let ring = null;
    if (kind === "context") {
      try {
        ring = m.geometryEngine.geodesicBuffer(
          new m.Polygon(parcel),
          facts.contextBufferMetres || 250,
          "meters"
        );
      } catch (e) {
        ring = null;
      }
    }

    if (ring) {
      const gr = new m.Graphic({ geometry: ring, symbol: scaleWidths(SYM.ring, k) });
      g.push(gr);
      frameOn.push(gr);
    }

    // Plate 2 is a thematic map: the model choropleth and the two Met Council
    // area layers carry it, and the only graphic is the subject parcel, drawn
    // heavily enough to find against a five-class ramp. Framed on a geodesic
    // buffer rather than on the parcel plus a margin fraction, so "500 m out
    // all round" means 500 metres on the ground and not a fraction of whatever
    // this parcel's bounding box happens to be.
    if (kind === "eco") {
      let frameBuf = null;
      try {
        frameBuf = m.geometryEngine.geodesicBuffer(new m.Polygon(parcel), ECO_FRAME_M, "meters");
      } catch (e) {
        frameBuf = null;
      }
      // White under, dark blue over: a two-pass casing reads over both ends of
      // a yellow-to-dark-red ramp, which no single colour does.
      g.push(
        new m.Graphic({
          geometry: parcel,
          symbol: scaleWidths(
            { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [255, 255, 255, 1], width: 9 } },
            k
          ),
        })
      );
      const parcelTop = new m.Graphic({
        geometry: parcel,
        symbol: scaleWidths(
          { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [20, 60, 200, 1], width: 4.5 } },
          k
        ),
      });
      g.push(parcelTop);
      frameOn.push(frameBuf ? new m.Graphic({ geometry: frameBuf }) : parcelTop);

      // The parcel's own score and rank, on the parcel, so the sheet does not
      // have to be read against the legend to find out what the subject scores.
      // The percentile and the seven sub-scores are in the furniture; putting
      // all of it here would cover the neighbourhood the plate is about.
      const mod = facts.model;
      if (mod && mod.scores) {
        const overall = mod.scores["Overall Value"];
        const at = meanPoint(parcel);
        if (at && (overall !== null || mod.rank !== null)) {
          const bits = [];
          if (overall !== null && overall !== undefined) bits.push("Score " + overall.toFixed(3));
          if (mod.rank !== null && mod.rank !== undefined)
            bits.push("Rank " + mod.rank.toLocaleString("en-US"));
          g.push(
            new m.Graphic({
              geometry: at,
              symbol: {
                type: "text",
                text: bits.join(" · "),
                color: [10, 10, 10, 1],
                backgroundColor: [255, 255, 255, 0.94],
                borderLineColor: [20, 60, 200, 1],
                borderLineSize: Math.max(1, 1.5 * k),
                haloColor: [255, 255, 255, 0.9],
                haloSize: Math.max(1, 1.5 * k),
                font: { size: Math.round(15 * k), weight: "bold", family: "sans-serif" },
              },
            })
          );
        }
      }
      return { graphics: g, frameOn, parcel, ring: null, frameGeometry: frameBuf };
    }

    if (kind === "opportunity" || kind === "plate" || kind === "sites") {
      (mg.adjacentParcels || []).forEach(p => {
        if (!p.rings) return;
        const gr = new m.Graphic({ geometry: ring4326(p.rings), symbol: scaleWidths(SYM.adjacent, k) });
        g.push(gr);
        frameOn.push(gr);
      });
    }

    // The parcel goes on top of the ring and the neighbours, under the
    // contributions — it is the subject, they are the argument about it.
    const parcelGr = new m.Graphic({ geometry: parcel, symbol: scaleWidths(SYM.parcel, k) });
    g.push(parcelGr);
    frameOn.push(parcelGr);

    if (kind === "opportunity" || kind === "plate" || kind === "sites") {
      // Two passes, because a number drawn under a later polygon's fill is a
      // number nobody can read: every shape first, then every label on top.
      const labelled = [];
      (mg.features || []).forEach(f => {
        const geom = geomFromEsriJson(f.geometry);
        if (!geom) return;
        // Drawn, but not framed on — see frameOn above.
        g.push(new m.Graphic({ geometry: geom, symbol: scaleWidths(tierSymbol(f.relation, geom.type), k) }));
        if (f.nearestRank) labelled.push({ f, geom });
      });
      // The numbered ones ARE framed on — as single points, not as their full
      // extents, which is what keeps the "corridor swallows the frame" problem
      // above from coming back. A number the reader cannot find is worse than
      // a slightly wider picture.
      //
      // Rows the widen-once pass added are excluded: they can be 1,000 m out,
      // and framing on them would shrink the parcel to the sliver this
      // deliberately avoids. Their number may therefore fall off the figure —
      // the caption says so.
      // The five the report lists, numbered 1-5 to match it. Without this the
      // figure and the list are two separate arguments about the same parcel
      // and the reader has to join them on distance.
      const toward = meanPoint(parcel);
      const placed = [];
      labelled
        .sort((a, b) => a.f.nearestRank - b.f.nearestRank)
        .forEach(({ f, geom }) => {
          const at = labelPoint(geom, toward);
          if (!at) return;
          // Stack, rather than overprint, when two land on the same spot.
          const clash = placed.filter(p => labelGapM(p, at) < LABEL_CLUSTER_M).length;
          placed.push({ x: at.x, y: at.y });
          // Plate 3 is ABOUT the five, so it frames on all five including a
          // widened row — Bryan asked for "the nearest 5 other sites", and a
          // sheet whose legend numbers 1-5 while the map shows four of them is
          // a sheet with a hole in it. That is exactly the case the inset rule
          // below exists for: when the widened row drags the frame out far
          // enough to shrink the parcel, the parcel gets its own box.
          if (kind === "sites" || f.relation !== "wider search") {
            frameOn.push(new m.Graphic({ geometry: at }));
          }
          const rgb = SYM.tier[f.relation] || [200, 200, 200];
          g.push(
            new m.Graphic({
              geometry: at,
              symbol: {
                type: "text",
                text: String(f.nearestRank),
                color: [15, 15, 15, 1],
                // A white disc ringed in the tier's own colour: the number has
                // to read over dark water and over its own fill, and the ring
                // is what ties it back to the legend.
                backgroundColor: [255, 255, 255, 0.92],
                borderLineColor: [...rgb, 1],
                borderLineSize: Math.max(1, 1.5 * k),
                haloColor: [255, 255, 255, 0.9],
                haloSize: Math.max(1, 1.5 * k),
                font: { size: Math.round(15 * k), weight: "bold", family: "sans-serif" },
                yoffset: Math.round((clash * LABEL_STACK_PT + 4) * k),
              },
            })
          );
        });
    }

    return { graphics: g, frameOn, parcel, ring };
  }

  /** Union of every graphic's extent, in Web Mercator, with a margin. */
  function frameExtent(m, graphics, marginFraction) {
    let ext = null;
    graphics.forEach(gr => {
      const e = gr.geometry && gr.geometry.extent;
      if (!e) {
        if (gr.geometry && gr.geometry.type === "point") {
          const p = m.webMercatorUtils.geographicToWebMercator(gr.geometry);
          const tiny = { xmin: p.x - 30, xmax: p.x + 30, ymin: p.y - 30, ymax: p.y + 30, spatialReference: p.spatialReference };
          ext = ext ? ext.union(tiny) : tiny;
        }
        return;
      }
      const we = e.spatialReference && e.spatialReference.isWebMercator
        ? e
        : m.webMercatorUtils.geographicToWebMercator(gr.geometry).extent;
      ext = ext ? ext.union(we) : we.clone();
    });
    if (!ext) return null;
    const mf = marginFraction == null ? 0.18 : marginFraction;
    ext.expand(1 + mf * 2);
    return ext;
  }

  /**
   * Capture one map. Returns {dataUrl, width, height, capturedAt,
   * resolutionMPerPx, extent} or null.
   */
  async function capture(facts, kind, opts) {
    const o = opts || {};
    const w = o.width || INLINE_W;
    const h = o.height || INLINE_H;
    const t0 = performance.now();
    try {
      const m = await loadModules();
      const built = buildGraphics(m, facts, kind, w / INLINE_W);
      if (!built) return null;

      const view = await ensureView(w, h);
      const layer = new m.GraphicsLayer({ listMode: "hide" });
      view.map.removeAll();
      // Plate 2's thematic layers go UNDER the graphics layer: the choropleth
      // and the Met Council areas are the map, the parcel casing is the
      // annotation on it, and a heavy blue outline behind a 72%-opaque fill is
      // an outline nobody can see.
      if (kind === "eco") {
        const set = ecoLayerSet(m, w / INLINE_W);
        view.map.addMany([set.model, set.significant, set.sensitive]);
      }
      view.map.add(layer);
      layer.addMany(built.graphics);

      const ext = frameExtent(m, built.frameOn.length ? built.frameOn : built.graphics, o.marginFraction);
      if (!ext) return null;
      await view.goTo(ext, { animate: false });
      await view.when();

      // takeScreenshot() captures what has been drawn, so wait for the tiles.
      await whenStable(view, o.timeoutMs || 12000);
      // A FeatureLayer is not done when the VIEW stops updating: its own
      // layer view fetches and draws on its own schedule, and a plate captured
      // before it finishes is a plate with an empty choropleth on it. Wait for
      // each one's layer view to go quiet, then let whenStable's settle run
      // again over the paint that follows.
      if (kind === "eco") {
        await ecoLayersDrawn(view, o.timeoutMs || 12000);
        await whenStable(view, 6000);
      }

      // JPEG, not PNG: aerial imagery is a photograph, and the four-map PNG
      // export measured 24.2 MB — too big to email. Quality 0.9 at 2x the
      // printed size is visually indistinguishable on paper.
      const shot = await view.takeScreenshot({ width: w, height: h, format: "jpg", quality: 90 });
      const resolution = view.extent.width / view.width; // metres per pixel (Web Mercator)
      // Web Mercator's scale factor is 1/cos(lat); ground metres per pixel is
      // the map unit resolution times cos(lat). Without this a scale bar drawn
      // from view.resolution is ~29% too long at 45 N.
      const latRad = (view.center.latitude * Math.PI) / 180;
      const groundMPerPx = resolution * Math.cos(latRad);

      return {
        kind,
        dataUrl: shot.dataUrl,
        width: w,
        height: h,
        capturedAt: new Date(),
        captureMs: Math.round(performance.now() - t0),
        resolutionMPerPx: groundMPerPx,
        centerLat: view.center.latitude,
        centerLon: view.center.longitude,
        extent4326: extentTo4326(m, view.extent),
      };
    } catch (e) {
      console.warn("[report-maps] capture failed for", kind, e);
      return null;
    }
  }

  function extentTo4326(m, ext) {
    try {
      const g = m.webMercatorUtils.webMercatorToGeographic(ext);
      return { xmin: g.xmin, ymin: g.ymin, xmax: g.xmax, ymax: g.ymax };
    } catch (e) {
      return null;
    }
  }

  // After `updating` goes false there is still an animation to sit through:
  // ArcGIS fades newly added graphics in over roughly a quarter of a second,
  // and `updating` describes the DATA, not the paint.
  //
  // Two requestAnimationFrames used to be the whole wait, and it was enough
  // whenever frames were arriving at 60 Hz. It is not enough when they are
  // not. Caught on 2026-08-27: the sample export's Figure 3 came out of a
  // headless Chrome run as bare aerial imagery with the parcel outline, the
  // contribution shapes and the five numbers all painted at a few per cent
  // opacity — every graphic present, mid-fade, captured. The same code in a
  // normal tab drew them solid.
  //
  // 400 ms of real time, and the frame pair after it. Four captures, so this
  // costs an export about 1.6 s; a figure that argues nothing costs more.
  const SETTLE_MS = 400;

  /**
   * Resolve when every FeatureLayer on the view has finished fetching and
   * drawing, or when the timeout gives up on it.
   *
   * `view.updating` covers the basemap and the view's own work; a
   * FeatureLayer's layer view has an `updating` of its own, and on the model
   * layer — 445,517 parcels, of which a plate frame pulls a couple of
   * thousand — it is the one that takes the time. Best-effort like everything
   * else here: a layer that never settles is captured mid-draw rather than
   * failing the export.
   */
  async function ecoLayersDrawn(view, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const lvs = await Promise.all(
      view.map.layers
        .filter(l => l.type === "feature")
        .toArray()
        .map(l => view.whenLayerView(l).catch(() => null))
    );
    await Promise.all(
      lvs.filter(Boolean).map(
        lv =>
          new Promise(resolve => {
            if (!lv.updating) return resolve();
            const timer = setTimeout(() => {
              if (handle) handle.remove();
              resolve();
            }, Math.max(0, deadline - Date.now()));
            const handle = lv.watch("updating", up => {
              if (up) return;
              clearTimeout(timer);
              handle.remove();
              resolve();
            });
          })
      )
    );
  }

  /** Resolve when the view stops updating AND has had time to paint. */
  function whenStable(view, timeoutMs) {
    return new Promise(resolve => {
      let handle = null;
      const done = () => {
        if (handle) handle.remove();
        handle = null;
        clearTimeout(timer);
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), SETTLE_MS);
      };
      const timer = setTimeout(done, timeoutMs);
      if (!view.updating) return done();
      handle = view.watch("updating", up => {
        if (!up) done();
      });
    });
  }

  // ── The 8.5 x 11 plate ────────────────────────────────────────────────────
  //
  // Furniture is composed onto the captured image with canvas 2D rather than
  // laid out in HTML, so ONE png serves both exports: the PDF gets it as an
  // <img> and the DOCX gets the same bytes as a w:drawing. Anything done in
  // HTML would have to be rebuilt in WordprocessingML to match.

  function rounded(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A 1-2-5 scale bar length that is a round number of metres. */
  function niceScaleMetres(targetM) {
    const pow = Math.pow(10, Math.floor(Math.log10(targetM)));
    const n = targetM / pow;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * pow;
  }

  function drawNorthArrow(ctx, cx, cy, size) {
    // True north. The view is Web Mercator with rotation 0, and Web Mercator's
    // meridians are vertical, so up on this image IS north — no correction.
    ctx.save();
    // A pad behind it: a black-and-white arrow over tree canopy is invisible.
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.2, size * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.42, size * 0.62);
    ctx.lineTo(0, size * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(-size * 0.42, size * 0.62);
    ctx.lineTo(0, size * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.font = `700 ${Math.round(size * 0.85)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("N", 0, -size * 1.12);
    ctx.restore();
  }

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    words.forEach(word => {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  const fmtLon = v => `${Math.abs(v).toFixed(4)}° ${v < 0 ? "W" : "E"}`;
  const fmtLat = v => `${Math.abs(v).toFixed(4)}° ${v < 0 ? "S" : "N"}`;

  /**
   * ONE function composes all three plates.
   *
   * Plate 1, Plate 2 and Plate 3 are three different arguments on the same
   * sheet of paper, and the thing that makes them read as a set is that the
   * title block, the scale bar, the north arrow, the corner coordinates, the
   * date and the sources are IDENTICAL on all three — same sizes, same
   * positions, same wording. The first version of this file had one plate and
   * a `composePlate`; three copies of that with small edits is how a scale bar
   * ends up verified on one sheet and wrong on the next.
   *
   * So a plate is a `spec` and this draws it:
   *
   *   { title, subtitle, kicker      the title block, three lines
   *     layout: "full"|"map-left"    map across the sheet, or map left and a
   *                                  legend column down the right
   *     legend: {title, entries[]}   swatch rows: {label, fill, stroke, dash,
   *                                  disc} — `disc` draws a numbered circle
   *                                  instead of a rectangle
   *     cards: [{n, rgb, lines[]}]   Plate 3's data legend: a numbered block
   *                                  per site, each line {text, style}
   *     table: {title, rows[[k,v]]}  Plate 2's sub-score table
   *     notes: [string]              lines under the map, above the sources
   *     inset: {dataUrl, caption}    a small framed map in the map window's
   *                                  corner, for when the main frame had to
   *                                  open up so far the parcel got small }
   *
   * Returns { dataUrl, mapPx, mPerPx, barMetres, groundWidthM } — the measured
   * numbers as well as the picture, because the scale bar is verified against
   * them rather than eyeballed.
   */
  async function composeFurniture(shot, facts, spec) {
    const s = spec || {};
    const W = shot.plateW;
    const H = shot.plateH;
    // Every dimension scales off the portrait plate's width. A landscape sheet
    // is 3300 px, so S is 1.294 and every type size grows with it — which is
    // the point: both sheets are scaled to the same 7.2 in printed width by
    // styles.css, so the wider sheet has more pixels per printed inch and type
    // drawn at a fixed pixel size would come out physically SMALLER on it.
    // Plate 3's legend is the whole argument of the sheet; it cannot shrink.
    const S = W / 2550;

    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    const pad = Math.round(110 * S);
    const titleH = Math.round(210 * S);
    // The sources block runs to four wrapped lines on a 2550-wide sheet and
    // more on a landscape one whose text column is wider; measured rather than
    // assumed, so a long note cannot push the last line off the page.
    const footH = Math.round((s.notes && s.notes.length ? 300 + 34 * s.notes.length : 300) * S);
    const mapX = pad;
    const mapY = pad + titleH;
    const mapH = H - mapY - footH - pad;
    // "map-left" gives the legend column 37% of the sheet. Measured against the
    // real cards: at 2550 px of landscape width that is a 1155 px column, which
    // holds a 40-character line at the 26 px body size — about what a reader
    // wants before their eye loses the row.
    const colW = s.layout === "map-left" ? Math.round((W - pad * 2) * 0.37) : 0;
    const colGap = colW ? Math.round(46 * S) : 0;
    const mapW = W - pad * 2 - colW - colGap;

    // -- title block --
    const id = facts.identity || {};
    const where = id.address ? `${id.address}, ${id.city || ""}`.replace(/,\s*$/, "") : "Hennepin County parcel";
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `700 ${Math.round(58 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(s.title || where, pad, pad - Math.round(26 * S));
    ctx.font = `${Math.round(34 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#444";
    ctx.fillText(
      s.subtitle || `${where} · PID ${id.pid || "unknown"}` + (id.zip ? ` · ${id.zip}` : ""),
      pad,
      pad + Math.round(52 * S)
    );
    ctx.font = `${Math.round(26 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#666";
    ctx.fillText(
      s.kicker || "NRPC Interactive Map · parcel and shared-opportunity context",
      pad,
      pad + Math.round(104 * S)
    );

    // -- the map --
    const img = await loadImage(shot.dataUrl);
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();
    // The capture was taken at the map window's own aspect ratio, so this is a
    // straight blit; cover-fit anyway so a mismatch crops rather than stretches.
    const sc = Math.max(mapW / img.width, mapH / img.height);
    const dw = img.width * sc;
    const dh = img.height * sc;
    ctx.drawImage(img, mapX + (mapW - dw) / 2, mapY + (mapH - dh) / 2, dw, dh);
    ctx.restore();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(2, Math.round(3 * S));
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    // -- corner coordinates (graticule ticks, as labels) --
    const ext = shot.extent4326;
    if (ext) {
      ctx.font = `${Math.round(22 * S)}px Georgia, "Times New Roman", serif`;
      ctx.fillStyle = "#333";
      const gap = Math.round(10 * S);
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${fmtLat(ext.ymax)}  ${fmtLon(ext.xmin)}`, mapX, mapY - gap);
      ctx.textAlign = "right";
      ctx.fillText(`${fmtLat(ext.ymax)}  ${fmtLon(ext.xmax)}`, mapX + mapW, mapY - gap);
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(`${fmtLat(ext.ymin)}  ${fmtLon(ext.xmin)}`, mapX, mapY + mapH + gap);
      ctx.textAlign = "right";
      ctx.fillText(`${fmtLat(ext.ymin)}  ${fmtLon(ext.xmax)}`, mapX + mapW, mapY + mapH + gap);
    }

    // -- scale bar --
    // The capture's ground resolution scaled by how the image was fitted.
    const mPerPx = shot.resolutionMPerPx / sc;
    const targetPx = mapW * 0.26;
    const barM = niceScaleMetres(targetPx * mPerPx);
    const barPx = barM / mPerPx;
    const barH = Math.round(20 * S);
    const bx = mapX + Math.round(34 * S);
    const by = mapY + mapH - Math.round(34 * S) - barH;

    ctx.save();
    rounded(ctx, bx - Math.round(16 * S), by - Math.round(48 * S), barPx + Math.round(32 * S), barH + Math.round(78 * S), Math.round(10 * S));
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fill();
    // Alternating black/white halves — the standard bar, readable on imagery.
    const half = barPx / 2;
    ctx.fillStyle = "#111";
    ctx.fillRect(bx, by, half, barH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(bx + half, by, half, barH);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(1, Math.round(2 * S));
    ctx.strokeRect(bx, by, barPx, barH);
    ctx.fillStyle = "#111";
    ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("0", bx, by - Math.round(6 * S));
    ctx.textAlign = "right";
    ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, bx + barPx, by - Math.round(6 * S));
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${Math.round(20 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#444";
    // Centimetres of PAPER, not captured pixels — and the sheet's own nominal
    // width, which is 11 in on a landscape plate and 8.5 in on a portrait one.
    // The printed inches are named in the line because the exports scale both
    // sheets into the portrait usable box; the bar itself is the unambiguous
    // statement of scale and is what a reader should measure against.
    const sheetIn = W > H ? 11 : 8.5;
    const cmPerPx = (sheetIn * 2.54) / W;
    ctx.fillText(
      `1 cm ≈ ${Math.round(mPerPx / cmPerPx / 10) * 10} m at ${sheetIn} in wide`,
      bx,
      by + barH + Math.round(6 * S)
    );
    ctx.restore();

    // -- north arrow --
    drawNorthArrow(ctx, mapX + mapW - Math.round(86 * S), mapY + Math.round(116 * S), Math.round(62 * S));

    // -- the inset, when the main frame had to open up too far --
    // Bottom right of the map window, clear of the scale bar (bottom left) and
    // the north arrow (top right).
    if (s.inset && s.inset.dataUrl) {
      const iw = Math.round(mapW * 0.26);
      const ih = iw;
      const ix = mapX + mapW - iw - Math.round(30 * S);
      const iy = mapY + mapH - ih - Math.round(30 * S);
      const capH = Math.round(38 * S);
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fillRect(ix - Math.round(8 * S), iy - Math.round(8 * S), iw + Math.round(16 * S), ih + capH + Math.round(16 * S));
      const iim = await loadImage(s.inset.dataUrl);
      ctx.beginPath();
      ctx.rect(ix, iy, iw, ih);
      ctx.clip();
      const isc = Math.max(iw / iim.width, ih / iim.height);
      ctx.drawImage(iim, ix + (iw - iim.width * isc) / 2, iy + (ih - iim.height * isc) / 2, iim.width * isc, iim.height * isc);
      ctx.restore();
      ctx.strokeStyle = "#111";
      ctx.lineWidth = Math.max(2, Math.round(3 * S));
      ctx.strokeRect(ix, iy, iw, ih);
      ctx.fillStyle = "#111";
      ctx.font = `700 ${Math.round(22 * S)}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(s.inset.caption || "Inset: the parcel", ix, iy + ih + Math.round(9 * S));
    }

    // -- legend --
    // On a "full" plate it floats over the map's top-left corner, where it has
    // always been. On a "map-left" plate it heads the right-hand column, on
    // white, because Plate 3's legend is nine lines a site and no amount of
    // translucency makes that readable over aerial imagery.
    let colY = mapY;
    const colX = mapX + mapW + colGap;

    if (s.legend && s.legend.entries && s.legend.entries.length) {
      const e = s.legend.entries;
      const rowH = Math.round(40 * S);
      if (s.layout === "map-left") {
        ctx.fillStyle = "#111";
        ctx.font = `700 ${Math.round(30 * S)}px Georgia, "Times New Roman", serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(s.legend.title || "Legend", colX, colY);
        colY += Math.round(46 * S);
        colY = drawLegendRows(ctx, e, colX, colY, colW, S, rowH);
        colY += Math.round(22 * S);
      } else {
        ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
        const lw = Math.round(Math.max(...e.map(x => ctx.measureText(x.label).width)) + 96 * S);
        const lh = Math.round(e.length * rowH + 58 * S);
        const lx = mapX + Math.round(34 * S);
        const ly = mapY + Math.round(34 * S);
        ctx.save();
        rounded(ctx, lx, ly, lw, lh, Math.round(10 * S));
        ctx.fillStyle = "rgba(255,255,255,0.90)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = Math.max(1, Math.round(2 * S));
        ctx.stroke();
        ctx.fillStyle = "#111";
        ctx.font = `700 ${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(s.legend.title || "Legend", lx + Math.round(18 * S), ly + Math.round(14 * S));
        drawLegendRows(ctx, e, lx + Math.round(18 * S), ly + Math.round(56 * S), lw, S, rowH);
        ctx.restore();
      }
    }

    // -- Plate 3's data legend: the card, in the column --
    if (s.cards && s.cards.length) {
      colY = drawCards(ctx, s.cards, colX, colY, colW, S);
    }

    // -- Plate 2's sub-score table, in the furniture under the map --
    let tableBottom = mapY + mapH;
    if (s.table && s.table.rows && s.table.rows.length) {
      tableBottom = drawTable(ctx, s.table, pad, mapY + mapH + Math.round(52 * S), W - pad * 2, S);
    }

    // -- footer: notes, date, sources --
    const fy = (s.table ? tableBottom : mapY + mapH) + Math.round(52 * S);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let yy = fy;
    if (s.notes && s.notes.length) {
      ctx.fillStyle = "#222";
      ctx.font = `${Math.round(23 * S)}px Georgia, "Times New Roman", serif`;
      s.notes.forEach(t => {
        wrap(ctx, t, W - pad * 2).forEach(l => {
          ctx.fillText(l, pad, yy);
          yy += Math.round(30 * S);
        });
      });
      yy += Math.round(12 * S);
    }
    ctx.fillStyle = "#111";
    ctx.font = `700 ${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillText("Map produced " + fmtDate(shot.capturedAt), pad, yy);
    yy += Math.round(38 * S);
    ctx.font = `${Math.round(21 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#444";
    (s.sources || defaultSources()).forEach(t => {
      wrap(ctx, t, W - pad * 2).forEach(l => {
        ctx.fillText(l, pad, yy);
        yy += Math.round(28 * S);
      });
    });

    // The realised ground width across the map window, measured off the
    // captured extent's own corners rather than derived from the resolution
    // the scale bar uses — which is what makes the 0.00% check in
    // outputs/verify-plates.js an independent check and not a tautology.
    const groundWidthM = ext ? haversine(ext.ymin, ext.xmin, ext.ymin, ext.xmax) : null;

    return {
      // Slightly higher quality than the inline figures: the plates carry text
      // (title, legend, scale bar, and on Plate 3 the whole card) that JPEG
      // blocking would soften.
      dataUrl: cv.toDataURL("image/jpeg", 0.94),
      mapPx: { x: mapX, y: mapY, w: mapW, h: mapH },
      mPerPx,
      barMetres: barM,
      groundWidthM,
    };
  }

  /** Swatch rows. Returns the y it finished at. */
  function drawLegendRows(ctx, entries, x, y, maxW, S, rowH) {
    ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let yy = y;
    entries.forEach(e => {
      const sw = Math.round(38 * S);
      const sh = Math.round(20 * S);
      if (e.disc) {
        // The numbered discs on Plates 1 and 3, drawn the way the map draws
        // them, so a reader matching "3" on the sheet to "3" in the column is
        // matching the same object and not two similar ones.
        const r = Math.round(15 * S);
        ctx.beginPath();
        ctx.arc(x + r, yy + r - Math.round(2 * S), r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fill();
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = Math.max(1, Math.round(2.5 * S));
        ctx.stroke();
        ctx.fillStyle = "#111";
        ctx.font = `700 ${Math.round(21 * S)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(String(e.disc), x + r, yy + Math.round(2 * S));
        ctx.textAlign = "left";
        ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
      } else {
        ctx.fillStyle = e.fill;
        ctx.fillRect(x, yy, sw, sh);
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = Math.max(1, Math.round(2.5 * S));
        if (e.dash) ctx.setLineDash([Math.round(6 * S), Math.round(5 * S)]);
        ctx.strokeRect(x, yy, sw, sh);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#111";
      const lines = wrap(ctx, e.label, maxW - sw - Math.round(20 * S));
      lines.forEach((l, li) => ctx.fillText(l, x + sw + Math.round(14 * S), yy - Math.round(2 * S) + li * Math.round(28 * S)));
      yy += Math.max(rowH, lines.length * Math.round(28 * S) + Math.round(10 * S));
    });
    return yy;
  }

  /**
   * Plate 3's data legend. Bryan asked for "data rich labeling (same info in
   * the report but in the legend for the map)", so this is the report's card
   * — organisation, contact name, email, score with its scale, date added,
   * source layer, description, distance — laid out as a numbered block. It is
   * a legend in the cartographic sense: the numbers on the map mean nothing
   * without it.
   */
  function drawCards(ctx, cards, x, y, w, S) {
    let yy = y;
    const bodyPx = Math.round(24 * S);
    const lineH = Math.round(29 * S);
    cards.forEach(card => {
      const r = Math.round(17 * S);
      ctx.beginPath();
      ctx.arc(x + r, yy + r, r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = `rgb(${card.rgb[0]},${card.rgb[1]},${card.rgb[2]})`;
      ctx.lineWidth = Math.max(2, Math.round(3 * S));
      ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.font = `700 ${Math.round(23 * S)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(card.n), x + r, yy + r + Math.round(1 * S));
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      const tx = x + r * 2 + Math.round(14 * S);
      const tw = w - (r * 2 + Math.round(14 * S));
      let ty = yy;
      card.lines.forEach(ln => {
        const style = ln.style || "body";
        if (style === "head") {
          ctx.font = `700 ${Math.round(26 * S)}px Georgia, "Times New Roman", serif`;
          ctx.fillStyle = "#111";
        } else if (style === "missing") {
          ctx.font = `italic ${bodyPx}px Georgia, "Times New Roman", serif`;
          ctx.fillStyle = "#8a8a8a";
        } else if (style === "quiet") {
          ctx.font = `${Math.round(22 * S)}px Georgia, "Times New Roman", serif`;
          ctx.fillStyle = "#555";
        } else {
          ctx.font = `${bodyPx}px Georgia, "Times New Roman", serif`;
          ctx.fillStyle = "#222";
        }
        wrap(ctx, ln.text, tw).forEach(l => {
          ctx.fillText(l, tx, ty);
          ty += lineH;
        });
      });
      yy = Math.max(ty, yy + r * 2) + Math.round(16 * S);
      ctx.strokeStyle = "rgba(0,0,0,0.14)";
      ctx.lineWidth = Math.max(1, Math.round(1.5 * S));
      ctx.beginPath();
      ctx.moveTo(x, yy - Math.round(8 * S));
      ctx.lineTo(x + w, yy - Math.round(8 * S));
      ctx.stroke();
      yy += Math.round(12 * S);
    });
    return yy;
  }

  /** Plate 2's seven model scores, two columns of key/value. */
  function drawTable(ctx, table, x, y, w, S) {
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111";
    ctx.font = `700 ${Math.round(26 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(table.title, x, y);
    let yy = y + Math.round(40 * S);
    const cols = 2;
    const colW = Math.floor(w / cols);
    const rowH = Math.round(32 * S);
    const perCol = Math.ceil(table.rows.length / cols);
    ctx.font = `${Math.round(23 * S)}px Georgia, "Times New Roman", serif`;
    table.rows.forEach(([kk, vv], i) => {
      const c = Math.floor(i / perCol);
      const r = i % perCol;
      const cx = x + c * colW;
      const cy = yy + r * rowH;
      ctx.fillStyle = "#444";
      ctx.fillText(kk, cx, cy);
      ctx.fillStyle = "#111";
      ctx.textAlign = "right";
      ctx.fillText(vv, cx + colW - Math.round(40 * S), cy);
      ctx.textAlign = "left";
    });
    return yy + perCol * rowH;
  }

  function defaultSources() {
    return [
      DATA_ATTRIB,
      ESRI_ATTRIB,
      "Projection: Web Mercator (EPSG:3857). Grid: WGS 84 (EPSG:4326) corner coordinates. North is true north.",
      "Produced by the NRPC Interactive Map, University of Minnesota. Not a survey; boundaries are approximate.",
    ];
  }

  /** Great-circle metres between two lat/lon pairs. */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ── The three plates' legend specs ───────────────────────────────────────

  /** Plate 1. The 250 m ring row is gone with the ring itself. */
  function plateOneLegend(facts) {
    const out = [
      { label: "Subject parcel", fill: "rgba(255,190,60,0.35)", stroke: "rgb(255,150,0)" },
      { label: "Parcels touching it", fill: "rgba(120,120,120,0.22)", stroke: "rgb(60,60,60)", dash: true },
    ];
    const opps = facts.sharedOpportunities;
    const present = new Set(((opps && opps.mapGeometry && opps.mapGeometry.features) || []).map(f => f.relation));
    Object.keys(SYM.tier).forEach(rel => {
      if (!present.has(rel)) return;
      const c = SYM.tier[rel];
      out.push({
        label: TIER_LABEL[rel] || rel,
        fill: `rgba(${c[0]},${c[1]},${c[2]},0.45)`,
        stroke: `rgb(${c[0]},${c[1]},${c[2]})`,
      });
    });
    return out;
  }

  /** Plate 2. The model's own five breaks, then the two Met Council classes. */
  function plateTwoLegend() {
    const out = MODEL_BREAKS.map(b => ({
      label: b.label,
      fill: `rgba(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]},0.72)`,
      stroke: "rgba(120,120,120,0.9)",
    }));
    out.push({
      label: ECO_SYM.significant.label,
      fill: `rgba(${ECO_SYM.significant.rgb.join(",")},0.34)`,
      stroke: `rgb(${ECO_SYM.significant.rgb.join(",")})`,
    });
    out.push({
      label: ECO_SYM.sensitive.label,
      fill: `rgba(${ECO_SYM.sensitive.rgb.join(",")},0.34)`,
      stroke: `rgb(${ECO_SYM.sensitive.rgb.join(",")})`,
      dash: true,
    });
    out.push({ label: "Subject parcel", fill: "rgba(0,0,0,0)", stroke: "rgb(20,60,200)" });
    return out;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("could not decode the captured map"));
      im.src = src;
    });
  }

  function fmtDate(d) {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  /**
   * Everything the export needs, in one call.
   *
   * @param {object} facts       the assembled facts (needs parcelRings)
   * @param {function} onProgress called with a short status string
   * @param {object} [options]    { cardLines }. `cardLines(row)` returns the
   *   legend block for one contribution on Plate 3, as [{text, style}].
   *   js/parcel-report.js supplies it from the same helpers that build the
   *   report's own card, so the sheet and the list cannot say different things
   *   about the same contribution. Omitted, a thinner fallback is used.
   * @returns {Promise<{figures: object[], plates: object[], plate: object|null,
   *                    totalMs: number, failures: string[]}>}
   */
  async function buildAll(facts, onProgress, options) {
    const say = onProgress || function () {};
    const opts = options || {};
    const t0 = performance.now();
    const failures = [];
    const figures = [];

    if (!facts || !facts.parcelRings) {
      return { figures: [], plates: [], plate: null, totalMs: 0, failures: ["no parcel geometry"] };
    }

    const plan = [
      {
        kind: "facts",
        title: "Figure 1. The parcel",
        caption: () =>
          `The subject parcel outlined on aerial imagery. PID ${
            (facts.identity && facts.identity.pid) || "unknown"
          }${facts.land && facts.land.parcelAcres ? `, ${facts.land.parcelAcres} acres` : ""}.`,
        margin: 0.35,
      },
      {
        kind: "context",
        title: "Figure 2. What “within 250 m” covers",
        caption: () => {
          const hits = (facts.context || []).filter(c => c.count > 0).map(c => c.layer);
          return (
            `The parcel and a ${facts.contextBufferMetres || 250} m geodesic ring around it — the ` +
            `area the context counts are measured over. ` +
            (hits.length
              ? `Layers with a feature inside the ring: ${hits.join("; ")}.`
              : "No context layer has a feature inside the ring.")
          );
        },
        margin: 0.25,
      },
      {
        kind: "opportunity",
        title: "Figure 3. The adjacency argument",
        caption: () => {
          const o = facts.sharedOpportunities;
          if (!o) return "No shared-opportunity data was available for this parcel.";
          const pids = (o.adjacency && o.adjacency.pids) || [];
          const ranked = (o.nearest || []).length;
          const wide = (o.nearest || []).filter(r => r.relation === "wider search").length;
          return (
            `Contributions coloured by tier, with the parcels touching this one shown dashed. ` +
            (ranked
              ? `The numbered ones are the ${ranked} the list above prints, in the same order, each number ` +
                `sitting at the point of the contribution nearest this parcel. ` +
                (wide
                  ? `${wide} of them came from the wider search and may lie outside this frame. `
                  : "")
              : "") +
            `${o.onParcelCount} on the parcel, ${o.onAdjacentCount} on an adjacent parcel, ` +
            `${o.nearbyCount} nearby. ` +
            (pids.length
              ? `Adjacent parcels carrying an opportunity: ${pids.join(", ")}.`
              : "No adjacent parcel carries an opportunity.") +
            ` ${o.adjacency ? o.adjacency.parcelsSearched : 0} touching parcels were searched.`
          );
        },
        margin: 0.15,
      },
    ];

    for (const step of plan) {
      say(`Preparing maps… ${step.kind}`);
      const shot = await capture(facts, step.kind, {
        width: INLINE_W,
        height: INLINE_H,
        marginFraction: step.margin,
      });
      if (!shot) {
        failures.push(step.kind);
        continue;
      }
      figures.push({
        ...shot,
        title: step.title,
        caption: step.caption(),
        source: `${DATA_ATTRIB}. ${ESRI_ATTRIB}. Captured ${shot.capturedAt.toLocaleString()}.`,
      });
    }

    // ── The three plates ──────────────────────────────────────────────────
    //
    // Each is captured at its own map window's aspect, then handed with a spec
    // to composeFurniture(). The window geometry has to be computed here as
    // well as there, because the capture has to be taken at the shape the
    // furniture will draw it into or the blit crops it.

    const plates = [];
    const plateWindow = (size, layout, notes) => {
      const S = size.w / 2550;
      const pad = Math.round(110 * S);
      const footH = Math.round((notes ? 300 + 34 * notes : 300) * S);
      const colW = layout === "map-left" ? Math.round((size.w - pad * 2) * 0.37) : 0;
      const colGap = colW ? Math.round(46 * S) : 0;
      return {
        w: size.w - pad * 2 - colW - colGap,
        h: size.h - (pad + Math.round(210 * S)) - footH - pad,
      };
    };

    async function plate(name, kind, size, spec, capOpts) {
      const win = plateWindow(size, spec.layout, (spec.notes || []).length);
      const shot = await capture(facts, kind, {
        width: Math.min(win.w, 2400),
        height: Math.min(win.h, 2400),
        timeoutMs: 20000,
        ...(capOpts || {}),
      });
      if (!shot) {
        failures.push(name);
        return null;
      }
      shot.plateW = size.w;
      shot.plateH = size.h;
      const composed = await composeFurniture(shot, facts, spec);
      return {
        name,
        kind,
        dataUrl: composed.dataUrl,
        width: size.w,
        height: size.h,
        orientation: size === PLATE_LANDSCAPE ? "landscape" : "portrait",
        capturedAt: shot.capturedAt,
        captureMs: shot.captureMs,
        // The scale-bar verification reads these: mPerPx is what the bar was
        // drawn from, groundWidthM is the haversine across the extent's own
        // corners, and the two have to agree to 0.00%.
        resolutionMPerPx: composed.mPerPx,
        captureResolutionMPerPx: shot.resolutionMPerPx,
        groundWidthM: composed.groundWidthM,
        barMetres: composed.barMetres,
        mapPx: composed.mapPx,
        extent4326: shot.extent4326,
        alt: spec.alt,
        title: spec.title,
      };
    }

    // -- Plate 1: the parcel and its neighbourhood. No 250 m ring. --
    say("Preparing maps… plate 1, the parcel");
    try {
      const size = parcelAspect(facts) > 1.25 ? PLATE_LANDSCAPE : PLATE_PORTRAIT;
      const p = await plate(
        "plate",
        "plate",
        size,
        {
          title: "The parcel and its neighbourhood",
          layout: "full",
          legend: { title: "Legend", entries: plateOneLegend(facts) },
          notes: [
            "Framed on the parcel and the parcels touching it. A contribution that runs past the edge " +
              "continues beyond this frame.",
          ],
          alt:
            "Parcel map, 8.5 by 11 inches: aerial imagery with the parcel outline, the parcels " +
            "touching it, the shared opportunities by tier, a scale bar, a north arrow, a legend " +
            "and corner coordinates.",
        },
        { marginFraction: 0.16 }
      );
      if (p) plates.push(p);
    } catch (e) {
      console.warn("[report-maps] plate 1 failed:", e);
      failures.push("plate");
    }

    // -- Plate 2: ecological sensitivity and the suitability model --
    say("Preparing maps… plate 2, sensitivity and suitability");
    try {
      const mod = facts.model;
      const rows = mod && mod.scores ? Object.keys(mod.scores).map(kk => [kk, fmtScore(mod.scores[kk])]) : [];
      const rankLine =
        mod && mod.rank
          ? `Rank ${mod.rank.toLocaleString("en-US")}` +
            (mod.parcelsRanked ? ` of ${mod.parcelsRanked.toLocaleString("en-US")}` : "") +
            (mod.topPercentOfCounty !== null && mod.topPercentOfCounty !== undefined
              ? ` — top ${mod.topPercentOfCounty}% of the county`
              : "")
          : "This parcel is not present in the prioritization model layer.";
      const p = await plate(
        "eco",
        "eco",
        PLATE_PORTRAIT,
        {
          title: "Ecological sensitivity and suitability",
          subtitle:
            (facts.identity && facts.identity.address
              ? facts.identity.address + " · "
              : "") + `PID ${(facts.identity && facts.identity.pid) || "unknown"} · ${rankLine}`,
          kicker:
            "Hennepin County Parcel Prioritization Model, the layer's own five class breaks · " +
            "Metropolitan Council ecologically significant and sensitive areas",
          layout: "full",
          legend: { title: "Overall Value (model score)", entries: plateTwoLegend() },
          table: rows.length ? { title: "The parcel's model scores", rows } : null,
          notes: [
            `Every parcel in frame is shaded by its Overall Value in the Hennepin County Parcel ` +
              `Prioritization Model. The five classes are the layer's OWN published breaks, not a ` +
              `reclassification: they are what the service's renderer draws.`,
            `The Metropolitan Council's ecologically significant and sensitive area layers publish no ` +
              `class or rating field — the layer a polygon is in is the only distinction the data ` +
              `carries, and that is what the legend shows.`,
          ],
          sources: [
            "Model: Hennepin County Parcel Prioritization Model results (parcel detail), ArcGIS Online " +
              "service Hennepin_Suitability_Model_Results_parcel_detail/97.",
            "Ecological areas: Metropolitan Council, via Met_Council_Data_Ecologically_Significant_Areas/106 " +
              "and Met_Council_Data_Ecologically_Sensitive_Areas/108.",
            DATA_ATTRIB,
            ESRI_ATTRIB,
            "Projection: Web Mercator (EPSG:3857). Grid: WGS 84 (EPSG:4326) corner coordinates. North is true north.",
            "Produced by the NRPC Interactive Map, University of Minnesota. Not a survey; boundaries are approximate.",
          ],
          alt:
            "Ecological sensitivity and suitability map, 8.5 by 11 inches: parcels shaded by the " +
            "Hennepin County prioritization model's overall value, Metropolitan Council ecologically " +
            "significant and sensitive areas outlined over them, the subject parcel outlined in blue " +
            "and labelled with its score and rank, with a legend, scale bar, north arrow, the seven " +
            "model scores and corner coordinates.",
        },
        // Almost no margin: the frame IS the 500 m geodesic buffer, and the
        // default 18% would quietly make "500 m out all round" 590 m.
        { marginFraction: 0.02 }
      );
      if (p) {
        p.frameMetres = ECO_FRAME_M;
        plates.push(p);
      }
    } catch (e) {
      console.warn("[report-maps] plate 2 failed:", e);
      failures.push("eco");
    }

    // -- Plate 3: the nearest shared opportunities, legend as data --
    say("Preparing maps… plate 3, the nearest sites");
    try {
      const o = facts.sharedOpportunities;
      const rows = (o && o.nearest) || [];
      if (!rows.length) {
        // Nothing to number and nothing to put in the column. A sheet whose
        // legend is the data, with no data, is a blank sheet.
        failures.push("sites (no contributions to plot)");
      } else {
        const cards = rows.map(r => ({
          n: r.nearestRank,
          rgb: SYM.tier[r.relation] || [200, 200, 200],
          lines: (opts.cardLines ? opts.cardLines(r) : fallbackCardLines(r)).map(ln => ({
            text: ln.text,
            style: ln.style,
          })),
        }));

        // The inset rule. Frame first, measure the parcel against the frame,
        // and only then decide — the widened row that drags the frame out is
        // the case this exists for, and it is a property of the data, not
        // something that can be decided in advance.
        const probe = await capture(facts, "sites", {
          width: 1200,
          height: 900,
          marginFraction: 0.14,
          timeoutMs: 20000,
        });
        let inset = null;
        let insetNote = null;
        if (probe && probe.extent4326) {
          const e = probe.extent4326;
          const frameW = haversine(e.ymin, e.xmin, e.ymin, e.xmax);
          const pw = parcelGroundWidthM(facts);
          if (pw && frameW && pw / frameW < INSET_TRIGGER) {
            const ishot = await capture(facts, "plate", {
              width: 900,
              height: 900,
              marginFraction: 0.3,
              timeoutMs: 20000,
            });
            if (ishot) {
              inset = { dataUrl: ishot.dataUrl, caption: "Inset: the parcel and its neighbours" };
              insetNote =
                `The five sites are spread far enough that the subject parcel is ` +
                `${((pw / frameW) * 100).toFixed(1)}% of the frame's width, so it is shown again in the ` +
                `inset at a legible scale. The inset is a different scale from the main map; the scale ` +
                `bar applies to the main map only.`;
            }
          }
        }

        const notes = [
          "The numbers on the map are the numbers in this legend and in the report's Nearest 5 list — " +
            "one contribution, one number, in all three places.",
        ];
        if (insetNote) notes.push(insetNote);
        if (o.widen && o.widen.added) {
          notes.push(
            `${o.widen.added} of the five came from the search widened once to ` +
              `${o.widen.radiusMetres.toLocaleString("en-US")} m, because fewer than ` +
              `${o.nearestLimit} contributions are on this parcel, on a parcel touching it, or ` +
              `within ${o.bufferMetres} m.`
          );
        }

        const p = await plate(
          "sites",
          "sites",
          PLATE_LANDSCAPE,
          {
            title: "Nearest shared opportunities",
            layout: "map-left",
            legend: {
              title: "Nearest " + rows.length + " contributions",
              entries: [
                { label: "Subject parcel", fill: "rgba(255,190,60,0.35)", stroke: "rgb(255,150,0)" },
                {
                  label: "Parcels touching it",
                  fill: "rgba(120,120,120,0.22)",
                  stroke: "rgb(60,60,60)",
                  dash: true,
                },
              ],
            },
            cards,
            notes,
            inset,
            alt:
              "Nearest shared opportunities map, 11 by 8.5 inches: the parcel and the nearest " +
              rows.length +
              " coalition contributions numbered on aerial imagery, with a legend column giving each " +
              "one's organisation, contact, score, date added, source layer, description and distance.",
          },
          { marginFraction: 0.14 }
        );
        if (p) {
          p.insetUsed = !!inset;
          // The same card again, as two-column rows, for the DOCX to print as
          // real text under the image — see buildPrintDoc(). Word scales the
          // landscape sheet into the text column and the legend's body type
          // lands around 6.5 pt there; a table under it is the difference
          // between a legend and a decoration.
          p.legendRows = cards.map(c => [
            c.n + ". " + c.lines[0].text,
            c.lines
              .slice(1)
              .map(l => l.text)
              .join(" · "),
          ]);
          plates.push(p);
        }
      }
    } catch (e) {
      console.warn("[report-maps] plate 3 failed:", e);
      failures.push("sites");
    }

    return {
      figures,
      plates,
      // Kept: everything downstream that only ever wanted the first plate —
      // and every caller written before there were three — still reads this.
      plate: plates[0] || null,
      totalMs: Math.round(performance.now() - t0),
      failures,
    };
  }

  const fmtScore = v =>
    v === null || v === undefined
      ? "not recorded"
      : Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0)
      ? v.toExponential(3)
      : v.toFixed(v === Math.round(v) ? 0 : 4);

  /**
   * The legend card, when nobody handed us a formatter.
   *
   * js/parcel-report.js passes `opts.cardLines`, which is built from the same
   * helpers the report's own card is built from — that is what stops the sheet
   * and the list drifting apart. This is the fallback for a caller that did
   * not, and it says less rather than saying something different.
   */
  function fallbackCardLines(r) {
    const out = [{ text: r.organization || "Organization not recorded", style: "head" }];
    if (r.contributor) out.push({ text: r.contributor, style: "body" });
    if (r.description) out.push({ text: clip(r.description, CARD_DESC_MAX), style: "body" });
    if (r.distanceMetres !== null && r.distanceMetres !== undefined) {
      out.push({ text: r.distanceMetres.toLocaleString("en-US") + " m", style: "quiet" });
    }
    return out;
  }

  /** Cut at a word boundary, with an ellipsis, or leave it alone. */
  function clip(s, n) {
    const t = String(s).replace(/\s+/g, " ").trim();
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
  }

  /** The parcel's bounding-box width on the ground, in metres. */
  function parcelGroundWidthM(facts) {
    const rings = facts.parcelRings;
    if (!rings || !rings.length) return null;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    rings.forEach(r =>
      r.forEach(([x, y]) => {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      })
    );
    if (!isFinite(xmin)) return null;
    return haversine((ymin + ymax) / 2, xmin, (ymin + ymax) / 2, xmax);
  }

  /** width / height of the parcel's bounding box, in ground units. */
  function parcelAspect(facts) {
    const rings = facts.parcelRings;
    if (!rings || !rings.length) return 1;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    rings.forEach(r => r.forEach(([x, y]) => {
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }));
    const lat = ((ymin + ymax) / 2) * (Math.PI / 180);
    const w = (xmax - xmin) * Math.cos(lat);
    const h = ymax - ymin;
    return h > 0 ? w / h : 1;
  }

  return {
    buildAll,
    capture,
    composeFurniture,
    // Exposed for tests and for the scale-bar verification.
    _internals: {
      niceScaleMetres,
      parcelAspect,
      parcelGroundWidthM,
      haversine,
      clip,
      plateOneLegend,
      plateTwoLegend,
      AERIAL_BASEMAP,
      ESRI_ATTRIB,
      DATA_ATTRIB,
      MODEL_BREAKS,
      MODEL_FIELD,
      METC_SIGNIFICANT,
      METC_SENSITIVE,
      MODEL_PARCEL,
      ECO_FRAME_M,
      CARD_DESC_MAX,
      INSET_TRIGGER,
    },
  };
})();

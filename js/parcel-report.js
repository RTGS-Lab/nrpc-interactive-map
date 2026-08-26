/* ──────────────────────────────────────────────────────────────────────────
 * Parcel Report
 *
 * Click a parcel → a panel of the facts we can pull for it, including the
 * opportunities NRPC coalition members have contributed on or near it →
 * "Generate report" → a written site summary from Claude, streamed into the
 * panel → "Export as PDF", which prints a clean, map-free version of it all.
 *
 * Self-contained: no build step, no bundler, no dependency beyond what
 * index.html already loads. main.js hands us the view; everything else in here
 * talks to ArcGIS REST and to the Anthropic Messages API over plain fetch().
 *
 * THE API KEY IS THE USER'S, NOT THE REPO'S. It is typed into the panel, kept
 * in localStorage on that one browser, and sent only to api.anthropic.com. It
 * is never committed, never written to a config file, and never sent anywhere
 * else. "Forget key" wipes it.
 *
 * Exposes: window.NRPCParcelReport.init({ view, Graphic, GraphicsLayer })
 * ────────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  // ── Configuration ────────────────────────────────────────────────────────

  const STORAGE_KEY = "nrpc-parcel-report.apiKey";
  const MODEL_KEY = "nrpc-parcel-report.model";

  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const ANTHROPIC_VERSION = "2023-06-01";
  const DEFAULT_MODEL = "claude-sonnet-5";
  const MODEL_CHOICES = [
    ["claude-sonnet-5", "Sonnet 5 (faster, cheaper)"],
    ["claude-opus-5", "Opus 5 (stronger)"],
  ];

  // Hennepin County "Parcel Base" — the layer the map already shows under
  // Boundaries ▸ Parcels. This is the click target and the source of the
  // tax/assessment attributes.
  const PARCEL_BASE =
    "https://gis.hennepin.us/arcgis/rest/services/Maps/NATURALRESOURCES/MapServer/2";

  // Parcel Prioritization Model Results (Parcel View) — joins to PARCEL_BASE
  // on PID. Holds the seven model scores and the county-wide rank.
  const MODEL_PARCEL =
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Hennepin_Suitability_Model_Results_parcel_detail/FeatureServer/97";

  // How far past the parcel boundary we look for context features.
  const CONTEXT_BUFFER_M = 250;

  // ── Parcel adjacency ─────────────────────────────────────────────────────
  //
  // "Adjacent" is topology, not radius. A neighbouring 200-acre park touches
  // the clicked parcel, but something drawn at its far end can sit a kilometre
  // away — and a radius big enough to catch it catches everything else at that
  // radius too. So the parcels touching the clicked one are looked up once, by
  // the same spatial index the click itself uses, and they become the second
  // of three tiers.
  //
  // Measured against the live Hennepin Parcel Base and the 232 real
  // contributions on 2026-08-26: 817 (parcel, contribution) pairs in the
  // county have a contribution sitting on a directly adjacent parcel MORE than
  // 250 m from the clicked boundary. Every one of them is invisible to the old
  // fixed 250 m rule.

  // Enough to reach across a road right-of-way, which is what "adjacent" means
  // to a land manager. Measured on PID 2411921110001 (Brooklyn Park): 15 m
  // finds 9 neighbours, 30 m finds 13 — the four extra are across 83rd Ave N.
  const ADJ_TOLERANCE_M = 30;

  // Adjacent parcels actually searched. Past this, the nearest ADJ_MAX by
  // envelope distance are kept and the rest are reported rather than searched.
  const ADJ_MAX = 40;

  // What we ASK the server for. Hennepin's Parcel Base returns twelve fewer
  // features than `resultRecordCount` requests — verified across seven values
  // on 2026-08-26 (ask 30 → 19, ask 41 → 29, ask 60 → 48, ask 150 → all 121).
  // `exceededTransferLimit` is the only trustworthy "there are more" signal.
  // Asking for ADJ_MAX + 20 reliably yields at least ADJ_MAX.
  const ADJ_FETCH = ADJ_MAX + 20;

  // Ceiling on the computed opportunity search distance. An adjacent parcel
  // reaching beyond this is named in one line rather than searched to its end.
  const ADJ_MAX_D_M = 1500;

  // The third tier: still the old 250 m, measured from the parcel boundary.
  const NEARBY_M = CONTEXT_BUFFER_M;

  const ADJ_TIMEOUT_MS = 12000;

  // Everything we intersect against the parcel's neighbourhood. `label` is what
  // the user and the model see; `nameField` is the field worth quoting.
  const CONTEXT_LAYERS = [
    {
      key: "parks",
      label: "Public parks",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/HennepinCounty_Parks_Clipped/FeatureServer/101",
      fields: ["PARKNAME", "AGENCYNAME", "PARK_ACRES", "FUNC_TYPE"],
      nameField: "PARKNAME",
    },
    {
      key: "water",
      label: "Public water basins (DNR)",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/HennepinCounty_PublicWaterBasins_Clipped/FeatureServer/99",
      fields: ["pw_basin_n", "gnis_name", "wettype", "pwi_label", "acres"],
      nameField: "pw_basin_n",
    },
    {
      key: "trails",
      label: "Regional trails",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Regional_Trails/FeatureServer/118",
      fields: ["TrailName", "AgencyMana", "TrailType", "OpenPublic"],
      nameField: "TrailName",
    },
    {
      key: "ecoSignificant",
      label: "Met Council ecologically significant areas",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Ecologically_Significant_Areas/FeatureServer/106",
      fields: ["CTU_NAME", "source"],
      nameField: "source",
    },
    {
      key: "ecoSensitive",
      label: "Met Council ecologically sensitive areas",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Ecologically_Sensitive_Areas/FeatureServer/108",
      fields: ["CTU_NAME", "source"],
      nameField: "source",
    },
    {
      key: "protection",
      label: "Met Council protection opportunities",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Protection_Opportunities/FeatureServer/103",
      fields: ["CTU_NAME", "source"],
      nameField: "source",
    },
    {
      key: "improvement",
      label: "Met Council improvement opportunities",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Met_Council_Data_Improvement_Opportunities/FeatureServer/104",
      fields: ["CTU_NAME", "source"],
      nameField: "source",
    },
    {
      key: "publicParcels",
      label: "Publicly owned / tax-exempt parcels",
      url: "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/HennepinCounty_PublicParcels_Clipped/FeatureServer/100",
      fields: ["OWNER_NAME", "USECLASS1", "ACRES_POLY", "OWNER_LVL"],
      nameField: "OWNER_NAME",
    },
    {
      key: "watershed",
      label: "Watershed district",
      url: "https://services1.arcgis.com/ziLNoRgqnICUM0q1/arcgis/rest/services/Watershed_Districts_2/FeatureServer/0",
      fields: ["BWSR_NAME", "BWSR_TYPE", "ORG_TYPE"],
      nameField: "BWSR_NAME",
    },
  ];

  // ── Shared opportunities ─────────────────────────────────────────────────
  //
  // The five feature layers under the webmap's "NRPC Data" group that hold
  // what coalition members themselves put on the map — as opposed to the
  // county / Met Council / DNR layers above, which are published datasets.
  //
  // The first two are the layers the Contribute panel's Editor widget writes
  // to (main.js turns the "NRPC Opportunity Layers" group on when Contribute
  // opens). The other three are the April 2025 Winter Workshop layers, which
  // carry the identical contribution schema and are where every opportunity
  // recorded so far actually lives.
  //
  // Verified against the live service metadata on 2026-08-26:
  //   NRPC_Opportunity_Layer/1  polygon   0 features
  //   NRPC_Opportunity_Layer/0  point     0 features
  //   Winter_Workshop_Activity_1/0        point      162 features
  //   Winter_Workshop_Activity_2/1        polygon     21 features
  //   Winter_Workshop_Activity_2/0        polyline    49 features
  //
  // There is NO "opportunity type" field anywhere in these schemas. The layer
  // a contribution sits in is the only type distinction the data carries, so
  // `label` is what the report calls the type. Do not invent one.
  const NRPC_OPP_SERVICE =
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services";

  const OPPORTUNITY_LAYERS = [
    {
      key: "oppPolygon",
      label: "Opportunity area (polygon)",
      source: "NRPC Opportunity Layers",
      url: NRPC_OPP_SERVICE + "/NRPC_Opportunity_Layer/FeatureServer/1",
      geometry: "polygon",
      schema: "opportunity",
    },
    {
      key: "oppPoint",
      label: "Opportunity area (point)",
      source: "NRPC Opportunity Layers",
      url: NRPC_OPP_SERVICE + "/NRPC_Opportunity_Layer/FeatureServer/0",
      geometry: "point",
      schema: "opportunity",
    },
    {
      key: "workshop1",
      label: "Winter Workshop 2025 — opportunity",
      source: "Winter Workshop 2025, Activity 1",
      url: NRPC_OPP_SERVICE + "/Winter_Workshop_Activity_1/FeatureServer/0",
      geometry: "point",
      schema: "opportunity",
    },
    {
      key: "workshop2physical",
      label: "Winter Workshop 2025 — physical connection",
      source: "Winter Workshop 2025, Activity 2",
      url: NRPC_OPP_SERVICE + "/Winter_Workshop_Activity_2/FeatureServer/1",
      geometry: "polygon",
      schema: "connection",
    },
    {
      key: "workshop2thematic",
      label: "Winter Workshop 2025 — thematic connection",
      source: "Winter Workshop 2025, Activity 2",
      url: NRPC_OPP_SERVICE + "/Winter_Workshop_Activity_2/FeatureServer/0",
      geometry: "polyline",
      schema: "connection",
    },
  ];

  // Fields shared by both contribution schemas, then the ones each adds. The
  // labels are shortened from the layers' own aliases, which are the full
  // survey questions ("Is the opportunity feasible in the next 3 years?").
  const OPP_COMMON_FIELDS = ["OBJECTID", "name", "organization", "describe_opportunity", "potential_funder", "CreationDate"];
  const OPP_SCHEMA_FIELDS = {
    opportunity: ["three_years", "easy_start", "what_smooth", "what_challenging"],
    connection: ["connection_needs", "rate_priority", "rate_feasibility"],
  };

  // What each extra field is called in the report, in the order it reads best.
  const OPP_DETAIL_LABELS = [
    ["feasibleInThreeYears", "Feasible in 3 years"],
    ["easeOfStart", "Ease of starting (1 easy – 5 hard)"],
    ["priorityRating", "Priority (1 low – 5 high)"],
    ["feasibilityRating", "Feasibility (1 low – 5 high)"],
    ["whatGoesSmoothly", "Expected to go smoothly"],
    ["whatIsChallenging", "Expected to be challenging"],
    ["connectionNeeds", "Needed to make the connection"],
    ["potentialFunder", "Potential funder"],
  ];

  // A slow or unreachable contribution layer must never hold up the report.
  const OPP_TIMEOUT_MS = 12000;

  // Model score fields, in the order they read best. Aliases are the layer's
  // own published aliases — not our invention.
  const SCORE_FIELDS = [
    ["Overall_Va", "Overall Value"],
    ["Spatial_Co", "Spatial Context"],
    ["Habitat_Qu", "Habitat Quality"],
    ["Size", "Size"],
    ["Wildlife_P", "Wildlife / Plant Conservation"],
    ["Risk_of_Co", "Risk of Conversion"],
    ["Water_Res", "Water Resources"],
  ];

  // Fields carrying a private individual's name or mailing address. Public
  // record, but a conservation-priority summary does not need them, so they
  // are withheld from the API payload unless the user ticks the box.
  const OWNER_FIELDS = [
    "OWNER_NM",
    "TAXPAYER_NM",
    "TAXPAYER_NM_1",
    "TAXPAYER_NM_2",
    "TAXPAYER_NM_3",
    "MAILING_MUNIC_NM",
  ];

  const SQFT_PER_ACRE = 43560;

  // ── Small helpers ────────────────────────────────────────────────────────

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    kids.forEach(k => n.append(k));
    return n;
  };

  const clean = v =>
    (typeof v === "string" ? v.trim() : v) === "" ? null : (typeof v === "string" ? v.trim() : v);

  const num = v => (typeof v === "number" && isFinite(v) ? v : null);

  // Hennepin uses all-zero strings as "no value" in the year and code fields.
  const zeroStrOrNull = v => {
    const s = clean(v);
    return s && /^[0]+$/.test(s) ? null : s;
  };

  // A top-N% figure. 54 of 445,517 is 0.01%, not the "0.0%" a single decimal
  // would round it to, so keep two decimals below 1%.
  const topPct = (rank, total) => {
    const p = (rank / total) * 100;
    return (p < 1 ? p.toFixed(2) : p.toFixed(1)) + "%";
  };

  const money = v => (num(v) === null ? null : "$" + Math.round(v).toLocaleString("en-US"));

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function esriQuery(url, params, timeoutMs) {
    const body = new URLSearchParams({ f: "json", ...params });
    // A per-request deadline, so one wedged service cannot hold the panel
    // open forever. Without a timeout the fetch just sits there.
    let ctl = null;
    let timer = null;
    if (timeoutMs) {
      ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), timeoutMs);
    }
    let res;
    try {
      res = await fetch(url + "/query", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`${url} → timed out after ${timeoutMs / 1000}s`);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const json = await res.json();
    // ArcGIS reports failures inside a 200 response.
    if (json.error) throw new Error(`${url} → ${json.error.message || "query error"}`);
    return json;
  }

  // Bounding box of an esriGeometryPolygon's rings, in the geometry's own SR.
  function ringsBBox(geometry) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    (geometry.rings || []).forEach(ring =>
      ring.forEach(([x, y]) => {
        if (x < xmin) xmin = x;
        if (y < ymin) ymin = y;
        if (x > xmax) xmax = x;
        if (y > ymax) ymax = y;
      })
    );
    return isFinite(xmin) ? { xmin, ymin, xmax, ymax } : null;
  }

  function padBBox(bbox, metres) {
    const midLat = (bbox.ymin + bbox.ymax) / 2;
    const dLat = metres / 111320;
    const dLon = metres / (111320 * Math.max(0.15, Math.cos((midLat * Math.PI) / 180)));
    return {
      xmin: bbox.xmin - dLon,
      ymin: bbox.ymin - dLat,
      xmax: bbox.xmax + dLon,
      ymax: bbox.ymax + dLat,
    };
  }

  // ── Distance, in metres, without a geometry engine ────────────────────────
  //
  // The map's geometryEngine is loaded in main.js and this file deliberately
  // does not ask for it — the whole feature is meant to drop out with one
  // script tag. Over a parcel and its 250 m neighbourhood, a local
  // equirectangular projection is accurate to well under a metre, so the
  // arithmetic below is enough and is the same 111320 m/degree constant
  // padBBox() already uses.
  //
  // Only ever called on features the server has already told us do NOT
  // intersect the parcel, so the minimum boundary-to-boundary distance is the
  // true distance: no containment case to worry about.

  const MAX_VERTICES = 1500; // guard against a pathological geometry

  // esri geometry → an array of vertex arrays in lon/lat, whatever its type.
  function geometryParts(g) {
    if (!g) return [];
    if (typeof g.x === "number" && typeof g.y === "number") return [[[g.x, g.y]]];
    if (g.rings) return g.rings;
    if (g.paths) return g.paths;
    return [];
  }

  // Thin a part down to at most `max` vertices, always keeping the ends.
  function thin(part, max) {
    if (part.length <= max) return part;
    const step = Math.ceil(part.length / max);
    const out = part.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== part[part.length - 1]) out.push(part[part.length - 1]);
    return out;
  }

  function projectParts(parts, lat0) {
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    return parts
      .filter(p => p && p.length)
      .map(p => thin(p, MAX_VERTICES).map(([x, y]) => [x * kx, y * 111320]));
  }

  function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Every vertex of A against every segment of B. Called both ways round by
  // minDistanceM, which is what makes it a real minimum rather than an
  // upper bound.
  function vertsToSegs(A, B) {
    let best = Infinity;
    for (const pa of A) {
      for (const [px, py] of pa) {
        for (const pb of B) {
          if (pb.length === 1) {
            best = Math.min(best, Math.hypot(px - pb[0][0], py - pb[0][1]));
            continue;
          }
          for (let i = 0; i < pb.length - 1; i++) {
            best = Math.min(best, pointToSegment(px, py, pb[i][0], pb[i][1], pb[i + 1][0], pb[i + 1][1]));
          }
        }
      }
    }
    return best;
  }

  function minDistanceM(geomA, geomB, lat0) {
    const A = projectParts(geometryParts(geomA), lat0);
    const B = projectParts(geometryParts(geomB), lat0);
    if (!A.length || !B.length) return null;
    const d = Math.min(vertsToSegs(A, B), vertsToSegs(B, A));
    return isFinite(d) ? d : null;
  }

  // Farthest corner of `bbox` from the (already projected) clicked parcel.
  // This is what sets the opportunity search distance: how far out we have to
  // look to be sure we have covered an adjacent parcel's whole extent.
  function farthestEnvelopeM(clickedParts, bbox, lat0) {
    const corners = [
      [
        [bbox.xmin, bbox.ymin],
        [bbox.xmax, bbox.ymin],
        [bbox.xmax, bbox.ymax],
        [bbox.xmin, bbox.ymax],
      ],
    ];
    const C = projectParts(corners, lat0);
    let best = 0;
    C[0].forEach(([x, y]) => {
      const d = vertsToSegs([[[x, y]]], clickedParts);
      if (isFinite(d) && d > best) best = d;
    });
    return best;
  }

  // ── Topology: the ArcGIS geometry engine, loaded on our own ──────────────
  //
  // The three tiers below need a real intersects() test, and distance cannot
  // stand in for one. Measured case, PID 2411921110001 against Winter Workshop
  // Activity 2 polygon OBJECTID 5: the server says they intersect, and they do
  // — but minDistanceM() returns 0.64 m, because the two boundaries cross
  // BETWEEN vertices and a vertex-to-segment minimum never reaches zero there.
  // Any "distance ≈ 0 means on it" rule silently mis-tiers that contribution.
  //
  // index.html loads the ArcGIS AMD loader, so this file can `require` the
  // geometry engine for itself. It does NOT go through init()'s signature and
  // main.js is not touched, so the feature still drops out by deleting one
  // file and one script tag — the property the previous commit protected.
  //
  // If the require fails, geometryEngine() resolves null and the report falls
  // back to the old fixed 250 m behaviour with a line saying so. It never
  // throws and never blocks.
  let geometryEnginePromise = null;
  function geometryEngine() {
    if (!geometryEnginePromise) {
      geometryEnginePromise = new Promise(resolve => {
        if (typeof require !== "function") return resolve(null);
        let settled = false;
        const done = v => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        // A wedged CDN must not hold the panel open.
        setTimeout(() => done(null), ADJ_TIMEOUT_MS);
        try {
          require(
            ["esri/geometry/geometryEngine", "esri/geometry/support/jsonUtils"],
            (ge, jsonUtils) => done(ge && jsonUtils ? { ge, jsonUtils } : null),
            () => done(null)
          );
        } catch (_) {
          done(null);
        }
      });
    }
    return geometryEnginePromise;
  }

  // esri REST JSON → an esri Geometry instance the engine will accept.
  function toGeometry(engine, json, kind) {
    if (!json) return null;
    try {
      return engine.jsonUtils.fromJSON({ ...json, spatialReference: { wkid: 4326 } });
    } catch (_) {
      return null;
    }
  }

  // ── Data assembly ────────────────────────────────────────────────────────

  // Total parcels in the model layer, for turning a rank into a percentile.
  // Fetched once, live — not hard-coded, because the layer is republished.
  let modelTotalPromise = null;
  function modelTotal() {
    if (!modelTotalPromise) {
      modelTotalPromise = esriQuery(MODEL_PARCEL, { where: "1=1", returnCountOnly: "true" })
        .then(j => num(j.count))
        .catch(() => null);
    }
    return modelTotalPromise;
  }

  async function fetchParcelAt(lon, lat) {
    const json = await esriQuery(PARCEL_BASE, {
      geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: "true",
      outSR: "4326",
    });
    return (json.features || [])[0] || null;
  }

  async function fetchModelScores(pid) {
    if (!pid) return null;
    const json = await esriQuery(MODEL_PARCEL, {
      where: `PID='${String(pid).replace(/'/g, "''")}'`,
      outFields: "*",
      returnGeometry: "false",
    });
    const f = (json.features || [])[0];
    return f ? f.attributes : null;
  }

  async function fetchContext(bbox) {
    const geometry = JSON.stringify({ ...bbox, spatialReference: { wkid: 4326 } });
    const jobs = CONTEXT_LAYERS.map(async layer => {
      try {
        const json = await esriQuery(layer.url, {
          geometry,
          geometryType: "esriGeometryEnvelope",
          inSR: "4326",
          spatialRel: "esriSpatialRelIntersects",
          outFields: layer.fields.join(","),
          returnGeometry: "false",
          resultRecordCount: "8",
        });
        const rows = (json.features || []).map(f => f.attributes);
        return { layer, rows, error: null };
      } catch (e) {
        return { layer, rows: [], error: e.message };
      }
    });
    return Promise.all(jobs);
  }

  // ── Parcel adjacency ─────────────────────────────────────────────────────

  /**
   * The parcels touching the clicked one, and the search distance they imply.
   *
   * ONE indexed query, against the same Parcel Base layer and the same spatial
   * index the click itself used: everything within ADJ_TOLERANCE_M of the
   * clicked polygon. That tolerance is what carries "adjacent" across a road
   * right-of-way, which is what a land manager means by the word.
   *
   * Returns, never throws:
   *   parcels          the kept neighbours, nearest first, with geometry
   *   searched         how many were kept (≤ ADJ_MAX)
   *   notSearched      how many were found and dropped by the cap
   *   more             true if the server said there were more than it sent
   *   searchDistanceM  D — how far the opportunity queries must now look
   *   clipped          true if an adjacent parcel reaches past ADJ_MAX_D_M
   */
  async function fetchAdjacentParcels(parcelGeometry, ownPid, lat0) {
    const empty = {
      parcels: [],
      searched: 0,
      notSearched: 0,
      more: false,
      searchDistanceM: NEARBY_M,
      farthestM: null,
      clipped: false,
      toleranceM: ADJ_TOLERANCE_M,
      error: null,
    };
    if (!parcelGeometry || !parcelGeometry.rings) return empty;

    let json;
    try {
      json = await esriQuery(
        PARCEL_BASE,
        {
          geometry: JSON.stringify({
            rings: parcelGeometry.rings,
            spatialReference: { wkid: 4326 },
          }),
          geometryType: "esriGeometryPolygon",
          inSR: "4326",
          spatialRel: "esriSpatialRelIntersects",
          distance: String(ADJ_TOLERANCE_M),
          units: "esriSRUnit_Meter",
          outFields: "PID,MUNIC_NM",
          returnGeometry: "true",
          outSR: "4326",
          resultRecordCount: String(ADJ_FETCH),
        },
        ADJ_TIMEOUT_MS
      );
    } catch (e) {
      return { ...empty, error: e.message };
    }

    // NOT generalized with maxAllowableOffset, deliberately. The tiering below
    // is a topological test against these rings, and a scale-dependent
    // generalization would make the same parcel report different tiers at
    // different zoom levels. Measured cost of keeping full detail: ~7 kB on a
    // typical parcel, 46 kB on the densest case in the county (121 neighbours
    // around PID 3602924210376) — cheaper than a report that is not reproducible.
    const clickedParts = projectParts(geometryParts(parcelGeometry), lat0);

    const found = (json.features || [])
      .filter(f => f.attributes && f.attributes.PID !== ownPid)
      .filter(f => f.geometry && f.geometry.rings && f.geometry.rings.length)
      .map(f => {
        const bbox = ringsBBox(f.geometry);
        return {
          pid: clean(f.attributes.PID),
          city: clean(f.attributes.MUNIC_NM),
          geometry: f.geometry,
          farM: bbox ? farthestEnvelopeM(clickedParts, bbox, lat0) : 0,
        };
      })
      .sort((a, b) => a.farM - b.farM);

    const parcels = found.slice(0, ADJ_MAX);
    const farthestM = parcels.reduce((m, p) => Math.max(m, p.farM), 0);
    const D = Math.min(ADJ_MAX_D_M, Math.max(NEARBY_M, farthestM));

    return {
      parcels,
      searched: parcels.length,
      notSearched: found.length - parcels.length,
      // The count the server returns is not the count you asked for on this
      // layer, so this flag — not arithmetic — is what "there are more" means.
      more: json.exceededTransferLimit === true,
      searchDistanceM: Math.round(D),
      farthestM: farthestM ? Math.round(farthestM) : null,
      clipped: farthestM > ADJ_MAX_D_M,
      toleranceM: ADJ_TOLERANCE_M,
      error: null,
    };
  }

  // ── Shared opportunities ─────────────────────────────────────────────────

  // Hennepin's date fields come back as epoch ms; the hosted contribution
  // layers sometimes hand back an ISO string instead. Take either, print the
  // day only — the time a form was submitted at a workshop is noise.
  function contributedOn(v) {
    if (v === null || v === undefined || v === "") return null;
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  // One contributed feature, in the shape the panel, the print view and the
  // model payload all read from.
  function opportunityRow(layer, attrs, relation, distanceMetres) {
    const a = attrs || {};
    return {
      id: layer.key + ":" + a.OBJECTID,
      type: layer.label,
      source: layer.source,
      geometryType: layer.geometry,
      organization: clean(a.organization),
      // Kept for the panel and the printed page. Stripped from the API
      // payload — see stripOpportunityContributors().
      contributor: clean(a.name),
      description: clean(a.describe_opportunity),
      feasibleInThreeYears: clean(a.three_years),
      easeOfStart: num(a.easy_start),
      priorityRating: num(a.rate_priority),
      // The polygon layer publishes rate_feasibility as a string while the
      // polyline layer publishes it as an integer. Same question, two types.
      feasibilityRating: num(a.rate_feasibility) ?? clean(a.rate_feasibility),
      whatGoesSmoothly: clean(a.what_smooth),
      whatIsChallenging: clean(a.what_challenging),
      connectionNeeds: clean(a.connection_needs),
      potentialFunder: clean(a.potential_funder),
      contributedOn: contributedOn(a.CreationDate),
      relation,
      distanceMetres,
    };
  }

  /**
   * What coalition members have put on the map on or near this parcel.
   *
   * Two queries per layer, because the two questions are different ones:
   *
   *   1. intersects the parcel polygon exactly  → "on the parcel"
   *   2. within `bufferM` of the parcel polygon → everything in range
   *
   * (2) minus (1) is "nearby", and its distance is measured here in JS from
   * the returned geometry. The server does the topology, which is the part
   * worth trusting it with; we do the arithmetic, which it will not report.
   *
   * A layer that errors, times out or is empty produces an entry in
   * `status` and nothing else. Nothing here can reject: the report is more
   * important than this section.
   */
  async function fetchOpportunities(parcelGeometry, bufferM, lat0) {
    const geometry = JSON.stringify({
      rings: parcelGeometry.rings,
      spatialReference: { wkid: 4326 },
    });

    const jobs = OPPORTUNITY_LAYERS.map(async layer => {
      const outFields = OPP_COMMON_FIELDS.concat(OPP_SCHEMA_FIELDS[layer.schema]).join(",");
      const base = {
        geometry,
        geometryType: "esriGeometryPolygon",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields,
        resultRecordCount: "25",
      };
      try {
        const [onJson, nearJson] = await Promise.all([
          esriQuery(layer.url, { ...base, returnGeometry: "false" }, OPP_TIMEOUT_MS),
          esriQuery(
            layer.url,
            {
              ...base,
              distance: String(bufferM),
              units: "esriSRUnit_Meter",
              returnGeometry: "true",
              outSR: "4326",
            },
            OPP_TIMEOUT_MS
          ),
        ]);

        const onFeatures = onJson.features || [];
        const onIds = new Set(onFeatures.map(f => f.attributes.OBJECTID));
        const rows = onFeatures.map(f => opportunityRow(layer, f.attributes, "on the parcel", 0));

        (nearJson.features || []).forEach(f => {
          if (onIds.has(f.attributes.OBJECTID)) return;
          const d = minDistanceM(f.geometry, parcelGeometry, lat0);
          rows.push(
            opportunityRow(layer, f.attributes, "nearby", d === null ? null : Math.round(d))
          );
        });

        return { layer, rows, error: null, truncated: onFeatures.length >= 25 };
      } catch (e) {
        return { layer, rows: [], error: e.message, truncated: false };
      }
    });

    const results = await Promise.all(jobs);
    const all = [];
    results.forEach(r => all.push(...r.rows));

    // On the parcel first, then by how far away, then by organization so the
    // order is stable between two loads of the same parcel.
    const rank = r => (r.relation === "on the parcel" ? 0 : 1);
    all.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.distanceMetres ?? 1e9) - (b.distanceMetres ?? 1e9) ||
        String(a.organization || "").localeCompare(String(b.organization || ""))
    );

    return {
      bufferMetres: bufferM,
      note:
        "Opportunities are what NRPC coalition members contributed to the map themselves. " +
        "'On the parcel' means the contributed geometry intersects the parcel boundary; " +
        "'nearby' is the straight-line distance from the parcel boundary to the nearest " +
        "point of the contribution. These are proposals and observations, not commitments.",
      items: all,
      onParcelCount: all.filter(r => r.relation === "on the parcel").length,
      nearbyCount: all.filter(r => r.relation === "nearby").length,
      organizations: [...new Set(all.map(r => r.organization).filter(Boolean))],
      layerStatus: results.map(r => ({
        layer: r.layer.label,
        source: r.layer.source,
        error: r.error,
        count: r.rows.length,
        truncated: r.truncated,
      })),
      unavailable: results.filter(r => r.error).map(r => r.layer.label),
    };
  }

  // Contributor names are real people who filled in a workshop form. The
  // organization is the actionable field for a brief; the individual is not,
  // so they go to the panel and the printed page but never to the model —
  // the same call the owner-name fields already make.
  function stripOpportunityContributors(opps) {
    if (!opps) return opps;
    return {
      ...opps,
      items: opps.items.map(({ contributor, ...rest }) => rest),
      contributorNamesWithheld:
        "Names of the individuals who contributed each opportunity were withheld from this request.",
    };
  }

  /**
   * Everything we know about the clicked parcel, in one plain object. This is
   * both what the panel renders and (minus the owner fields, unless asked)
   * what gets sent to the model. One shape, one source of truth.
   */
  async function assembleFacts(feature, lon, lat) {
    if (!feature) return null;

    const a = feature.attributes;
    const bbox = feature.geometry ? ringsBBox(feature.geometry) : null;

    const midLat = bbox ? (bbox.ymin + bbox.ymax) / 2 : lat;

    const [scores, context, total, opportunities] = await Promise.all([
      fetchModelScores(a.PID),
      bbox ? fetchContext(padBBox(bbox, CONTEXT_BUFFER_M)) : Promise.resolve([]),
      modelTotal(),
      // Same 250 m as the context layers, but measured from the parcel
      // boundary itself rather than from a padded bounding box — these are
      // few enough to buffer properly, and a distance in metres is the whole
      // point of the section.
      feature.geometry && feature.geometry.rings
        ? fetchOpportunities(feature.geometry, CONTEXT_BUFFER_M, midLat).catch(() => null)
        : Promise.resolve(null),
    ]);

    // PARCEL_AREA is square feet: for PID 1111823340002 it reads 880848.5 while
    // the layer's own SHAPE.STArea() reads 81765.4 m². 880848.5 / 43560 = 20.22
    // acres and 81765.4 / 4046.86 = 20.21 acres — the same parcel, so the field
    // is ft². The conversion below is that arithmetic, nothing more.
    const areaSqFt = num(a.PARCEL_AREA);
    const acres = areaSqFt === null ? null : areaSqFt / SQFT_PER_ACRE;

    const rank = scores ? num(scores.Rank) : null;
    // Share of the county's ranked parcels that score at least as high as this
    // one — i.e. "this parcel is in the top X%". Rank 1 is the best parcel.
    const topPercent = rank !== null && total ? (rank / total) * 100 : null;

    const houseNo = clean(a.HOUSE_NO);
    const street = clean(a.STREET_NM);
    const address = houseNo && street ? `${houseNo} ${street}` : street || null;

    return {
      clickedAt: { lat, lon },
      identity: {
        pid: clean(a.PID),
        address,
        city: clean(a.MUNIC_NM),
        zip: clean(a.ZIP_CD),
        legalAddition: clean(a.ABBREV_ADDN_NM),
        lot: clean(a.LOT),
        block: clean(a.BLOCK),
      },
      owner: {
        ownerName: clean(a.OWNER_NM),
        taxpayerName: clean(a.TAXPAYER_NM),
        mailingCity: clean(a.MAILING_MUNIC_NM),
      },
      land: {
        parcelAreaSqFt: areaSqFt,
        parcelAcres: acres === null ? null : Number(acres.toFixed(2)),
        propertyType: clean(a.PROPERTY_TYPE_CD1_NAME),
        homesteadStatus: clean(a.HMSTD_CD1_NAME),
        yearBuilt: zeroStrOrNull(a.BUILD_YR),
        taxForfeitLand: clean(a.FORFEIT_LAND_IND),
        schoolDistrict: clean(a.SCHOOL_DIST_NO),
        watershedNo: clean(a.WATERSHED_NO),
      },
      value: {
        estimatedMarketValueTotal: num(a.MKT_VAL_TOT),
        estimatedLandValue: num(a.EST_LAND_MKT_VAL1),
        estimatedBuildingValue: num(a.EST_BLDG_MKT_VAL1),
        totalTax: num(a.TAX_TOT),
        lastSaleDateYYYYMM: clean(a.SALE_DATE),
        lastSalePrice: num(a.SALE_PRICE),
        lastSaleType: clean(a.SALE_CODE_NAME),
      },
      model: scores
        ? {
            note:
              "Hennepin County Parcel Prioritization Model. Rank 1 is the highest-priority " +
              "parcel in the county; a larger Overall Value goes with a smaller Rank number.",
            rank,
            parcelsRanked: total,
            topPercentOfCounty:
              topPercent === null ? null : Number(topPercent.toFixed(topPercent < 1 ? 3 : 1)),
            scores: SCORE_FIELDS.reduce((acc, [field, alias]) => {
              acc[alias] = num(scores[field]);
              return acc;
            }, {}),
          }
        : null,
      contextBufferMetres: CONTEXT_BUFFER_M,
      context: context.map(({ layer, rows, error }) => ({
        layer: layer.label,
        error,
        count: rows.length,
        truncated: rows.length === 8,
        names: [...new Set(rows.map(r => clean(r[layer.nameField])).filter(Boolean))],
        detail: rows.slice(0, 4),
      })),
      sharedOpportunities: opportunities,
    };
  }

  // ── Prompt ───────────────────────────────────────────────────────────────

  const SYSTEM_PROMPT = [
    "You write short site-assessment briefs for staff at the Northern Regional Planning",
    "Collaborative and Hennepin County who are deciding which parcels to pursue for",
    "conservation, restoration, or protection.",
    "",
    "You will be given a JSON object of everything the map could pull for one parcel:",
    "county assessment attributes, the Hennepin County Parcel Prioritization Model",
    "scores, the natural-resource layers that fall on or near the parcel, and the",
    "opportunities NRPC coalition members have themselves contributed to the map on or",
    "near it.",
    "",
    "Rules:",
    "- Use ONLY the supplied JSON. Do not add facts, history, ecology, or numbers from",
    "  anywhere else, and do not estimate a number the JSON does not contain.",
    "- Where a field is null or missing and it matters, say plainly that it is missing.",
    "- Context layers were matched against the parcel's bounding box padded by the given",
    "  buffer, so a hit means 'on or near', never 'inside'. Word it that way.",
    "- A count marked truncated is a floor, not a total.",
    "- sharedOpportunities are proposals and observations that partner organisations",
    "  typed into the map, not funded projects, commitments or county policy. Attribute",
    "  each one to the organisation that contributed it and say how far away it is. Never",
    "  merge two contributions into one claim.",
    "- If sharedOpportunities is null or its items list is empty, say in one sentence that",
    "  no partner has recorded an opportunity here yet, and do not speculate about why.",
    "- Round figures for readability but never change them.",
    "- No preamble, no sign-off, no offer to help further.",
    "",
    "Write in Markdown, under 420 words, in exactly these sections:",
    "",
    "## Summary",
    "Two or three sentences: what this parcel is and whether it looks worth pursuing.",
    "",
    "## Priority score",
    "What the model says, what the rank and percentile mean in plain words, and which",
    "component scores are driving the result.",
    "",
    "## Setting",
    "The natural-resource and ownership context nearby, and what it implies.",
    "",
    "## Shared opportunities",
    "What partner organisations have already flagged here — who contributed it, what they",
    "described, how far from the parcel, and whether it suggests someone to call. One",
    "sentence saying there are none if the list is empty.",
    "",
    "## What to check next",
    "Two to four concrete next steps for a planner, each tied to something specific in",
    "the data — including anything the data could not answer.",
  ].join("\n");

  // The panel and the printed page can afford every field of every
  // contribution. The prompt cannot, and does not need to: what the model has
  // to write a paragraph is who, what, how far, and whether it is live.
  const OPP_PROMPT_LIMIT = 12;
  const OPP_DESCRIPTION_CHARS = 400;

  function compactOpportunities(opps) {
    if (!opps) return null;
    const items = opps.items.slice(0, OPP_PROMPT_LIMIT).map(r => {
      const out = {
        type: r.type,
        organization: r.organization,
        description:
          r.description && r.description.length > OPP_DESCRIPTION_CHARS
            ? r.description.slice(0, OPP_DESCRIPTION_CHARS) + "…"
            : r.description,
        relation: r.relation,
        distanceMetres: r.distanceMetres,
        contributedOn: r.contributedOn,
        feasibleInThreeYears: r.feasibleInThreeYears,
        easeOfStart: r.easeOfStart,
        priorityRating: r.priorityRating,
        feasibilityRating: r.feasibilityRating,
        connectionNeeds: r.connectionNeeds,
        potentialFunder: r.potentialFunder,
      };
      // Drop the empty keys rather than send a wall of nulls the model then
      // has to reason about.
      Object.keys(out).forEach(k => {
        if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
      });
      return out;
    });
    return {
      bufferMetres: opps.bufferMetres,
      note: opps.note,
      onParcelCount: opps.onParcelCount,
      nearbyCount: opps.nearbyCount,
      organizations: opps.organizations,
      itemsShown: items.length,
      itemsTotal: opps.items.length,
      truncated: opps.items.length > items.length,
      unavailableLayers: opps.unavailable,
      items,
    };
  }

  function buildUserMessage(facts, includeOwner) {
    const payload = JSON.parse(JSON.stringify(facts));
    if (!includeOwner) {
      delete payload.owner;
      payload.ownerWithheld =
        "Owner and taxpayer names were deliberately withheld from this request.";
    }
    payload.sharedOpportunities = stripOpportunityContributors(
      compactOpportunities(facts.sharedOpportunities)
    );
    return (
      "Parcel data:\n\n```json\n" +
      JSON.stringify(payload, null, 2) +
      "\n```\n\nWrite the brief."
    );
  }

  // ── Anthropic call ───────────────────────────────────────────────────────

  async function streamReport({ apiKey, model, system, user, onText, signal }) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Required for a browser to call the API directly. It tells the API to
        // send CORS headers; it also means the key lives in the browser, which
        // is exactly the trade this feature makes on purpose.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }],
        stream: true,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.error?.message || JSON.stringify(j);
      } catch (_) {
        detail = await res.text().catch(() => "");
      }
      const hint =
        res.status === 401
          ? " — the key was rejected. Use “Forget key” and paste it again."
          : res.status === 429
          ? " — rate limited; wait a moment and retry."
          : "";
      throw new Error(`Anthropic API ${res.status}${hint}\n${detail}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopReason = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt;
          try {
            evt = JSON.parse(raw);
          } catch (_) {
            continue;
          }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            onText(evt.delta.text);
          } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason;
          } else if (evt.type === "error") {
            throw new Error(evt.error?.message || "stream error");
          }
        }
      }
    }
    return stopReason;
  }

  // ── Minimal Markdown → HTML ──────────────────────────────────────────────
  // Enough for the headings, bullets and bold the prompt asks for. Everything
  // is escaped first, so model output can never inject markup.

  function renderMarkdown(md) {
    const out = [];
    let inList = false;
    const inline = s =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");

    md.split("\n").forEach(line => {
      const t = line.trim();
      const bullet = t.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        return;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (!t) return;
      const h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      else out.push(`<p>${inline(t)}</p>`);
    });
    if (inList) out.push("</ul>");
    return out.join("");
  }

  // ── Fact table for the panel ─────────────────────────────────────────────

  function factRows(facts) {
    const f = facts;
    const rows = [
      ["PID", f.identity.pid],
      ["Address", [f.identity.address, f.identity.city].filter(Boolean).join(", ") || null],
      ["Size", f.land.parcelAcres === null ? null : `${f.land.parcelAcres} acres`],
      ["Property type", f.land.propertyType],
      ["Homestead", f.land.homesteadStatus],
      ["Year built", f.land.yearBuilt],
      ["Est. market value", money(f.value.estimatedMarketValueTotal)],
      ["Est. land value", money(f.value.estimatedLandValue)],
    ];
    if (f.model) {
      rows.push([
        "Model rank",
        f.model.rank === null
          ? null
          : `${f.model.rank.toLocaleString("en-US")}` +
            (f.model.parcelsRanked ? ` of ${f.model.parcelsRanked.toLocaleString("en-US")}` : "") +
            (f.model.parcelsRanked ? ` (top ${topPct(f.model.rank, f.model.parcelsRanked)})` : ""),
      ]);
      rows.push(["Overall value", num(f.model.scores["Overall Value"])?.toFixed(3) ?? null]);
    } else {
      rows.push(["Model rank", "not in the prioritization model layer"]);
    }
    const hits = f.context.filter(c => c.count > 0);
    rows.push([
      `Within ${f.contextBufferMetres} m`,
      hits.length ? hits.map(c => `${c.layer} (${c.count}${c.truncated ? "+" : ""})`).join("; ") : "nothing from the context layers",
    ]);
    rows.push(["Shared opportunities", opportunitySummary(f.sharedOpportunities, f.contextBufferMetres)]);
    return rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  }

  // ── Shared opportunities, rendered ───────────────────────────────────────

  // The one-line version, used in the panel's fact table and again as the
  // print section's opening line.
  function opportunitySummary(opps, bufferM) {
    if (!opps) return "could not be checked";
    const dead = opps.unavailable.length;
    if (!opps.items.length) {
      if (dead === opps.layerStatus.length) {
        return `could not be checked — all ${dead} contribution layers unreachable`;
      }
      return (
        `none recorded within ${opps.bufferMetres || bufferM} m` +
        (dead ? ` (${dead} of ${opps.layerStatus.length} layers unreachable)` : "")
      );
    }
    const bits = [];
    if (opps.onParcelCount) bits.push(`${opps.onParcelCount} on the parcel`);
    if (opps.nearbyCount) bits.push(`${opps.nearbyCount} within ${opps.bufferMetres} m`);
    return bits.join(", ");
  }

  // Nothing found is not the same fact as nothing could be checked, and every
  // layer failing is not the same as one failing. All three read differently.
  function opportunityEmptyText(opps) {
    const dead = opps.unavailable.length;
    if (dead && dead === opps.layerStatus.length) {
      return (
        "None of the NRPC contribution layers could be reached, so this is unknown " +
        "rather than empty. Everything else in this report is unaffected."
      );
    }
    return (
      `No shared opportunities recorded within ${opps.bufferMetres} m.` +
      (dead
        ? ` ${dead} of ${opps.layerStatus.length} contribution layers could not be reached, so treat that as a floor.`
        : "")
    );
  }

  // "on the parcel" or "nearby · 84 m".
  function opportunityWhere(r) {
    if (r.relation === "on the parcel") return "on the parcel";
    if (r.distanceMetres === null || r.distanceMetres === undefined) return "nearby";
    return `nearby · ${r.distanceMetres.toLocaleString("en-US")} m`;
  }

  // The detail lines under a contribution's description — only the fields
  // that layer's schema actually filled in.
  function opportunityDetails(r) {
    return OPP_DETAIL_LABELS.map(([key, label]) => [label, r[key]]).filter(
      ([, v]) => v !== null && v !== undefined && v !== ""
    );
  }

  // The panel's own block: a card per contribution, on-parcel ones first.
  // The panel is 400 px wide, so it shows the first PANEL_OPP_LIMIT and points
  // at the PDF for the rest rather than becoming a scroll of its own.
  const PANEL_OPP_LIMIT = 10;

  function opportunityPanelBlock(opps, bufferM) {
    const box = el("div", { className: "pr-opps" });
    box.append(
      el("div", { className: "pr-opps-head" },
        el("span", { className: "pr-opps-title", textContent: "Shared opportunities" }),
        el("span", {
          className: "pr-opps-sub",
          textContent: `NRPC coalition contributions within ${bufferM} m`,
        })
      )
    );

    if (!opps) {
      box.append(
        el("div", {
          className: "pr-opps-empty",
          textContent:
            "The NRPC contribution layers could not be checked for this parcel. Everything else above is unaffected.",
        })
      );
      return box;
    }

    if (!opps.items.length) {
      box.append(el("div", { className: "pr-opps-empty", textContent: opportunityEmptyText(opps) }));
    } else {
      const list = el("ul", { className: "pr-opp-list" });
      opps.items.slice(0, PANEL_OPP_LIMIT).forEach(r => {
        const li = el("li", { className: "pr-opp" });
        li.append(
          el("div", { className: "pr-opp-top" },
            el("span", {
              className: "pr-opp-org",
              textContent: r.organization || "Organization not given",
            }),
            el("span", {
              className:
                "pr-opp-where" + (r.relation === "on the parcel" ? " pr-opp-on" : ""),
              textContent: opportunityWhere(r),
            })
          ),
          el("div", { className: "pr-opp-type", textContent: r.type })
        );
        if (r.description) {
          li.append(el("div", { className: "pr-opp-desc", textContent: r.description }));
        }
        const details = opportunityDetails(r);
        if (details.length) {
          li.append(
            el("div", {
              className: "pr-opp-meta",
              textContent: details.map(([k, v]) => `${k}: ${v}`).join(" · "),
            })
          );
        }
        const by = [r.contributor, r.contributedOn].filter(Boolean).join(" · ");
        if (by) li.append(el("div", { className: "pr-opp-by", textContent: by }));
        list.append(li);
      });
      box.append(list);
      if (opps.items.length > PANEL_OPP_LIMIT) {
        box.append(
          el("div", {
            className: "pr-opps-empty",
            textContent: `+ ${opps.items.length - PANEL_OPP_LIMIT} more — all of them are on the PDF.`,
          })
        );
      }
    }

    // Which layers failed, once — the empty text above already carries the
    // headline when there is nothing to list.
    if (opps.unavailable.length && opps.items.length) {
      box.append(
        el("div", {
          className: "pr-warn",
          textContent:
            "Contribution layers unreachable: " +
            opps.unavailable.join(", ") +
            ". The list above is a floor.",
        })
      );
    }
    return box;
  }

  // ── Print view — the "Export as PDF" path ────────────────────────────────
  //
  // No PDF library, by choice. "Export as PDF" builds a print-only copy of the
  // report into #pr-print and calls window.print(); the browser's own "Save as
  // PDF" destination writes the file. A print stylesheet hides the map, the
  // panel and every control, so what lands on the page is the report and
  // nothing else.
  //
  // Why not jsPDF/html2canvas: html2canvas rasterises the panel, so the text
  // stops being text — unselectable, unsearchable, and soft on any printer —
  // and both libraries would add a pinned CDN script to a feature that today
  // has no dependency at all. Printing keeps real vector text, lets the browser
  // paginate and honour the user's paper size, and costs exactly one extra
  // click in the print dialog. The button label says so out loud.

  const SOURCE_LINE =
    "Sources, queried live from ArcGIS REST at the moment of export: Hennepin County " +
    "Parcel Base (assessment attributes); Hennepin County Parcel Prioritization Model " +
    "Results, parcel view (component scores and county rank); and nine natural-resource " +
    "context layers — county parks, DNR public water basins, regional trails, Met " +
    "Council ecologically significant and sensitive areas, Met Council protection and " +
    "improvement opportunities, publicly owned and tax-exempt parcels, and BWSR " +
    "watershed districts. Shared opportunities come from the five contribution layers " +
    "in the map's NRPC Data group: the two NRPC Opportunity Layers the Contribute panel " +
    "writes to, and the three Winter Workshop 2025 layers.";

  function fmtDateTime(d) {
    try {
      return d.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
    } catch (_) {
      return d.toISOString();
    }
  }

  // Hennepin publishes SALE_DATE as YYYYMM.
  function saleDate(v) {
    const s = clean(v);
    if (!s) return null;
    return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
  }

  // A label/value table, with the empty rows dropped. Returns null if nothing
  // survived, so the caller can skip the whole section.
  function printTable(rows) {
    const kept = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!kept.length) return null;
    const t = el("table", { className: "pr-print-table" });
    kept.forEach(([k, v]) => {
      const tr = el("tr");
      tr.append(el("th", { textContent: k }), el("td", { textContent: String(v) }));
      t.append(tr);
    });
    return t;
  }

  /**
   * Fill `root` with the printable document: identity, facts, model scores,
   * context layers, the generated brief, when it was made and where it came
   * from. `reportHTML` is what renderMarkdown() already escaped and rendered,
   * so nothing here re-introduces raw model output.
   */
  function buildPrintDoc(root, facts, reportHTML, meta) {
    const f = facts;
    root.innerHTML = "";

    const section = (heading, ...kids) => {
      const kept = kids.filter(Boolean);
      if (!kept.length) return;
      const s = el("section", { className: "pr-print-section" });
      s.append(el("h2", { textContent: heading }), ...kept);
      root.append(s);
    };

    // -- header --
    // Hennepin writes an all-zero ZIP_CD where it has none; printing "00000"
    // under the address would read as a real zip.
    const zip = zeroStrOrNull(f.identity.zip);
    const where =
      [f.identity.address, f.identity.city, zip].filter(Boolean).join(", ") ||
      "No street address on the county record";
    const head = el("header", { className: "pr-print-head" });
    head.append(
      el("div", { className: "pr-print-kicker", textContent: "NRPC Interactive Map · Parcel Report" }),
      el("h1", { className: "pr-print-title", textContent: "PID " + (f.identity.pid || "unknown") }),
      el("div", { className: "pr-print-sub", textContent: where }),
      el("div", {
        className: "pr-print-meta",
        textContent:
          "Generated " +
          fmtDateTime(meta.generatedAt) +
          (meta.model ? " · brief written by " + meta.model : "") +
          " · clicked point " +
          f.clickedAt.lat.toFixed(5) +
          ", " +
          f.clickedAt.lon.toFixed(5),
      })
    );
    root.append(head);

    // -- the parcel --
    const legal = [
      f.identity.legalAddition,
      f.identity.lot ? "Lot " + f.identity.lot : null,
      f.identity.block ? "Block " + f.identity.block : null,
    ]
      .filter(Boolean)
      .join(", ");
    // No sale date means no sale on the record — a bare "$0" there would read
    // as a fact rather than as an absence.
    const soldOn = saleDate(f.value.lastSaleDateYYYYMM);
    const sale = soldOn
      ? [soldOn, money(f.value.lastSalePrice), f.value.lastSaleType].filter(Boolean).join(" · ")
      : null;

    section(
      "The parcel",
      printTable([
        ["PID", f.identity.pid],
        ["Address", where],
        ["Legal description", legal],
        [
          "Size",
          f.land.parcelAcres === null
            ? null
            : `${f.land.parcelAcres} acres (${Math.round(f.land.parcelAreaSqFt).toLocaleString("en-US")} sq ft)`,
        ],
        ["Property type", f.land.propertyType],
        ["Homestead", f.land.homesteadStatus],
        ["Year built", f.land.yearBuilt],
        ["Tax-forfeit land", f.land.taxForfeitLand],
        ["School district", f.land.schoolDistrict],
        ["Watershed no.", f.land.watershedNo],
        ["Est. market value", money(f.value.estimatedMarketValueTotal)],
        ["Est. land value", money(f.value.estimatedLandValue)],
        ["Est. building value", money(f.value.estimatedBuildingValue)],
        ["Total tax", money(f.value.totalTax)],
        ["Last sale", sale],
      ])
    );

    // -- the model --
    if (f.model) {
      const rankText =
        f.model.rank === null
          ? "not ranked"
          : f.model.rank.toLocaleString("en-US") +
            (f.model.parcelsRanked
              ? ` of ${f.model.parcelsRanked.toLocaleString("en-US")} ranked parcels ` +
                `(top ${topPct(f.model.rank, f.model.parcelsRanked)} of the county)`
              : "");
      section(
        "Prioritization model",
        printTable([
          ["County rank", rankText],
          ...SCORE_FIELDS.map(([, alias]) => {
            const v = num(f.model.scores[alias]);
            return [alias, v === null ? null : v.toFixed(3)];
          }),
        ]),
        el("p", { className: "pr-print-note", textContent: f.model.note })
      );
    } else {
      section(
        "Prioritization model",
        el("p", {
          className: "pr-print-note",
          textContent: "This parcel is not present in the prioritization model layer.",
        })
      );
    }

    // -- context --
    section(
      `Context within ${f.contextBufferMetres} m`,
      printTable(
        f.context.map(c => {
          let v;
          if (c.error) v = "layer unavailable at export time";
          else if (!c.count) v = "none";
          else
            v =
              `${c.count}${c.truncated ? "+" : ""}` +
              (c.names.length ? " — " + c.names.join("; ") : "");
          return [c.layer, v];
        })
      ),
      el("p", {
        className: "pr-print-note",
        textContent:
          `Context features are matched against the parcel's bounding box padded by ` +
          `${f.contextBufferMetres} m, so a hit means on or near the parcel, never inside it. ` +
          "A count marked + is a floor: the query returns at most eight features per layer.",
      })
    );

    // -- shared opportunities --
    // Unlike the context table this one is not label/value: each contribution
    // is a small block, because the description is the point of it.
    const opps = f.sharedOpportunities;
    const oppSection = el("section", { className: "pr-print-section" });
    oppSection.append(el("h2", { textContent: "Shared opportunities" }));

    if (!opps) {
      oppSection.append(
        el("p", {
          className: "pr-print-note",
          textContent:
            "The NRPC contribution layers could not be reached at export time, so this " +
            "section is unknown rather than empty.",
        })
      );
    } else if (!opps.items.length) {
      oppSection.append(
        el("p", { className: "pr-print-lead", textContent: opportunityEmptyText(opps) })
      );
    } else {
      oppSection.append(
        el("p", {
          className: "pr-print-lead",
          textContent:
            opportunitySummary(opps, f.contextBufferMetres) +
            ", contributed by " +
            (opps.organizations.length
              ? opps.organizations.join(", ")
              : "organisations not named on the record") +
            ".",
        })
      );
      opps.items.forEach(r => {
        const item = el("div", { className: "pr-opp-print" });
        item.append(
          el("div", { className: "pr-opp-print-head" },
            el("span", {
              className: "pr-opp-print-org",
              textContent: r.organization || "Organization not given",
            }),
            el("span", { className: "pr-opp-print-where", textContent: opportunityWhere(r) })
          ),
          el("div", { className: "pr-opp-print-type", textContent: r.type + " · " + r.source })
        );
        if (r.description) {
          item.append(el("div", { className: "pr-opp-print-desc", textContent: r.description }));
        }
        const details = opportunityDetails(r);
        if (details.length) {
          item.append(
            el("div", {
              className: "pr-opp-print-meta",
              textContent: details.map(([k, v]) => `${k}: ${v}`).join(" · "),
            })
          );
        }
        const by = [r.contributor, r.contributedOn ? "contributed " + r.contributedOn : null]
          .filter(Boolean)
          .join(" · ");
        if (by) item.append(el("div", { className: "pr-opp-print-by", textContent: by }));
        oppSection.append(item);
      });
      if (opps.unavailable.length) {
        oppSection.append(
          el("p", {
            className: "pr-print-note",
            textContent:
              "Unreachable at export time: " + opps.unavailable.join(", ") + ". The list above is a floor.",
          })
        );
      }
    }
    // Skip the boilerplate when the section has nothing to qualify.
    if (opps && (opps.items.length || !opps.unavailable.length)) {
      oppSection.append(
        el("p", {
          className: "pr-print-note",
          textContent:
            opps.note +
            " Distances are straight-line from the parcel boundary; they are not travel distances.",
        })
      );
    }
    root.append(oppSection);

    // -- the brief --
    if (reportHTML) {
      section(
        "Site brief",
        el("div", { className: "pr-print-brief", innerHTML: reportHTML })
      );
    }

    // -- provenance --
    const foot = el("footer", { className: "pr-print-foot" });
    foot.append(
      el("p", { textContent: SOURCE_LINE }),
      el("p", {
        textContent:
          "Owner and taxpayer names are on the county record but are deliberately left " +
          "out of this export, as they are left out of the request sent to the model. " +
          "The names of the people who contributed each shared opportunity are printed " +
          "here, because they are who to call — but they too are withheld from the model.",
      }),
      el("p", {
        textContent:
          "The brief is written by a language model from the data above and is not a " +
          "substitute for a site visit, a survey, or a title search.",
      })
    );
    root.append(foot);
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  function init({ view, Graphic, GraphicsLayer }) {
    if (!view) return;

    const highlightLayer = new GraphicsLayer({ listMode: "hide" });
    view.map.add(highlightLayer);

    const HIGHLIGHT_SYMBOL = {
      type: "simple-fill",
      color: [255, 170, 0, 0.22],
      outline: { color: [255, 140, 0, 1], width: 2 },
    };

    // -- panel shell --
    const panel = el("div", { id: "parcel-report-panel" });

    const header = el("div", { id: "pr-header" });
    const title = el("span", { id: "pr-title", textContent: "Parcel Report" });
    const closeBtn = el("button", { id: "pr-close", textContent: "×", title: "Close" });
    header.append(title, closeBtn);

    const body = el("div", { id: "pr-body" });

    const hint = el("div", {
      className: "pr-hint",
      textContent: "Click a parcel on the map to load its details.",
    });
    body.append(hint);

    const factsBox = el("div", { id: "pr-facts", className: "hidden" });
    const actions = el("div", { id: "pr-actions", className: "hidden" });
    const reportBox = el("div", { id: "pr-report", className: "hidden" });

    // Appears only once a report has finished rendering.
    const exportRow = el("div", { id: "pr-export-row", className: "hidden" });
    const exportBtn = el("button", { id: "pr-export", textContent: "Export as PDF" });
    const exportNote = el("span", {
      className: "pr-export-note",
      textContent: "Pick “Save as PDF” as the destination in the print dialog.",
    });
    exportRow.append(exportBtn, exportNote);

    body.append(factsBox, actions, reportBox, exportRow);

    // The printable document. Lives outside the panel, hidden on screen, and
    // is the only thing the print stylesheet leaves visible.
    const printRoot = el("div", { id: "pr-print" });
    document.body.appendChild(printRoot);

    // -- generate / owner toggle --
    const generateBtn = el("button", { id: "pr-generate", textContent: "Generate report" });
    const ownerWrap = el("label", { className: "pr-owner-toggle" });
    const ownerCb = el("input", { type: "checkbox", id: "pr-include-owner" });
    ownerWrap.append(
      ownerCb,
      el("span", {
        textContent: "Send owner name to Claude",
        title:
          "Owner and taxpayer names are public record but are withheld from the API request by default.",
      })
    );
    const modelSelect = el("select", { id: "pr-model", title: "Model" });
    MODEL_CHOICES.forEach(([value, label]) =>
      modelSelect.append(el("option", { value, textContent: label }))
    );
    actions.append(generateBtn, modelSelect, ownerWrap);

    // -- key form --
    const keyForm = el("form", { id: "pr-key-form", className: "hidden" });
    const keyLabel = el("div", {
      className: "pr-key-label",
      textContent: "Anthropic API key",
    });
    const keyNote = el("div", {
      className: "pr-key-note",
      textContent:
        "Kept in this browser's localStorage only. Never committed, never sent anywhere but api.anthropic.com.",
    });
    const keyInput = el("input", {
      type: "password",
      id: "pr-key-input",
      placeholder: "sk-ant-…",
      autocomplete: "off",
      spellcheck: false,
    });
    const keySave = el("button", { type: "submit", id: "pr-key-save", textContent: "Save & generate" });
    keyForm.append(keyLabel, keyInput, keySave, keyNote);
    body.append(keyForm);

    const footer = el("div", { id: "pr-footer" });
    const forgetBtn = el("button", { id: "pr-forget", className: "pr-link", textContent: "Forget key" });
    const status = el("span", { id: "pr-status" });
    footer.append(status, forgetBtn);

    const tab = el("button", { id: "pr-tab", title: "Parcel Report", textContent: "◀" });

    panel.append(header, body, footer, tab);
    document.body.appendChild(panel);

    // -- state --
    let facts = null;
    let busy = false;
    let abortCtl = null;
    // The finished report: its Markdown, the HTML we rendered from it, when it
    // finished, and which model wrote it. Null until one completes — which is
    // exactly the condition the export button appears under.
    let lastReport = null;

    const getKey = () => {
      try {
        return localStorage.getItem(STORAGE_KEY) || "";
      } catch (_) {
        return "";
      }
    };
    const setKey = k => {
      try {
        localStorage.setItem(STORAGE_KEY, k);
      } catch (_) {
        /* private mode — the key just won't persist */
      }
    };
    const getModel = () => {
      try {
        return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
      } catch (_) {
        return DEFAULT_MODEL;
      }
    };

    modelSelect.value = getModel();
    modelSelect.addEventListener("change", () => {
      try {
        localStorage.setItem(MODEL_KEY, modelSelect.value);
      } catch (_) {}
    });

    function openPanel() {
      panel.classList.add("open");
      tab.textContent = "▶";
    }
    function closePanel() {
      panel.classList.remove("open");
      tab.textContent = "◀";
    }
    function setStatus(text, kind) {
      status.textContent = text || "";
      status.className = kind ? `pr-${kind}` : "";
    }
    function updateFooter() {
      forgetBtn.classList.toggle("hidden", !getKey());
    }

    function showFacts(f) {
      factsBox.innerHTML = "";
      const table = el("table", { className: "pr-table" });
      factRows(f).forEach(([k, v]) => {
        const tr = el("tr");
        tr.append(el("th", { textContent: k }), el("td", { textContent: String(v) }));
        table.append(tr);
      });
      factsBox.append(table);
      factsBox.append(opportunityPanelBlock(f.sharedOpportunities, f.contextBufferMetres));
      const errs = f.context.filter(c => c.error);
      if (errs.length) {
        factsBox.append(
          el("div", {
            className: "pr-warn",
            textContent:
              "Could not reach: " + errs.map(e => e.layer).join(", ") + ". Report will say so.",
          })
        );
      }
      factsBox.classList.remove("hidden");
      actions.classList.remove("hidden");
      hint.classList.add("hidden");
    }

    /**
     * The one place a report is declared finished. Both the streamed path and
     * the dev hook go through here, so "the export button is showing" always
     * means "this exact render succeeded".
     */
    function showReport(markdown, model) {
      lastReport = {
        markdown,
        html: renderMarkdown(markdown),
        generatedAt: new Date(),
        model: model || modelSelect.value,
      };
      reportBox.innerHTML = lastReport.html;
      reportBox.classList.remove("hidden");
      exportRow.classList.remove("hidden");
    }

    function clearReport() {
      lastReport = null;
      reportBox.innerHTML = "";
      reportBox.classList.add("hidden");
      exportRow.classList.add("hidden");
      printRoot.innerHTML = "";
      document.body.classList.remove("pr-print-ready");
    }

    async function loadParcel(lon, lat) {
      if (abortCtl) abortCtl.abort();
      facts = null;
      clearReport();
      keyForm.classList.add("hidden");
      factsBox.classList.add("hidden");
      actions.classList.add("hidden");
      hint.classList.remove("hidden");
      hint.textContent = "Loading parcel…";
      openPanel();
      highlightLayer.removeAll();

      try {
        const feature = await fetchParcelAt(lon, lat);
        if (!feature) {
          hint.textContent = "No Hennepin County parcel at that point.";
          return;
        }
        if (feature.geometry) {
          highlightLayer.add(
            new Graphic({
              geometry: { type: "polygon", rings: feature.geometry.rings, spatialReference: { wkid: 4326 } },
              symbol: HIGHLIGHT_SYMBOL,
            })
          );
        }
        facts = await assembleFacts(feature, lon, lat);
        showFacts(facts);
        setStatus("");
      } catch (e) {
        hint.textContent = `Could not load the parcel: ${e.message}`;
      }
    }

    async function generate() {
      if (!facts || busy) return;
      const apiKey = getKey();
      if (!apiKey) {
        keyForm.classList.remove("hidden");
        keyInput.focus();
        return;
      }
      keyForm.classList.add("hidden");

      busy = true;
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";
      setStatus("Calling " + modelSelect.value + "…", "busy");
      clearReport();
      reportBox.classList.remove("hidden");

      let text = "";
      abortCtl = new AbortController();
      try {
        await streamReport({
          apiKey,
          model: modelSelect.value,
          system: SYSTEM_PROMPT,
          user: buildUserMessage(facts, ownerCb.checked),
          signal: abortCtl.signal,
          onText: chunk => {
            text += chunk;
            reportBox.innerHTML = renderMarkdown(text);
            reportBox.scrollTop = reportBox.scrollHeight;
          },
        });
        if (text.trim()) {
          // Re-render from the finished text rather than trusting the last
          // streamed frame, and reveal the export button.
          showReport(text, modelSelect.value);
          setStatus("Done.", "ok");
        } else {
          setStatus("The model returned nothing.", "warn");
        }
      } catch (e) {
        if (e.name === "AbortError") {
          setStatus("Cancelled.", "warn");
        } else {
          setStatus("Failed.", "warn");
          reportBox.innerHTML = `<pre class="pr-error">${esc(e.message)}</pre>`;
        }
      } finally {
        busy = false;
        abortCtl = null;
        generateBtn.disabled = false;
        generateBtn.textContent = "Generate report";
        updateFooter();
      }
    }

    generateBtn.addEventListener("click", generate);

    exportBtn.addEventListener("click", () => {
      if (!facts || !lastReport) return;
      buildPrintDoc(printRoot, facts, lastReport.html, lastReport);
      // The class arms the print stylesheet. It stays on until the report is
      // replaced, so a plain Ctrl+P after an export prints the report too —
      // and before any export, Ctrl+P still prints the map as it always did.
      document.body.classList.add("pr-print-ready");
      window.print();
    });

    keyForm.addEventListener("submit", e => {
      e.preventDefault();
      const k = keyInput.value.trim();
      if (!k) return;
      setKey(k);
      keyInput.value = "";
      updateFooter();
      generate();
    });

    forgetBtn.addEventListener("click", () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
      updateFooter();
      setStatus("Key forgotten.", "ok");
    });

    closeBtn.addEventListener("click", closePanel);
    tab.addEventListener("click", () => {
      if (panel.classList.contains("open")) closePanel();
      else openPanel();
    });

    view.on("click", async event => {
      const pt = event.mapPoint;
      if (!pt || typeof pt.latitude !== "number") return;
      await loadParcel(pt.longitude, pt.latitude);
    });

    // Dev hooks. Nothing in the UI calls these. They exist so the export path
    // can be exercised end to end without an Anthropic key and without
    // spending a token: load a real parcel, push a canned brief through the
    // very same showReport() a streamed one ends in, then export.
    //
    //   NRPCParcelReport.dev.loadParcel(-93.5687, 45.0357)
    //   NRPCParcelReport.dev.showReport("## Summary\n…")
    //   NRPCParcelReport.dev.buildPrintDoc()   // fills #pr-print, no dialog
    window.NRPCParcelReport.dev = {
      loadParcel,
      showReport: md => showReport(md, modelSelect.value),
      buildPrintDoc: () => {
        if (!facts || !lastReport) return false;
        buildPrintDoc(printRoot, facts, lastReport.html, lastReport);
        document.body.classList.add("pr-print-ready");
        return true;
      },
    };

    updateFooter();
  }

  window.NRPCParcelReport = { init };
})();

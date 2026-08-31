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
  // The owner toggle is remembered per browser, like the model choice, and it
  // defaults ON. Bryan, 2026-08-27: "The Parcel Report still doesn't state who
  // the property owner is." A brief that cannot name the owner cannot answer
  // the first question anyone asks about a parcel, so the opt-out stays but
  // stops being the default.
  const OWNER_KEY = "nrpc-parcel-report.includeOwner";

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

  // ── The five card fields, and what the data actually has ─────────────────
  //
  // Field audit against the live `?f=json` metadata of all five layers AND all
  // 232 records, 2026-08-27. Bryan asked each card to carry organisation,
  // contact name, contact email, assigned score and date added. Three of those
  // are in the data clean, one is in the data with a caveat, and one is not
  // there at all:
  //
  //   organisation   `organization`   present. 156/162, 17/21, 46/49 non-null.
  //   contact name   `name`           present. 144/162, 17/21, 48/49 non-null.
  //   contact email  —                NOT PUBLISHED BY ANY OF THE FIVE LAYERS,
  //                                   and a regex sweep for an address across
  //                                   every string value of all 232 rows found
  //                                   zero — it is not hiding in the prose
  //                                   either. Asking for it anyway is not an
  //                                   option: these services reject the WHOLE
  //                                   query with "'outFields' parameter is
  //                                   invalid" when outFields names a field the
  //                                   layer does not have, so a speculative
  //                                   `email` in OPP_COMMON_FIELDS would take
  //                                   the entire section down. The card prints
  //                                   "not recorded" and the section says why
  //                                   once, under the list.
  //   assigned score OPP_SCORE_FIELD  present, but it is a DIFFERENT question
  //                                   per schema and one of them runs backwards.
  //   date added     `CreationDate`   present, but for most rows it is when the
  //                                   workshop CSV was loaded — OPP_BULK_LOAD_MS.
  //
  // To turn the email on the day NRPC adds it to the Contribute form: put the
  // field name in OPP_EMAIL_FIELD and add it to OPP_COMMON_FIELDS, once every
  // layer publishes it. Nothing else changes.
  const OPP_EMAIL_FIELD = null;

  // The one numeric rating each schema publishes, which is what the card calls
  // the assigned score. They are not the same question and they do not run the
  // same way, so the scale is printed with the number every time:
  //
  //   easy_start     Integer 1-5, "1: very easy, 5: very hard" — INVERTED, the
  //                  1 is the good end. Over the 148 rows that have one:
  //                  1×19, 2×38, 3×56, 4×22, 5×13.
  //   rate_priority  Integer 1-5, "1: low, 5: high".
  //
  // `rate_feasibility` is the connection layers' other rating and stays in the
  // detail line: the polygon layer publishes it as a String and the polyline
  // layer as an Integer — same question, two published types — which is
  // exactly why it is not where a headline number comes from.
  // `rowKey` is the same rating's name in OPP_DETAIL_LABELS: the card promotes
  // it to its own line, so the detail line drops it rather than printing the
  // number twice in two phrasings.
  const OPP_SCORE_FIELD = {
    opportunity: {
      field: "easy_start",
      rowKey: "easeOfStart",
      label: "Ease of starting",
      scale: "1 easy – 5 hard",
    },
    connection: {
      field: "rate_priority",
      rowKey: "priorityRating",
      label: "Priority",
      scale: "1 low – 5 high",
    },
  };

  // CreationDate is real editor tracking, but it is not when someone drew the
  // thing. Measured 2026-08-27 over all 232 rows: one CreationDate value per
  // workshop layer is shared by the majority of that layer's features —
  // 129/162, 20/21 and 49/49 — because that is when the workshop's CSV was
  // bulk-loaded into ArcGIS Online. Every other CreationDate in the data is
  // unique to a single row and is a genuine per-contribution timestamp (33 of
  // them on Activity 1, running 30 Apr to 11 Sep 2025).
  //
  // A card reading "Added 2025-04-28" on 129 contributions that were drawn on
  // paper at a workshop in January is a true field telling a small lie, so the
  // rows matching a load stamp say so. A value not in this table is treated as
  // genuine — which is how a contribution arriving through the Contribute
  // panel tomorrow gets treated, with no code change.
  const OPP_BULK_LOAD_MS = {
    workshop1: 1745849740936,
    workshop2physical: 1745849990952,
    workshop2thematic: 1745849990890,
  };

  // Bryan, 27 Aug: "it should show the top 5 nearest, sorted by distance."
  const OPP_NEAREST_N = 5;
  // …and Design 2's widen-once: if fewer than five contributions are in the
  // normal tiered scope, ONE further pass at this radius, said out loud in a
  // note. Only fires on a parcel that is short of five, which is nearly all of
  // them — see the note in the write-up on what it costs.
  const OPP_WIDEN_M = 1000;

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

  // clean(), plus collapsing the runs of internal spaces Hennepin pads its
  // fixed-width character columns with: 'BROOKLYN PARK MN   55443    ' is one
  // address line, not three fields.
  const squash = v => {
    const s = clean(v);
    return typeof s === "string" ? clean(s.replace(/\s+/g, " ")) : s;
  };

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

  async function esriQuery(url, params, timeoutMs, signal) {
    const body = new URLSearchParams({ f: "json", ...params });
    // A per-request deadline, so one wedged service cannot hold the panel
    // open forever. Without a timeout the fetch just sits there.
    let ctl = null;
    let timer = null;
    if (timeoutMs) {
      ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), timeoutMs);
      // A caller's own signal — the search box aborting a superseded
      // keystroke — is folded into the same controller, so either can cancel.
      if (signal) {
        if (signal.aborted) ctl.abort();
        else signal.addEventListener("abort", () => ctl.abort(), { once: true });
      }
    }
    let res;
    try {
      res = await fetch(url + "/query", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: ctl ? ctl.signal : signal || undefined,
      });
    } catch (e) {
      // A caller that cancelled deliberately gets a recognisable error rather
      // than a timeout message that would be a lie.
      if (e.name === "AbortError" && signal && signal.aborted) {
        const err = new Error("superseded");
        err.name = "AbortError";
        throw err;
      }
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
  function toGeometry(engine, json) {
    if (!json) return null;
    try {
      return engine.jsonUtils.fromJSON({ ...json, spatialReference: { wkid: 4326 } });
    } catch (_) {
      return null;
    }
  }

  // ── Stage timing ─────────────────────────────────────────────────────────
  //
  // Adjacency added a network round trip to the click path, and the budget it
  // was built to — about a second at p50 — is only meaningful if it can be
  // re-checked after a service gets slower or a layer gets added. So each
  // stage records its own wall-clock into `NRPCParcelReport.dev.timings`.
  // Nothing in the UI reads it; it costs two Date.now() calls per stage.

  let stageTimings = { _t0: 0 };

  function resetTimings(t0) {
    stageTimings = { _t0: t0 };
  }

  function timed(name, fn) {
    const t0 = Date.now();
    stageTimings[name] = { startedAt: t0 - stageTimings._t0, ms: null };
    return Promise.resolve()
      .then(fn)
      .then(
        v => {
          stageTimings[name].ms = Date.now() - t0;
          return v;
        },
        e => {
          stageTimings[name].ms = Date.now() - t0;
          stageTimings[name].failed = true;
          throw e;
        }
      );
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

  /**
   * The parcel with this exact PID, geometry and all — what a deep link and a
   * search result both resolve to. Same layer, same shape of answer as
   * fetchParcelAt(), so selectParcelFeature() cannot tell them apart.
   */
  async function fetchParcelByPid(pid) {
    const clean13 = String(pid || "").replace(/[^0-9]/g, "");
    if (!clean13) return null;
    const json = await esriQuery(PARCEL_BASE, {
      where: `PID='${clean13.replace(/'/g, "''")}'`,
      outFields: "*",
      returnGeometry: "true",
      outSR: "4326",
    });
    return (json.features || [])[0] || null;
  }

  // ── Search ────────────────────────────────────────────────────────────────
  //
  // Two kinds of parcel lookup, both against PARCEL_BASE — the layer the map
  // already shows and the report already queries. Field types verified against
  // the live service on 2026-08-26: PID is a 13-char string, HOUSE_NO is an
  // INTEGER and STREET_NM a 20-char string padded with trailing spaces, so an
  // address is matched as a number AND a prefix rather than as one string.
  // (`useStandardizedQueries` is true on this layer, so UPPER() and LIKE are
  // available; returnDistinctValues is not — it 400s.)

  const SEARCH_LIMIT = 10;

  const searchRow = f => {
    const a = f.attributes;
    const house = clean(a.HOUSE_NO);
    const street = clean(a.STREET_NM);
    return {
      pid: clean(a.PID),
      address: [house, street].filter(v => v !== null && v !== "").join(" ") || null,
      city: clean(a.MUNIC_NM),
    };
  };

  /** PIDs beginning with these digits. A full 13 digits matches exactly one. */
  async function searchByPid(digits, signal) {
    const d = String(digits || "").replace(/[^0-9]/g, "");
    if (!d) return [];
    const where =
      d.length >= 13 ? `PID='${d.slice(0, 13)}'` : `PID LIKE '${d}%'`;
    const json = await esriQuery(
      PARCEL_BASE,
      {
        where,
        outFields: "PID,HOUSE_NO,STREET_NM,MUNIC_NM",
        returnGeometry: "false",
        orderByFields: "PID",
        resultRecordCount: String(SEARCH_LIMIT),
      },
      8000,
      signal
    );
    return (json.features || []).map(searchRow);
  }

  /**
   * Addresses beginning with this text. "224 83rd" becomes
   * HOUSE_NO=224 AND UPPER(STREET_NM) LIKE '83RD%'; a query with no leading
   * number is a street-name prefix on its own.
   */
  async function searchByAddress(text, signal) {
    const t = String(text || "").trim().toUpperCase();
    if (t.length < 3) return [];
    const m = t.match(/^(\d+)\s+(.*)$/);
    const esc1 = v => v.replace(/'/g, "''").replace(/[%_]/g, "");
    let where;
    if (m && m[2]) where = `HOUSE_NO=${m[1]} AND UPPER(STREET_NM) LIKE '${esc1(m[2])}%'`;
    else if (m) where = `HOUSE_NO=${m[1]}`;
    else where = `UPPER(STREET_NM) LIKE '${esc1(t)}%'`;
    const json = await esriQuery(
      PARCEL_BASE,
      {
        where,
        outFields: "PID,HOUSE_NO,STREET_NM,MUNIC_NM",
        returnGeometry: "false",
        orderByFields: "STREET_NM,HOUSE_NO",
        resultRecordCount: String(SEARCH_LIMIT),
      },
      8000,
      signal
    );
    return (json.features || []).map(searchRow);
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

  // The assigned score, as {label, value, scale} or null — the schema's one
  // numeric rating, carried with its scale because the two schemas' scales run
  // in opposite directions. See OPP_SCORE_FIELD.
  function opportunityScore(layer, a) {
    const spec = OPP_SCORE_FIELD[layer.schema];
    if (!spec) return null;
    const v = num(a[spec.field]);
    if (v === null) return null;
    return { label: spec.label, value: v, outOf: 5, scale: spec.scale, rowKey: spec.rowKey };
  }

  // One contributed feature, in the shape the panel, the print view and the
  // model payload all read from.
  function opportunityRow(layer, attrs, relation, distanceMetres) {
    const a = attrs || {};
    const created = a.CreationDate;
    return {
      id: layer.key + ":" + a.OBJECTID,
      type: layer.label,
      source: layer.source,
      geometryType: layer.geometry,
      organization: clean(a.organization),
      // Kept for the panel and the printed page. Stripped from the API
      // payload — see stripOpportunityContributors().
      contributor: clean(a.name),
      // Not published by any of the five layers as of 2026-08-27 — see the
      // audit note on OPP_EMAIL_FIELD. Null here means the card prints
      // "not recorded", which is the whole point: never invented.
      contactEmail: OPP_EMAIL_FIELD ? clean(a[OPP_EMAIL_FIELD]) : null,
      score: opportunityScore(layer, a),
      // True when this row's CreationDate is the layer's bulk-load stamp
      // rather than a moment anyone typed anything. See OPP_BULK_LOAD_MS.
      dateAddedIsBulkLoad:
        created !== null &&
        created !== undefined &&
        OPP_BULK_LOAD_MS[layer.key] !== undefined &&
        Number(created) === OPP_BULK_LOAD_MS[layer.key],
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
      // Set only on the middle tier: which neighbouring parcel it sits on.
      adjacentParcelPid: null,
      adjacentParcelCity: null,
    };
  }

  // The three tiers, in the order they read. Anything that is none of them is
  // dropped — that is the whole point of tiering rather than widening.
  const ON_PARCEL = "on the parcel";
  const ON_ADJACENT = "on an adjacent parcel";
  const NEARBY = "nearby";
  // A fourth relation, and NOT a fourth tier: nothing reaches it through the
  // normal path. It exists only on rows the widen-once pass pulled in when
  // fewer than five contributions were in scope, and only inside `nearest`.
  const WIDER = "wider search";
  const TIER_RANK = { [ON_PARCEL]: 0, [ON_ADJACENT]: 1, [NEARBY]: 2, [WIDER]: 3 };

  /**
   * What coalition members have put on the map on, beside, or near this parcel.
   *
   * Two queries per layer — the same two the fixed-radius version issued, and
   * the same count. What changed is the radius of the second one and what
   * happens to its results afterwards:
   *
   *   1. intersects the parcel polygon exactly → the FIRST tier, "on the
   *      parcel". Server-side topology, unchanged.
   *   2. within D of the parcel polygon, where D comes from `adjacency` rather
   *      than a constant: far enough to cover the whole extent of every
   *      adjacent parcel, and no further.
   *
   * Everything from (2) that is not already in (1) is then sorted into two
   * tiers or thrown away:
   *
   *   ON_ADJACENT  it intersects one of the adjacent parcels → keep, and name
   *                the PID, because "the parcel next door" is the fact a land
   *                manager acts on
   *   NEARBY       it is within NEARBY_M of the clicked boundary → keep, as
   *                before
   *   dropped      neither → discarded, and counted
   *
   * That last line is what stops a bigger search radius from becoming a bigger
   * report. D can be 1,500 m, but nothing between 250 m and 1,500 m survives
   * unless it is standing on a parcel that touches this one.
   *
   * A layer that errors, times out or is empty produces an entry in
   * `layerStatus` and nothing else. Nothing here can reject: the report is
   * more important than this section.
   */
  async function fetchOpportunities(parcelGeometry, adjacency, lat0) {
    const geometry = JSON.stringify({
      rings: parcelGeometry.rings,
      spatialReference: { wkid: 4326 },
    });

    const adj = adjacency || {
      parcels: [],
      searched: 0,
      notSearched: 0,
      more: false,
      searchDistanceM: NEARBY_M,
      clipped: false,
      toleranceM: ADJ_TOLERANCE_M,
      error: "adjacency not available",
    };
    const D = adj.searchDistanceM || NEARBY_M;

    // The engine and the queries start together; neither waits for the other.
    const enginePromise = adj.parcels.length ? geometryEngine() : Promise.resolve(null);

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
              distance: String(D),
              units: "esriSRUnit_Meter",
              returnGeometry: "true",
              outSR: "4326",
            },
            OPP_TIMEOUT_MS
          ),
        ]);

        const onFeatures = onJson.features || [];
        const onIds = new Set(onFeatures.map(f => f.attributes.OBJECTID));
        const rows = onFeatures.map(f => opportunityRow(layer, f.attributes, ON_PARCEL, 0));
        const candidates = (nearJson.features || []).filter(
          f => !onIds.has(f.attributes.OBJECTID)
        );

        // Geometry for the report maps. The on-parcel query asks for none (it
        // only needs to know *that* a contribution is on the parcel), but the
        // distance query returns the same features WITH geometry — an
        // on-parcel feature is trivially within D of the parcel — so one index
        // over nearJson covers both tiers without a third round trip.
        const geomById = new Map();
        (nearJson.features || []).forEach(f => {
          if (f.geometry) geomById.set(f.attributes.OBJECTID, f.geometry);
        });

        return { layer, rows, candidates, geomById, error: null, truncated: onFeatures.length >= 25 };
      } catch (e) {
        return { layer, rows: [], candidates: [], geomById: new Map(), error: e.message, truncated: false };
      }
    });

    const [results, engine] = await Promise.all([Promise.all(jobs), enginePromise]);

    // The adjacent parcels, converted once, not once per contribution.
    const adjacentGeoms = engine
      ? adj.parcels
          .map(p => ({ pid: p.pid, city: p.city, g: toGeometry(engine, p.geometry) }))
          .filter(p => p.g)
      : [];

    // Why the engine and not "distance ≈ 0": see the comment on
    // geometryEngine(). Two polygons whose boundaries cross between vertices
    // genuinely intersect while minDistanceM() reports 0.64 m.
    const onAdjacent = geom => {
      if (!engine || !adjacentGeoms.length) return null;
      const g = toGeometry(engine, geom);
      if (!g) return null;
      for (const p of adjacentGeoms) {
        try {
          if (engine.ge.intersects(g, p.g)) return p;
        } catch (_) {
          /* one bad ring must not lose the rest */
        }
      }
      return null;
    };

    const all = [];
    // Rows the widen-once pass added. Kept out of `all` on purpose — see the
    // comment where they are filled — but they still need geometry on the map.
    let widenRows = [];
    let dropped = 0;
    const tierStart = Date.now();
    results.forEach(r => {
      all.push(...r.rows);
      r.candidates.forEach(f => {
        const raw = minDistanceM(f.geometry, parcelGeometry, lat0);
        const d = raw === null ? null : Math.round(raw);
        const neighbour = onAdjacent(f.geometry);
        if (neighbour) {
          const row = opportunityRow(r.layer, f.attributes, ON_ADJACENT, d);
          row.adjacentParcelPid = neighbour.pid;
          row.adjacentParcelCity = neighbour.city;
          all.push(row);
        } else if (d !== null && d <= NEARBY_M) {
          all.push(opportunityRow(r.layer, f.attributes, NEARBY, d));
        } else {
          // Beyond 250 m and not standing on a neighbour: not this parcel's
          // business. Counted so the report can say how much it left out.
          dropped++;
        }
      });
    });

    // The client-side half of the feature, measured on its own: this is the
    // part that scales with adjacent parcels × contributions.
    stageTimings.tiering = { startedAt: tierStart - stageTimings._t0, ms: Date.now() - tierStart };

    // Tier first, then distance, then organization so two loads of the same
    // parcel produce the same order.
    all.sort(
      (a, b) =>
        (TIER_RANK[a.relation] ?? 9) - (TIER_RANK[b.relation] ?? 9) ||
        (a.distanceMetres ?? 1e9) - (b.distanceMetres ?? 1e9) ||
        String(a.organization || "").localeCompare(String(b.organization || ""))
    );

    const count = tier => all.filter(r => r.relation === tier).length;

    // ── The five nearest ───────────────────────────────────────────────────
    //
    // What the section prints. `all` keeps its old order and its old contents
    // — the counts, the map and the model payload are all still built from it,
    // untouched — and this is a view over it, sorted purely by distance,
    // because "top 5 nearest, sorted by distance" was the ask and tier order
    // is not distance order: an on-adjacent contribution can be 1,140 m out
    // while a nearby one is 84 m.
    const byDistance = (a, b) =>
      (a.distanceMetres ?? 1e9) - (b.distanceMetres ?? 1e9) ||
      (TIER_RANK[a.relation] ?? 9) - (TIER_RANK[b.relation] ?? 9) ||
      String(a.id).localeCompare(String(b.id));

    let nearest = all.slice().sort(byDistance).slice(0, OPP_NEAREST_N);
    let widen = null;

    // Widen once. Most parcels in the county have nothing within 250 m, and a
    // section headed "Nearest (5)" that prints one line is a worse answer than
    // one that says "nothing within 250 m; here is what is within 1,000 m".
    // ONE extra pass, at a radius the note names, and never a second.
    if (nearest.length < OPP_NEAREST_N && !results.every(r => r.error)) {
      const seen = new Set(all.map(r => r.id));
      const widenStart = Date.now();
      const found = [];
      const failed = [];
      await Promise.all(
        results.map(async r => {
          if (r.error) {
            failed.push(r.layer.label);
            return;
          }
          try {
            const json = await esriQuery(
              r.layer.url,
              {
                geometry,
                geometryType: "esriGeometryPolygon",
                inSR: "4326",
                spatialRel: "esriSpatialRelIntersects",
                outFields: OPP_COMMON_FIELDS.concat(OPP_SCHEMA_FIELDS[r.layer.schema]).join(","),
                resultRecordCount: "25",
                distance: String(OPP_WIDEN_M),
                units: "esriSRUnit_Meter",
                returnGeometry: "true",
                outSR: "4326",
              },
              OPP_TIMEOUT_MS
            );
            (json.features || []).forEach(f => {
              const id = r.layer.key + ":" + f.attributes.OBJECTID;
              if (seen.has(id)) return;
              const raw = minDistanceM(f.geometry, parcelGeometry, lat0);
              if (raw === null || raw > OPP_WIDEN_M) return;
              const row = opportunityRow(r.layer, f.attributes, WIDER, Math.round(raw));
              found.push(row);
              if (f.geometry) r.geomById.set(f.attributes.OBJECTID, f.geometry);
            });
          } catch (e) {
            failed.push(r.layer.label);
          }
        })
      );
      found.sort(byDistance);
      const take = found.slice(0, OPP_NEAREST_N - nearest.length);
      widen = {
        radiusMetres: OPP_WIDEN_M,
        inScopeBefore: nearest.length,
        added: take.length,
        foundBeyondScope: found.length,
        stillShort: nearest.length + take.length < OPP_NEAREST_N,
        unreachable: failed,
        ms: Date.now() - widenStart,
      };
      // The widened rows go into `nearest` and into the map's geometry index,
      // and NOWHERE else. `all` — and with it every count, the prompt payload
      // and the "within 250 m" arithmetic — means exactly what it meant
      // before this pass existed.
      //
      // Re-sorted, not appended. Appending looked right until Golden Valley
      // ran: its two in-scope rows sit on an adjacent parcel at 567 m and
      // 1,140 m, and the widened row is at 417 m — nearer than both. A list
      // headed "sorted by distance" that printed 567, 1,140, 417 would be
      // wrong on its own terms. Ties fall back to tier, so an in-scope row
      // still wins an exact draw against a widened one.
      widenRows = take;
      nearest = nearest.concat(take).sort(byDistance);
    }
    stageTimings.widen = widen ? { ms: widen.ms } : null;
    nearest.forEach((r, i) => {
      // 1-based, and the same number the adjacency figure draws on the map.
      r.nearestRank = i + 1;
    });

    return {
      // The five the section prints, distance-ascending. A view over `items`
      // plus, when the widen pass fired, up to five rows from beyond the
      // tiers. Read by the panel, the print view and the figure's numbering.
      nearest,
      nearestLimit: OPP_NEAREST_N,
      widen,
      // Bryan, 27 Aug: contact email is not published by any of the five
      // layers, so the cards say "not recorded" and the section says this once.
      contactEmailAvailable: !!OPP_EMAIL_FIELD,
      // Kept under the old name: it is what "nearby" still means, and the
      // panel, the print view and the prompt all read it.
      bufferMetres: NEARBY_M,
      searchDistanceM: D,
      adjacency: {
        toleranceMetres: adj.toleranceM,
        parcelsSearched: adj.searched,
        parcelsNotSearched: adj.notSearched,
        moreThanFetched: adj.more,
        farthestParcelMetres: adj.farthestM ?? null,
        clippedAtMetres: adj.clipped ? ADJ_MAX_D_M : null,
        pids: [...new Set(all.map(r => r.adjacentParcelPid).filter(Boolean))],
        // Null when it worked. A string when the tier could not be computed,
        // in which case the section is exactly the old 250 m one.
        unavailable: adj.error
          ? "the adjacent-parcel lookup failed"
          : !engine && adj.parcels.length
          ? "the map's geometry engine did not load"
          : null,
      },
      droppedBeyondTiers: dropped,
      note:
        "Opportunities are what NRPC coalition members contributed to the map themselves. " +
        "'On the parcel' means the contributed geometry intersects the parcel boundary; " +
        "'on an adjacent parcel' means it intersects a parcel that touches this one, and " +
        "can be much further away than 250 m; 'nearby' is within " +
        NEARBY_M +
        " m of the parcel boundary. Distances are straight-line from the parcel boundary " +
        "to the nearest point of the contribution. These are proposals and observations, " +
        "not commitments.",
      items: all,
      // Geometry for the report maps, kept OUT of `items` on purpose: items go
      // to the model through compactOpportunities(), which whitelists fields,
      // and a wall of coordinates is the last thing that request needs. Drawn
      // by js/report-maps.js, read by nothing else.
      mapGeometry: {
        adjacentParcels: adj.parcels.map(p => ({
          pid: p.pid,
          city: p.city,
          rings: p.geometry && p.geometry.rings ? p.geometry.rings : null,
        })),
        features: (() => {
          const index = new Map();
          results.forEach(r => {
            if (!r.geomById) return;
            r.geomById.forEach((g, oid) => index.set(r.layer.key + ":" + oid, { g, layer: r.layer }));
          });
          return all
            .concat(widenRows)
            .map(row => {
              const hit = index.get(row.id);
              if (!hit) return null;
              return {
                id: row.id,
                relation: row.relation,
                geometryType: hit.layer.geometry,
                geometry: hit.g,
                organization: row.organization,
                adjacentParcelPid: row.adjacentParcelPid || null,
                // 1-5 on the five the list prints, null on everything else.
                // js/report-maps.js draws this number on the figure so the
                // map and the list can be read against each other.
                nearestRank: row.nearestRank || null,
              };
            })
            .filter(Boolean);
        })(),
      },
      onParcelCount: count(ON_PARCEL),
      onAdjacentCount: count(ON_ADJACENT),
      nearbyCount: count(NEARBY),
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
  //
  // Bryan, 2026-08-27, deciding this deliberately when the contact fields went
  // onto the cards: "do not put the names and emails into the prompt sent to
  // Claude. ONLY IN THE REPORT and PARCEL SUMMARY." So the panel, the mobile
  // sheet, the PDF and the DOCX carry contact name and email; this function
  // and compactOpportunities()'s whitelist are the two places that keep them
  // out of the request, and both are belt and braces on purpose.
  function stripOpportunityContributors(opps) {
    if (!opps) return opps;
    const drop = ({ contributor, contactEmail, ...rest }) => rest;
    return {
      ...opps,
      items: opps.items.map(drop),
      // Belt and braces over compactNearest()'s whitelist, exactly as for
      // items: the five nearest are the rows most likely to be "tidied" into a
      // spread later, and a spread is how a contributor's name would escape.
      nearest: (opps.nearest || []).map(drop),
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

    const hasRings = !!(feature.geometry && feature.geometry.rings);

    // The adjacency query starts NOW, in the same tick as the nine context
    // fetches and the model join — not after them. It is the only new network
    // round trip in the click path, and overlapping it with the nine that were
    // already there is what keeps the added wall-clock down; the opportunity
    // queries then chain off it, because they cannot know how far to look
    // until they know what touches this parcel.
    const adjacencyPromise = hasRings
      ? timed("adjacency", () => fetchAdjacentParcels(feature.geometry, clean(a.PID), midLat))
      : Promise.resolve(null);

    const [scores, context, total, opportunities] = await Promise.all([
      fetchModelScores(a.PID),
      timed("context", () =>
        bbox ? fetchContext(padBBox(bbox, CONTEXT_BUFFER_M)) : Promise.resolve([])
      ),
      modelTotal(),
      // Three tiers now, not one radius: on the parcel, on a parcel touching
      // it, or within 250 m of it. Distances are measured from the parcel
      // boundary itself rather than from a padded bounding box — a distance in
      // metres is the whole point of the section.
      hasRings
        ? adjacencyPromise
            .then(adj => timed("opportunities", () =>
              fetchOpportunities(feature.geometry, adj, midLat)
            ))
            .catch(() => null)
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
      // The parcel's own outline, in 4326, for js/report-maps.js. Not sent to
      // the model — buildPayload() picks the fields it sends.
      parcelRings: hasRings ? feature.geometry.rings : null,
      identity: {
        pid: clean(a.PID),
        address,
        city: clean(a.MUNIC_NM),
        zip: clean(a.ZIP_CD),
        legalAddition: clean(a.ABBREV_ADDN_NM),
        lot: clean(a.LOT),
        block: clean(a.BLOCK),
      },
      // MEASURED, 2026-08-27, against the live Parcel Base for PID
      // 2411921110001 and PID 1111823340002 — TAXPAYER_NM_1/_2/_3 are the
      // taxpayer's MAILING ADDRESS lines, not the extra names the field name
      // suggests:
      //   OWNER_NM      'CITY OF BROOKLYN PARK'     'G G NOVAK & M A NOVAK'
      //   TAXPAYER_NM   'CITY OF BROOKLYN PARK'     'GARY G NOVAK'
      //   TAXPAYER_NM_1 '5200 85TH AVE N'           '1400 BLACKFOOT TR'
      //   TAXPAYER_NM_2 'BROOKLYN PARK MN   55443'  'LONG LAKE MN   55356'
      //   TAXPAYER_NM_3 ''                          ''
      // so they are joined into one address line rather than listed as names.
      // Every value is space-padded in the source and carries runs of internal
      // spaces, which is why squash() and not clean() alone.
      owner: {
        ownerName: clean(a.OWNER_NM),
        taxpayerName: clean(a.TAXPAYER_NM),
        taxpayerAddress:
          [a.TAXPAYER_NM_1, a.TAXPAYER_NM_2, a.TAXPAYER_NM_3]
            .map(squash)
            .filter(Boolean)
            .join(", ") || null,
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

  // ── Multi-parcel selection: combining per-parcel facts ───────────────────
  //
  // A selection of several parcels keeps every per-parcel facts object exactly
  // as assembleFacts() built it — those are what the per-parcel print tables
  // and the prompt's `parcels` array are made from — and derives ONE combined
  // facts object for everything that renders a single report: the panel table,
  // the merged opportunity cards, the figures and plates, the brief. Nothing
  // in the single-parcel path changes shape; a combined object simply carries
  // `multi` and `parcels` on top of the same keys.

  /**
   * Merge the per-parcel sharedOpportunities objects into one. Rows are
   * deduped by their stable id (layer key + OBJECTID); when the same
   * contribution is in scope for two parcels, the better relation wins —
   * a row that is ON_PARCEL for parcel B must not be reported as "nearby"
   * because parcel A also saw it at 180 m. Distances are each measured to
   * the boundary of the parcel that found the row, so the kept distance
   * means "to the nearest selected parcel", which is what a reader of a
   * combined report is asking.
   */
  function mergeOpportunities(oppsList, selectedPids) {
    const live = (oppsList || []).filter(Boolean);
    if (!live.length) return null;
    const selSet = new Set(selectedPids || []);

    const tierOf = r => TIER_RANK[r.relation] ?? 9;
    const better = (a, b) =>
      tierOf(a) !== tierOf(b)
        ? tierOf(a) < tierOf(b)
        : (a.distanceMetres ?? 1e9) < (b.distanceMetres ?? 1e9);
    const best = new Map();
    const claim = r => {
      if (!r) return;
      const cur = best.get(r.id);
      // Cloned: nearestRank is recomputed for the merged list below, and the
      // per-parcel objects keep their own numbering for their own sections.
      if (!cur || better(r, cur)) best.set(r.id, { ...r, nearestRank: null });
    };
    live.forEach(o => (o.items || []).forEach(claim));
    // Widened rows exist only inside `nearest`. Claimed through the same map,
    // so a row one parcel found by widening and another holds in scope keeps
    // the in-scope relation.
    live.forEach(o => (o.nearest || []).forEach(claim));

    const merged = [...best.values()];
    const byDistance = (a, b) =>
      (a.distanceMetres ?? 1e9) - (b.distanceMetres ?? 1e9) ||
      tierOf(a) - tierOf(b) ||
      String(a.id).localeCompare(String(b.id));

    // `items` keeps the meaning it has on one parcel: the in-scope tiers only.
    const items = merged.filter(r => r.relation !== WIDER).sort(byDistance);
    const nearest = merged.slice().sort(byDistance).slice(0, OPP_NEAREST_N);
    nearest.forEach((r, i) => {
      r.nearestRank = i + 1;
    });
    const rankById = new Map(nearest.map(r => [r.id, r.nearestRank]));
    const count = rel => items.filter(r => r.relation === rel).length;

    // Map geometry: features deduped by id with the merged numbering, the
    // adjacent-parcel outlines deduped by PID — minus the parcels that are
    // themselves selected, which are subjects now, not neighbours.
    const featById = new Map();
    const adjByPid = new Map();
    live.forEach(o => {
      const mg = o.mapGeometry || {};
      (mg.features || []).forEach(ft => {
        if (!featById.has(ft.id)) featById.set(ft.id, { ...ft });
      });
      (mg.adjacentParcels || []).forEach(p => {
        if (!p.pid || selSet.has(p.pid) || adjByPid.has(p.pid)) return;
        adjByPid.set(p.pid, p);
      });
    });
    featById.forEach(ft => {
      ft.nearestRank = rankById.get(ft.id) || null;
      const kept = best.get(ft.id);
      if (kept) {
        ft.relation = kept.relation;
        ft.adjacentParcelPid = kept.adjacentParcelPid || null;
      }
    });

    // Layer status: a layer down for ANY parcel makes the merged section a
    // floor, so errors OR together across parcels.
    const statusByLayer = new Map();
    live.forEach(o =>
      (o.layerStatus || []).forEach(s => {
        const cur = statusByLayer.get(s.layer);
        if (!cur) statusByLayer.set(s.layer, { ...s });
        else {
          cur.error = cur.error || s.error;
          cur.truncated = cur.truncated || s.truncated;
          cur.count = Math.max(cur.count || 0, s.count || 0);
        }
      })
    );
    const layerStatus = [...statusByLayer.values()];
    const unavailable = layerStatus.filter(s => s.error).map(s => s.layer);

    // Adjacency, summed where summing is honest and worst-case where it is not.
    const adjs = live.map(o => o.adjacency).filter(Boolean);
    const adjacency = adjs.length
      ? {
          toleranceMetres: adjs[0].toleranceMetres,
          parcelsSearched: adjs.reduce((n, a) => n + (a.parcelsSearched || 0), 0),
          parcelsNotSearched: adjs.reduce((n, a) => n + (a.parcelsNotSearched || 0), 0),
          moreThanFetched: adjs.some(a => a.moreThanFetched),
          farthestParcelMetres: adjs.reduce(
            (m, a) => (a.farthestParcelMetres !== null && a.farthestParcelMetres > m ? a.farthestParcelMetres : m),
            0
          ) || null,
          clippedAtMetres: adjs.reduce((m, a) => (a.clippedAtMetres ? a.clippedAtMetres : m), null),
          pids: [...new Set(adjs.flatMap(a => a.pids || []).filter(p => !selSet.has(p)))],
          unavailable: adjs.every(a => a.unavailable)
            ? adjs[0].unavailable
            : null,
        }
      : null;

    // The widen note, restated for a merged list: how many of the printed
    // rows only exist because some parcel's search had to widen.
    const anyWiden = live.some(o => o.widen);
    const widerKept = nearest.filter(r => r.relation === WIDER).length;
    const widen = anyWiden
      ? {
          radiusMetres: OPP_WIDEN_M,
          inScopeBefore: nearest.length - widerKept,
          added: widerKept,
          stillShort: nearest.length < OPP_NEAREST_N,
          unreachable: [...new Set(live.flatMap(o => (o.widen && o.widen.unreachable) || []))],
        }
      : null;

    return {
      nearest,
      nearestLimit: OPP_NEAREST_N,
      widen,
      contactEmailAvailable: !!OPP_EMAIL_FIELD,
      bufferMetres: NEARBY_M,
      searchDistanceM: Math.max(...live.map(o => o.searchDistanceM || 0)) || NEARBY_M,
      adjacency,
      droppedBeyondTiers: live.reduce((n, o) => n + (o.droppedBeyondTiers || 0), 0),
      note:
        live[0].note +
        " This selection holds " +
        (selSet.size || live.length) +
        " parcels: each distance is measured to the boundary of the nearest selected parcel, a " +
        "contribution in scope for more than one of them is counted once, and 'on the parcel' " +
        "means on any parcel in the selection.",
      items,
      mapGeometry: {
        adjacentParcels: [...adjByPid.values()],
        features: [...featById.values()],
      },
      onParcelCount: count(ON_PARCEL),
      onAdjacentCount: count(ON_ADJACENT),
      nearbyCount: count(NEARBY),
      organizations: [...new Set(items.map(r => r.organization).filter(Boolean))],
      layerStatus,
      unavailable,
    };
  }

  /**
   * Merge the nine per-parcel context sections into one, layer by layer.
   * Named features dedupe across parcels — the park that is near both
   * parcels is one park. The count is the number of distinct names where
   * names exist, otherwise the largest per-parcel count, and either way a
   * multi-parcel count is a floor: the per-layer query cap applies per
   * parcel, and unnamed features cannot be deduped.
   */
  function mergeContext(factsList) {
    const byLayer = new Map();
    factsList.forEach(f =>
      (f.context || []).forEach(c => {
        const cur = byLayer.get(c.layer);
        if (!cur) {
          byLayer.set(c.layer, {
            layer: c.layer,
            error: c.error,
            count: c.count,
            truncated: c.truncated,
            names: [...c.names],
            detail: (c.detail || []).slice(0, 4),
          });
          return;
        }
        cur.error = cur.error || c.error;
        cur.truncated = cur.truncated || c.truncated;
        const names = new Set(cur.names);
        c.names.forEach(n => names.add(n));
        cur.names = [...names];
        cur.count = cur.names.length || Math.max(cur.count, c.count);
      })
    );
    return [...byLayer.values()];
  }

  const sumOrNull = values => {
    const known = values.filter(v => v !== null && v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };

  /**
   * One combined facts object for a multi-parcel selection. Same shape as a
   * single parcel's facts everywhere downstream code reads it — parcelRings,
   * identity, land, context, sharedOpportunities — plus `multi` and
   * `parcels`. `model` is null on purpose: the prioritization model ranks
   * parcels one at a time and an invented blended rank would be a number the
   * county never published. Per-parcel ranks live on in `parcels[]`.
   */
  function combineFacts(entries) {
    const parcels = entries.map(e => e.facts);
    const pids = parcels.map(f => (f.identity && f.identity.pid) || "unknown");
    const last = entries[entries.length - 1];

    const acres = sumOrNull(parcels.map(f => f.land.parcelAcres));
    const sqft = sumOrNull(parcels.map(f => f.land.parcelAreaSqFt));
    const cities = [...new Set(parcels.map(f => f.identity.city).filter(Boolean))];
    const types = [...new Set(parcels.map(f => f.land.propertyType).filter(Boolean))];

    const valueKnown = key => parcels.every(f => f.value[key] !== null && f.value[key] !== undefined);

    return {
      multi: {
        count: parcels.length,
        pids,
        // True per value field only when every parcel carries it — a summed
        // total over a parcel with a null would silently understate.
        valueComplete: {
          estimatedMarketValueTotal: valueKnown("estimatedMarketValueTotal"),
          estimatedLandValue: valueKnown("estimatedLandValue"),
          totalTax: valueKnown("totalTax"),
        },
      },
      parcels,
      clickedAt: last.facts.clickedAt,
      parcelRings: parcels.some(f => f.parcelRings)
        ? parcels.flatMap(f => f.parcelRings || [])
        : null,
      identity: {
        pid: pids.join(", "),
        address: `${parcels.length} parcels`,
        city: cities.join(" · ") || null,
        zip: null,
        legalAddition: null,
        lot: null,
        block: null,
      },
      owner: null,
      land: {
        parcelAreaSqFt: sqft,
        parcelAcres: acres === null ? null : Number(acres.toFixed(2)),
        propertyType: types.join("; ") || null,
        homesteadStatus: null,
        yearBuilt: null,
        taxForfeitLand: null,
        schoolDistrict: [...new Set(parcels.map(f => f.land.schoolDistrict).filter(Boolean))].join(", ") || null,
        watershedNo: [...new Set(parcels.map(f => f.land.watershedNo).filter(Boolean))].join(", ") || null,
      },
      value: {
        estimatedMarketValueTotal: sumOrNull(parcels.map(f => f.value.estimatedMarketValueTotal)),
        estimatedLandValue: sumOrNull(parcels.map(f => f.value.estimatedLandValue)),
        estimatedBuildingValue: sumOrNull(parcels.map(f => f.value.estimatedBuildingValue)),
        totalTax: sumOrNull(parcels.map(f => f.value.totalTax)),
        lastSaleDateYYYYMM: null,
        lastSalePrice: null,
        lastSaleType: null,
      },
      model: null,
      contextBufferMetres: CONTEXT_BUFFER_M,
      context: mergeContext(parcels),
      sharedOpportunities: mergeOpportunities(
        parcels.map(f => f.sharedOpportunities),
        pids
      ),
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
    "- Each shared opportunity carries a `relation`, and the three values mean different",
    "  things. 'on the parcel' is on this parcel. 'on an adjacent parcel' is on a parcel",
    "  that physically touches this one — say so, name the adjacentParcelPid, and give the",
    "  distance, which can be far more than the nearby radius because a neighbouring",
    "  parcel can be large. 'nearby' is within bufferMetres of the boundary and is not",
    "  known to be on any particular parcel. Do not describe an adjacent-parcel",
    "  contribution as being on this parcel, or as merely nearby.",
    "- droppedBeyondTiers, if greater than zero, is how many further contributions were",
    "  found and deliberately excluded for being neither on this parcel, nor on one",
    "  touching it, nor within bufferMetres. Mention the number only if it is non-zero.",
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
    "Work from sharedOpportunities.nearest — those are the five the report itself prints and",
    "numbers 1-5, closest first, and your paragraph must cover the same five in the same",
    "order. For each: who contributed it, what they described, whether it is on this parcel,",
    "on a parcel touching it, nearby, or found by the widened search, and how far away.",
    "Say which of them suggests someone to call. If sharedOpportunities.widen is present,",
    "say in one clause that the search had to be widened to fill the list. `items` is the",
    "full in-scope set behind the counts — use it only for anything the five do not cover,",
    "and do not count a contribution twice because it appears in both.",
    "One sentence saying there are none if `nearest` is empty.",
    "",
    "## What to check next",
    "Two to four concrete next steps for a planner, each tied to something specific in",
    "the data — including anything the data could not answer.",
  ].join("\n");

  // Appended to the system prompt when the selection holds more than one
  // parcel. The sections stay the same; what changes is what "the parcel"
  // means and how the per-parcel model ranks are handled.
  const SYSTEM_PROMPT_MULTI = [
    "",
    "THIS REQUEST COVERS A SELECTION OF SEVERAL PARCELS, NOT ONE. The JSON carries a",
    "`combined` object for the selection as a whole and a `parcels` array with each",
    "parcel's own data. Write ONE brief about the selection as a whole, in the same",
    "sections, with these changes:",
    "- The Summary says what the selection is: how many parcels, total acreage, and",
    "  whether they read as one assembly. Say whether the parcels are adjacent ONLY if",
    "  the data shows it (a shared opportunity on one parcel listed as adjacent to",
    "  another selected parcel's PID, or matching addresses); otherwise do not guess.",
    "- Priority score: there is no combined rank — the county model ranks parcels one",
    "  at a time. Give each parcel's rank and percentile briefly, name the",
    "  best-ranked parcel, and never average or invent a blended score.",
    "- combined.mergedSharedOpportunities is the merged, deduplicated view the report",
    "  prints, and its `nearest` list is the one the report numbers 1-5 — write the",
    "  Shared opportunities section from it, not from any single parcel's list.",
    "- Combined value or acreage totals marked incomplete are floors; say so where it",
    "  matters.",
    "- Up to 550 words for the whole brief.",
  ].join("\n");

  // The panel and the printed page can afford every field of every
  // contribution. The prompt cannot, and does not need to: what the model has
  // to write a paragraph is who, what, how far, and whether it is live.
  //
  // FROZEN, deliberately, per Bryan 2026-08-27: the contact name and email the
  // cards now print are the ORGANISATION's to share internally, not the
  // model's to see. `contributor` and `contactEmail` are absent from the
  // whitelists below and stripped again by stripOpportunityContributors().
  // That part of the freeze stands. Do not "tidy" it by spreading the row.
  //
  // The rest of the freeze did NOT stand, and this is the bug Bryan reported on
  // 2026-08-27: "the shared opportunities section of the LLM-generated report
  // doesn't include the nearest opportunities shown". Leaving `nearest` and
  // `widen` out of the payload meant the brief was written from `items` — the
  // in-scope tier list — while the panel, the printed report, the DOCX and the
  // figure's 1-5 numbering were all written from `nearest`. On PID
  // 2411921110001 that is a measured four rows against five: the widened row at
  // 418 m that the report prints as "5." was in no version of the prompt, and
  // no ranking was either. Both views now go, and the note below tells the
  // model how they overlap so it cannot double-count.
  const OPP_PROMPT_LIMIT = 12;
  const OPP_DESCRIPTION_CHARS = 400;

  // The five the report prints, in the shape the prompt needs: the rank the
  // page numbers them by, who, how far, how it was scored (with the scale,
  // because the two schemas' scales run in opposite directions), and what was
  // described. Same whitelist discipline as items — contributor and
  // contactEmail are not in it.
  function compactNearest(rows) {
    return (rows || []).map(r => {
      const out = {
        rank: r.nearestRank || null,
        type: r.type,
        organization: r.organization,
        relation: r.relation,
        distanceMetres: r.distanceMetres,
        adjacentParcelPid: r.adjacentParcelPid,
        score: r.score
          ? {
              label: r.score.label,
              value: r.score.value,
              outOf: r.score.outOf,
              scale: r.score.scale,
            }
          : null,
        contributedOn: r.contributedOn,
        dateIsLayerLoadDate: r.dateAddedIsBulkLoad || null,
        description:
          r.description && r.description.length > OPP_DESCRIPTION_CHARS
            ? r.description.slice(0, OPP_DESCRIPTION_CHARS) + "…"
            : r.description,
        feasibleInThreeYears: r.feasibleInThreeYears,
        potentialFunder: r.potentialFunder,
      };
      Object.keys(out).forEach(k => {
        if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
      });
      return out;
    });
  }

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
        adjacentParcelPid: r.adjacentParcelPid,
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
    const nearest = compactNearest(opps.nearest);
    return {
      bufferMetres: opps.bufferMetres,
      searchDistanceMetres: opps.searchDistanceM,
      adjacency: opps.adjacency,
      note: opps.note,
      // The five the printed report numbers 1-5, closest first. This is the
      // list the brief's "Shared opportunities" section is written from.
      nearest,
      nearestLimit: opps.nearestLimit,
      // Present only when the widen-once pass fired.
      widen: opps.widen
        ? {
            radiusMetres: opps.widen.radiusMetres,
            inScopeBefore: opps.widen.inScopeBefore,
            added: opps.widen.added,
            stillShort: opps.widen.stillShort,
          }
        : null,
      howNearestAndItemsRelate:
        "`nearest` is the five contributions the report itself prints and numbers 1-5, " +
        "closest first. Every row in it whose relation is not 'wider search' is the SAME " +
        "contribution as one of the rows in `items`, so do not count it twice; rows marked " +
        "'wider search' are past this report's normal scope, appear nowhere in `items`, and " +
        "are counted in none of the counts below.",
      onParcelCount: opps.onParcelCount,
      onAdjacentCount: opps.onAdjacentCount,
      nearbyCount: opps.nearbyCount,
      droppedBeyondTiers: opps.droppedBeyondTiers,
      organizations: opps.organizations,
      itemsShown: items.length,
      itemsTotal: opps.items.length,
      truncated: opps.items.length > items.length,
      unavailableLayers: opps.unavailable,
      items,
    };
  }

  function singleParcelPayload(facts, includeOwner) {
    const payload = JSON.parse(JSON.stringify(facts));
    // Geometry is for the report maps, not for the model: a parcel outline is
    // a few hundred coordinate pairs the brief cannot use and would pay for.
    // (sharedOpportunities.mapGeometry goes the same way, one line below,
    // because compactOpportunities() rebuilds that object from a whitelist.)
    delete payload.parcelRings;
    if (!includeOwner) {
      delete payload.owner;
      payload.ownerWithheld =
        "Owner and taxpayer names were deliberately withheld from this request.";
    }
    payload.sharedOpportunities = stripOpportunityContributors(
      compactOpportunities(facts.sharedOpportunities)
    );
    return payload;
  }

  function buildUserMessage(facts, includeOwner) {
    if (!facts.multi) {
      return (
        "Parcel data:\n\n```json\n" +
        JSON.stringify(singleParcelPayload(facts, includeOwner), null, 2) +
        "\n```\n\nWrite the brief."
      );
    }
    // A multi-parcel selection: per-parcel payloads exactly as a single
    // request would send them — same owner rule, same contributor stripping —
    // plus the combined view the report itself prints from.
    const payload = {
      combined: {
        parcelCount: facts.multi.count,
        pids: facts.multi.pids,
        totalAcres: facts.land.parcelAcres,
        totalAcresIncomplete: facts.parcels.some(p => p.land.parcelAcres === null) || null,
        totalEstimatedMarketValue: facts.value.estimatedMarketValueTotal,
        totalEstimatedMarketValueIncomplete:
          !facts.multi.valueComplete.estimatedMarketValueTotal || null,
        cities: [...new Set(facts.parcels.map(p => p.identity.city).filter(Boolean))],
        mergedContext: JSON.parse(JSON.stringify(facts.context)),
        mergedSharedOpportunities: stripOpportunityContributors(
          compactOpportunities(facts.sharedOpportunities)
        ),
      },
      parcels: facts.parcels.map(p => singleParcelPayload(p, includeOwner)),
    };
    return (
      "Data for a selection of " +
      facts.multi.count +
      " parcels:\n\n```json\n" +
      JSON.stringify(payload, null, 2) +
      "\n```\n\nWrite the brief for the selection as a whole."
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

  // ── Who owns it ──────────────────────────────────────────────────────────

  /**
   * The owner rows, built once and rendered by BOTH the panel's fact table and
   * the printed "The parcel" table — the two used to be written out separately,
   * which is how the panel came to omit the owner while the facts object had
   * carried it all along.
   *
   * Owner is ALWAYS a row, "Not recorded" and all: a report that silently drops
   * the line cannot be told apart from a parcel with no owner on record, and
   * "who owns this?" is the first question asked of any parcel.
   *
   * Taxpayer is suppressed when it is the same string as the owner — on PID
   * 2411921110001 both read "CITY OF BROOKLYN PARK", and a second row saying it
   * again is noise.
   *
   * Owner, taxpayer and the taxpayer's mailing address are public Hennepin
   * County assessor records, published by the county's own Parcel Base service.
   */
  function ownerRows(facts) {
    const o = facts.owner || {};
    const rows = [["Owner", o.ownerName || "Not recorded"]];
    if (o.taxpayerName && o.taxpayerName !== o.ownerName) {
      rows.push(["Taxpayer", o.taxpayerName]);
    }
    if (o.taxpayerAddress) rows.push(["Taxpayer address", o.taxpayerAddress]);
    return rows;
  }

  // ── Fact table for the panel ─────────────────────────────────────────────

  // One line per parcel of a multi-selection: where it is, how big, how the
  // model ranks it. The detail stays in the export's per-parcel tables.
  function parcelLine(f) {
    const bits = [];
    const where = [f.identity.address, f.identity.city].filter(Boolean).join(", ");
    if (where) bits.push(where);
    if (f.land.parcelAcres !== null) bits.push(`${f.land.parcelAcres} ac`);
    if (f.model && f.model.rank !== null) {
      bits.push(
        `rank ${f.model.rank.toLocaleString("en-US")}` +
          (f.model.parcelsRanked ? ` (top ${topPct(f.model.rank, f.model.parcelsRanked)})` : "")
      );
    } else {
      bits.push("not in the model layer");
    }
    return bits.join(" · ");
  }

  function multiFactRows(f) {
    const incomplete = key => (f.multi.valueComplete[key] ? "" : " — incomplete, a parcel has no figure");
    const rows = [
      ["Parcels", String(f.multi.count)],
      ["Cities", f.identity.city],
      [
        "Total size",
        f.land.parcelAcres === null ? null : `${f.land.parcelAcres} acres`,
      ],
      ["Property types", f.land.propertyType],
      [
        "Combined market value",
        f.value.estimatedMarketValueTotal === null
          ? null
          : money(f.value.estimatedMarketValueTotal) + incomplete("estimatedMarketValueTotal"),
      ],
      [
        "Combined land value",
        f.value.estimatedLandValue === null
          ? null
          : money(f.value.estimatedLandValue) + incomplete("estimatedLandValue"),
      ],
      ...f.parcels.map(p => [`PID ${p.identity.pid}`, parcelLine(p)]),
    ];
    const hits = f.context.filter(c => c.count > 0);
    rows.push([
      `Within ${f.contextBufferMetres} m`,
      hits.length
        ? hits.map(c => `${c.layer} (${c.count}${c.truncated ? "+" : ""})`).join("; ")
        : "nothing from the context layers",
    ]);
    rows.push(["Shared opportunities", opportunitySummary(f.sharedOpportunities, f.contextBufferMetres)]);
    return rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  }

  function factRows(facts) {
    const f = facts;
    if (f.multi) return multiFactRows(f);
    const rows = [
      ["PID", f.identity.pid],
      ["Address", [f.identity.address, f.identity.city].filter(Boolean).join(", ") || null],
      ...ownerRows(f),
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
  // True only when the middle tier was actually computed. When it was not, the
  // section IS the old 250 m one and every line of prose has to say so rather
  // than claim neighbours were checked.
  function adjacencyWorked(opps) {
    return !!(opps && opps.adjacency && !opps.adjacency.unavailable && opps.adjacency.parcelsSearched);
  }

  // "…on this parcel, on the parcels touching it, or within 250 m" — or just
  // "…within 250 m" when the adjacency tier is not in play.
  function scopeWords(opps, bufferM) {
    const m = (opps && opps.bufferMetres) || bufferM;
    return adjacencyWorked(opps)
      ? `on this parcel, on the parcels touching it, or within ${m} m`
      : `within ${m} m`;
  }

  function opportunitySummary(opps, bufferM) {
    if (!opps) return "could not be checked";
    const dead = opps.unavailable.length;
    if (!opps.items.length) {
      if (dead === opps.layerStatus.length) {
        return `could not be checked — all ${dead} contribution layers unreachable`;
      }
      return (
        `none ${scopeWords(opps, bufferM)}` +
        (dead ? ` (${dead} of ${opps.layerStatus.length} layers unreachable)` : "")
      );
    }
    const bits = [];
    if (opps.onParcelCount) bits.push(`${opps.onParcelCount} on the parcel`);
    if (opps.onAdjacentCount) {
      bits.push(
        `${opps.onAdjacentCount} on ${
          opps.onAdjacentCount === 1 ? "an adjacent parcel" : "adjacent parcels"
        }`
      );
    }
    if (opps.nearbyCount) bits.push(`${opps.nearbyCount} within ${opps.bufferMetres} m`);
    return bits.join(", ");
  }

  // One line of arithmetic the reader would otherwise have to do: how wide the
  // search actually went, how many neighbours it covered, and what it threw
  // away. Only rendered when there is something non-obvious to say.
  function adjacencyNote(opps) {
    if (!opps || !opps.adjacency) return null;
    const a = opps.adjacency;
    if (a.unavailable) {
      return (
        `Adjacent parcels could not be checked — ${a.unavailable}. This section is the ` +
        `plain ${opps.bufferMetres} m search, as it was before.`
      );
    }
    const bits = [
      `Searched ${a.parcelsSearched} parcel${a.parcelsSearched === 1 ? "" : "s"} touching this ` +
        `one (within ${a.toleranceMetres} m, so across a road counts), out to ` +
        `${opps.searchDistanceM.toLocaleString("en-US")} m.`,
    ];
    if (a.parcelsNotSearched) {
      bits.push(
        `${a.parcelsNotSearched} more adjacent parcel${
          a.parcelsNotSearched === 1 ? "" : "s"
        } not searched.`
      );
    }
    if (a.moreThanFetched) bits.push("The parcel layer had more neighbours than it returned.");
    if (a.clippedAtMetres) {
      bits.push(
        `One adjacent parcel reaches ${a.farthestParcelMetres.toLocaleString("en-US")} m — ` +
          `past the ${a.clippedAtMetres.toLocaleString("en-US")} m search limit — so its far ` +
          `end was not searched.`
      );
    }
    if (opps.droppedBeyondTiers) {
      bits.push(
        `${opps.droppedBeyondTiers} contribution${
          opps.droppedBeyondTiers === 1 ? " was" : "s were"
        } found further out and left out, being neither on this parcel, on one touching it, nor ` +
          `within ${opps.bufferMetres} m.`
      );
    }
    return bits.join(" ");
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
      `No shared opportunities ${scopeWords(opps, opps.bufferMetres)}.` +
      (dead
        ? ` ${dead} of ${opps.layerStatus.length} contribution layers could not be reached, so treat that as a floor.`
        : "")
    );
  }

  // "on the parcel", "on adjacent parcel 2002924230002 · 1,140 m", "nearby · 84 m".
  function opportunityWhere(r) {
    const d =
      r.distanceMetres === null || r.distanceMetres === undefined
        ? null
        : `${r.distanceMetres.toLocaleString("en-US")} m`;
    if (r.relation === ON_PARCEL) return ON_PARCEL;
    if (r.relation === ON_ADJACENT) {
      // The PID is the point. "On an adjacent parcel" without it leaves the
      // reader with a fact they cannot act on.
      const who = r.adjacentParcelPid ? `on adjacent parcel ${r.adjacentParcelPid}` : ON_ADJACENT;
      return d ? `${who} · ${d}` : who;
    }
    // The widen-once rows say which search found them, because "84 m" and
    // "780 m" being in one list is otherwise a puzzle.
    if (r.relation === WIDER) return d ? `${d} — wider search` : "wider search";
    return d ? `nearby · ${d}` : "nearby";
  }

  // The one line under the list that explains the widen, when it fired.
  function widenNote(opps) {
    const w = opps && opps.widen;
    if (!w) return null;
    if (!w.added) {
      return (
        `Fewer than ${opps.nearestLimit} contributions are on this parcel, on a parcel touching it, or within ` +
        `${opps.bufferMetres} m, so the search was widened once to ${w.radiusMetres.toLocaleString("en-US")} m — ` +
        `and found nothing more. The list above is everything there is.`
      );
    }
    return (
      `Only ${w.inScopeBefore} contribution${w.inScopeBefore === 1 ? " is" : "s are"} on this parcel, on a parcel ` +
      `touching it, or within ${opps.bufferMetres} m, so the search was widened once to ` +
      `${w.radiusMetres.toLocaleString("en-US")} m to fill the list. The ${w.added} row${
        w.added === 1 ? "" : "s"
      } marked "wider search" ${w.added === 1 ? "is" : "are"} further out than this report's usual scope, and ` +
      `${w.added === 1 ? "is" : "are"} counted nowhere else in it.` +
      (w.stillShort ? ` Even at ${w.radiusMetres.toLocaleString("en-US")} m there are fewer than ${opps.nearestLimit}.` : "") +
      (w.unreachable.length ? ` Not reached on the wider pass: ${w.unreachable.join(", ")}.` : "")
    );
  }

  // Said once per section rather than once per card: why every email line
  // reads "not recorded". Bryan asked for the email; the schema has no such
  // field, and the report says so rather than leaving a reader wondering
  // whether it is a bug.
  function contactEmailNote(opps) {
    if (!opps || opps.contactEmailAvailable) return null;
    return (
      "No contact email is shown because none of the five NRPC contribution layers publishes one — " +
      "not the Contribute form, not the workshop forms. The contributor's name and organisation are " +
      "what the record carries. Adding an email question to the Contribute form is a change in ArcGIS " +
      "Online, not in this report."
    );
  }

  // ── The card's five requested fields ─────────────────────────────────────
  //
  // Bryan, 27 Aug: "Be sure to provide the org, contact name, and email of the
  // partner opportunity (and their assigned score, and date it was added -
  // this data is all for internal coalition members, so they know it's going
  // to be shared this way)."
  //
  // Every one of these renders SOMETHING on every card. A blank line is
  // indistinguishable from a field nobody thought to add, and this report's
  // job is to be actionable: "email not recorded" sends someone to look the
  // address up, an absent line sends them nowhere.

  const NOT_RECORDED = "not recorded";

  function opportunityOrgText(r) {
    return r.organization || "Organization " + NOT_RECORDED;
  }

  // "Karen Galles · karen.galles@hennepin.us" — or what is missing, by name.
  // The email half is `null` on every row today: see OPP_EMAIL_FIELD.
  function opportunityContactParts(r) {
    return {
      name: r.contributor || "Contact name " + NOT_RECORDED,
      hasName: !!r.contributor,
      email: r.contactEmail || "Email " + NOT_RECORDED,
      hasEmail: !!r.contactEmail,
    };
  }

  // "Priority 4 of 5 (1 low – 5 high)". The scale rides with the number
  // because the two schemas' scales point in opposite directions and a bare
  // "4" from one layer means the opposite of a "4" from the other.
  function opportunityScoreText(r) {
    const s = r.score;
    if (!s || s.value === null || s.value === undefined) return "Score " + NOT_RECORDED;
    return `${s.label} ${s.value} of ${s.outOf} (${s.scale})`;
  }

  // "Added 2025-09-11", or "Added 2025-04-28 · layer load date" when the stamp
  // is the workshop bulk load. The caveat is three words on the card and a
  // sentence once under the list — repeating the full explanation on five
  // cards buries the four dates that are real.
  function opportunityAddedText(r) {
    if (!r.contributedOn) return "Date added " + NOT_RECORDED;
    return "Added " + r.contributedOn + (r.dateAddedIsBulkLoad ? " · layer load date" : "");
  }

  // Said once per section, and only when a card is actually carrying the
  // caveat: what "layer load date" means.
  function bulkLoadNote(opps) {
    const rows = (opps && opps.nearest) || [];
    if (!rows.some(r => r.dateAddedIsBulkLoad)) return null;
    const n = rows.filter(r => r.dateAddedIsBulkLoad).length;
    return (
      `"Layer load date" on ${n} of the ${rows.length}: that contribution's CreationDate is the day its ` +
      `Winter Workshop layer was bulk-loaded into ArcGIS Online, shared with most of the rows in that ` +
      `layer — not the day anyone drew or typed it. The workshop itself was held earlier. Dates without ` +
      `the marker are that contribution's own.`
    );
  }

  // The detail lines under a contribution's description — only the fields
  // that layer's schema actually filled in, minus the one rating the card has
  // already promoted to its own "assigned score" line. Printing "Priority
  // 2 of 5" above and "Priority (1 low – 5 high): 2" three lines below reads
  // as two different facts.
  function opportunityDetails(r) {
    const promoted = r.score && r.score.rowKey;
    return OPP_DETAIL_LABELS.filter(([key]) => key !== promoted)
      .map(([key, label]) => [label, r[key]])
      .filter(([, v]) => v !== null && v !== undefined && v !== "");
  }

  // The panel's own block: one card per contribution in the five nearest.
  //
  // It used to print up to twelve, tier-ordered. Bryan, 27 Aug: "it should show
  // the top 5 nearest, sorted by distance." So the list is opps.nearest — five
  // rows, distance-ascending — and what the search found beyond them is a
  // count in a note rather than fourteen more cards. The old PANEL_OPP_LIMIT
  // (12) and PRINT_OPP_LIMIT (50) are gone with it: OPP_NEAREST_N is now the
  // only number that decides how long this section is, in the panel and on
  // paper alike.
  //
  // What this costs, and it is a real cost: the PDF no longer carries every
  // contribution it found. On the densest parcel tested that is 5 printed of
  // 5 found, so nothing is lost today — but a parcel in a cluster will show
  // five cards and a line saying how many more the map draws. One constant
  // reverses it if Bryan wants the long list on paper.

  // The eight lines of a card, in the order Bryan asked for them: org, contact
  // name, email, assigned score, date added, source layer, description,
  // distance. Panel and print build the same card from this one function so
  // they cannot drift; `p` is the class prefix ("pr-opp" or "pr-opp-print").
  //
  // The first five are the fields this round added. They are always rendered,
  // even when the answer is "not recorded" — see the NOT_RECORDED comment.
  function opportunityCardLines(r, p, opts) {
    const linkEmail = !!(opts && opts.linkEmail);
    const c = opportunityContactParts(r);
    const lines = [];

    // 1. org — and the rank, so the card and the numbered figure agree.
    lines.push(
      el("div", { className: p + "-head" },
        el("span", {
          className: p + "-org",
          textContent: (r.nearestRank ? r.nearestRank + ". " : "") + opportunityOrgText(r),
        })
      )
    );

    // 2 + 3. contact name, then email. One line: they are one fact.
    const contact = el("div", { className: p + "-field " + p + "-contact" });
    contact.append(
      el("span", {
        // "" not null: el() Object.assigns props straight onto the node, and
        // a null className lands as the literal string "null".
        className: c.hasName ? "" : p + "-missing",
        textContent: c.name,
      }),
      el("span", { textContent: " · " })
    );
    if (c.hasEmail && linkEmail) {
      contact.append(el("a", { href: "mailto:" + c.email, textContent: c.email }));
    } else {
      contact.append(
        el("span", { className: c.hasEmail ? "" : p + "-missing", textContent: c.email })
      );
    }
    lines.push(contact);

    // 4. the assigned score, with its scale.
    lines.push(
      el("div", {
        className: p + "-field " + p + "-score" + (r.score ? "" : " " + p + "-missing"),
        textContent: opportunityScoreText(r),
      })
    );

    // 5. date added, with the bulk-load caveat when it applies.
    lines.push(
      el("div", {
        className: p + "-field " + p + "-added" + (r.contributedOn ? "" : " " + p + "-missing"),
        textContent: opportunityAddedText(r),
      })
    );

    // 6. source layer — the only type distinction the data carries.
    lines.push(el("div", { className: p + "-type", textContent: r.type + " · " + r.source }));

    // 7. description.
    lines.push(
      el("div", {
        className: p + "-desc" + (r.description ? "" : " " + p + "-missing"),
        textContent: r.description || "Description " + NOT_RECORDED,
      })
    );

    // The rest of the survey answers, unchanged — under the description, where
    // they were, because they are detail and the eight fields above are not.
    const details = opportunityDetails(r);
    if (details.length) {
      lines.push(
        el("div", {
          className: p + "-meta",
          textContent: details.map(([k, v]) => `${k}: ${v}`).join(" · "),
        })
      );
    }

    // 8. distance, last, as the ask ordered it.
    lines.push(
      el("div", { className: p + "-field " + p + "-whereline" },
        el("span", {
          className:
            p + "-where" +
            (r.relation === ON_PARCEL ? " pr-opp-on" : "") +
            (r.relation === ON_ADJACENT ? " pr-opp-adj" : "") +
            (r.relation === WIDER ? " pr-opp-wide" : ""),
          textContent: opportunityWhere(r),
        })
      )
    );
    return lines;
  }

  /**
   * The same card, as plain text, for Plate 3's legend column.
   *
   * Bryan, 27 Aug: the nearest-5 plate should carry "data rich labeling (same
   * info in the report but in the legend for the map)". "Same info" is the
   * whole requirement, so this calls the SAME helpers opportunityCardLines()
   * calls — opportunityOrgText, opportunityContactParts, opportunityScoreText,
   * opportunityAddedText, opportunityWhere. Two formatters over one set of
   * helpers; the helpers are where the wording lives, and there is one of them.
   *
   * The rank is not in the head line: the plate draws it as a numbered disc
   * beside the block, the way the map draws it.
   *
   * `style` is a hint js/report-maps.js turns into a canvas font: "head",
   * "body", "quiet", "missing" (grey italic — a field nobody collected has to
   * look different from one that is merely short).
   */
  function opportunityLegendLines(r) {
    const maps = window.NRPCReportMaps;
    const clip = maps && maps._internals ? maps._internals.clip : s => s;
    const cap = maps && maps._internals ? maps._internals.CARD_DESC_MAX : 220;
    const c = opportunityContactParts(r);
    const hasScore = !!(r.score && r.score.value !== null && r.score.value !== undefined);
    return [
      { text: opportunityOrgText(r), style: r.organization ? "head" : "missing" },
      { text: c.name + " · " + c.email, style: c.hasName || c.hasEmail ? "body" : "missing" },
      { text: opportunityScoreText(r), style: hasScore ? "body" : "missing" },
      { text: opportunityAddedText(r), style: r.contributedOn ? "body" : "missing" },
      { text: r.type + " · " + r.source, style: "quiet" },
      {
        text: r.description ? clip(r.description, cap) : "Description " + NOT_RECORDED,
        style: r.description ? "body" : "missing",
      },
      { text: opportunityWhere(r), style: "quiet" },
    ];
  }

  function opportunityPanelBlock(opps, bufferM) {
    const box = el("div", { className: "pr-opps" });
    const searched = adjacencyWorked(opps) ? opps.adjacency.parcelsSearched : 0;
    const n = opps && opps.nearest ? opps.nearest.length : 0;
    box.append(
      el("div", { className: "pr-opps-head" },
        el("span", {
          className: "pr-opps-title",
          textContent: "Shared opportunities — nearest " + (n || OPP_NEAREST_N),
        }),
        el("span", {
          className: "pr-opps-sub",
          textContent: searched
            ? `The closest NRPC coalition contributions on this parcel, on the ${searched} touching it, or within ${bufferM} m`
            : `The closest NRPC coalition contributions within ${bufferM} m`,
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

    if (!n) {
      box.append(el("div", { className: "pr-opps-empty", textContent: opportunityEmptyText(opps) }));
    } else {
      const list = el("ul", { className: "pr-opp-list" });
      opps.nearest.forEach(r => {
        const li = el("li", { className: "pr-opp" });
        // mailto: in the panel, plain text on paper — a link a reader can
        // click is worth having where clicking is possible.
        opportunityCardLines(r, "pr-opp", { linkEmail: true }).forEach(node => li.append(node));
        list.append(li);
      });
      box.append(list);
      const beyond = opps.items.length - opps.nearest.filter(r => r.relation !== WIDER).length;
      if (beyond > 0) {
        box.append(
          el("div", {
            className: "pr-opps-note",
            textContent:
              `${beyond} further contribution${beyond === 1 ? " is" : "s are"} in scope and not listed — ` +
              `this is the nearest ${opps.nearest.length}. All of them are drawn on the map.`,
          })
        );
      }
    }

    const widenLine = widenNote(opps);
    if (widenLine) {
      box.append(el("div", { className: "pr-opps-note", textContent: widenLine }));
    }
    const bulkLine = bulkLoadNote(opps);
    if (bulkLine) {
      box.append(el("div", { className: "pr-opps-note", textContent: bulkLine }));
    }
    const emailLine = contactEmailNote(opps);
    if (emailLine && n) {
      box.append(el("div", { className: "pr-opps-note", textContent: emailLine }));
    }

    // How wide the search went and what it discarded. Worth one line whether
    // or not anything was found — "nothing here" means more when you can see
    // that eleven neighbouring parcels were checked.
    const adjLine = adjacencyNote(opps);
    if (adjLine) {
      box.append(
        el("div", {
          className: opps.adjacency.unavailable ? "pr-warn" : "pr-opps-note",
          textContent: adjLine,
        })
      );
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
  function buildPrintDoc(root, facts, reportHTML, meta, maps) {
    const f = facts;
    root.innerHTML = "";

    const section = (heading, ...kids) => {
      const kept = kids.filter(Boolean);
      if (!kept.length) return;
      const s = el("section", { className: "pr-print-section" });
      s.append(el("h2", { textContent: heading }), ...kept);
      root.append(s);
    };

    /**
     * One inline argument map, or null when the capture was not made — a
     * failed capture simply leaves the section as it was, because an export
     * missing a figure beats an export that did not happen.
     *
     * Append it with appendFigure() below and never with a bare
     * `parent.append(figureFor(k))`: Node.append() STRINGIFIES a null argument,
     * so the two unguarded call sites here were printing the literal word
     * "null" into the document. Measured on PID 2411921110001 with the captures
     * off — "Total tax $0 null" under the parcel table, and a second "null"
     * under the context note.
     *
     * The <img> src is a data: URL. docx-writer.js recognises .pr-print-figure
     * and turns the same bytes into a w:drawing, so one capture serves the PDF
     * and the DOCX.
     */
    const figureFor = kind => {
      const fig = maps && maps.figures ? maps.figures.find(x => x.kind === kind) : null;
      if (!fig) return null;
      const node = el("figure", { className: "pr-print-figure" });
      const img = el("img", { className: "pr-print-figure-img" });
      img.src = fig.dataUrl;
      img.alt = fig.title + " — " + fig.caption;
      img.setAttribute("data-nrpc-figure", kind);
      // Explicit pixel dimensions, because #pr-print is display:none until the
      // print stylesheet arms and an undisplayed <img> never decodes — its
      // naturalWidth is 0, and docx-writer.js sized the plate from a fallback
      // aspect ratio because of it.
      img.width = fig.width;
      img.height = fig.height;
      const cap = el("figcaption");
      cap.append(
        el("span", { className: "pr-print-figure-title", textContent: fig.title + " " }),
        el("span", { className: "pr-print-figure-caption", textContent: fig.caption }),
        el("span", { className: "pr-print-figure-source", textContent: fig.source })
      );
      node.append(img, cap);
      return node;
    };

    const appendFigure = (parent, kind) => {
      const fig = figureFor(kind);
      if (fig) parent.append(fig);
    };

    // -- header --
    // Hennepin writes an all-zero ZIP_CD where it has none; printing "00000"
    // under the address would read as a real zip.
    const zip = zeroStrOrNull(f.identity.zip);
    const where = f.multi
      ? [
          `${f.multi.count} parcels`,
          f.land.parcelAcres !== null ? `${f.land.parcelAcres} acres total` : null,
          f.identity.city,
        ]
          .filter(Boolean)
          .join(" · ")
      : [f.identity.address, f.identity.city, zip].filter(Boolean).join(", ") ||
        "No street address on the county record";
    const head = el("header", { className: "pr-print-head" });
    head.append(
      el("div", {
        className: "pr-print-kicker",
        textContent: "NRPC Interactive Map · " + (f.multi ? "Parcels Report" : "Parcel Report"),
      }),
      el("h1", {
        className: "pr-print-title",
        textContent: f.multi
          ? "PIDs " + f.multi.pids.join(" · ")
          : "PID " + (f.identity.pid || "unknown"),
      }),
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

    /**
     * The county-record table for ONE parcel's facts — the whole of "The
     * parcel" section on a single-parcel report, and one table per parcel on
     * a multi-parcel one. Same rows either way, so the two cannot drift.
     */
    const parcelRecordTable = pf => {
      const pzip = zeroStrOrNull(pf.identity.zip);
      const pwhere =
        [pf.identity.address, pf.identity.city, pzip].filter(Boolean).join(", ") ||
        "No street address on the county record";
      const legal = [
        pf.identity.legalAddition,
        pf.identity.lot ? "Lot " + pf.identity.lot : null,
        pf.identity.block ? "Block " + pf.identity.block : null,
      ]
        .filter(Boolean)
        .join(", ");
      // No sale date means no sale on the record — a bare "$0" there would
      // read as a fact rather than as an absence.
      const soldOn = saleDate(pf.value.lastSaleDateYYYYMM);
      const sale = soldOn
        ? [soldOn, money(pf.value.lastSalePrice), pf.value.lastSaleType].filter(Boolean).join(" · ")
        : null;
      return printTable([
        ["PID", pf.identity.pid],
        ["Address", pwhere],
        ...ownerRows(pf),
        ["Legal description", legal],
        [
          "Size",
          pf.land.parcelAcres === null
            ? null
            : `${pf.land.parcelAcres} acres (${Math.round(pf.land.parcelAreaSqFt).toLocaleString("en-US")} sq ft)`,
        ],
        ["Property type", pf.land.propertyType],
        ["Homestead", pf.land.homesteadStatus],
        ["Year built", pf.land.yearBuilt],
        ["Tax-forfeit land", pf.land.taxForfeitLand],
        ["School district", pf.land.schoolDistrict],
        ["Watershed no.", pf.land.watershedNo],
        ["Est. market value", money(pf.value.estimatedMarketValueTotal)],
        ["Est. land value", money(pf.value.estimatedLandValue)],
        ["Est. building value", money(pf.value.estimatedBuildingValue)],
        ["Total tax", money(pf.value.totalTax)],
        ["Last sale", sale],
      ]);
    };

    // The per-parcel model rows, used by both report shapes.
    const modelRankText = pf =>
      pf.model === null || pf.model.rank === null
        ? "not ranked"
        : pf.model.rank.toLocaleString("en-US") +
          (pf.model.parcelsRanked
            ? ` of ${pf.model.parcelsRanked.toLocaleString("en-US")} ranked parcels ` +
              `(top ${topPct(pf.model.rank, pf.model.parcelsRanked)} of the county)`
            : "");

    if (!f.multi) {
      // -- the parcel --
      section("The parcel", parcelRecordTable(f));

      appendFigure(root, "facts");

      // -- the model --
      if (f.model) {
        section(
          "Prioritization model",
          printTable([
            ["County rank", modelRankText(f)],
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
    } else {
      // -- the selection --
      const incomplete = key =>
        f.multi.valueComplete[key] ? "" : " — incomplete: a parcel in the selection has no figure";
      section(
        "The selection",
        printTable([
          ["Parcels", String(f.multi.count)],
          ["PIDs", f.multi.pids.join(", ")],
          ["Cities", f.identity.city],
          [
            "Total size",
            f.land.parcelAcres === null
              ? null
              : `${f.land.parcelAcres} acres (${Math.round(f.land.parcelAreaSqFt).toLocaleString("en-US")} sq ft)`,
          ],
          ["Property types", f.land.propertyType],
          [
            "Combined est. market value",
            f.value.estimatedMarketValueTotal === null
              ? null
              : money(f.value.estimatedMarketValueTotal) + incomplete("estimatedMarketValueTotal"),
          ],
          [
            "Combined est. land value",
            f.value.estimatedLandValue === null
              ? null
              : money(f.value.estimatedLandValue) + incomplete("estimatedLandValue"),
          ],
          [
            "Combined total tax",
            f.value.totalTax === null ? null : money(f.value.totalTax) + incomplete("totalTax"),
          ],
        ]),
        el("p", {
          className: "pr-print-note",
          textContent:
            "Totals are sums over the selected parcels' county records. The prioritization " +
            "model ranks parcels one at a time, so there is no combined rank — each parcel's " +
            "rank and scores are in its own table below.",
        })
      );

      appendFigure(root, "facts");

      // -- each parcel, in selection order --
      f.parcels.forEach((pf, i) => {
        const modelBits = pf.model
          ? [
              printTable([
                ["County rank", modelRankText(pf)],
                ...SCORE_FIELDS.map(([, alias]) => {
                  const v = num(pf.model.scores[alias]);
                  return [alias, v === null ? null : v.toFixed(3)];
                }),
              ]),
            ]
          : [
              el("p", {
                className: "pr-print-note",
                textContent: "This parcel is not present in the prioritization model layer.",
              }),
            ];
        section(
          `Parcel ${i + 1} of ${f.multi.count} — PID ${pf.identity.pid || "unknown"}`,
          parcelRecordTable(pf),
          el("h3", { textContent: "Prioritization model" }),
          ...modelBits
        );
      });
      if (f.parcels.some(pf => pf.model)) {
        root.append(
          el("p", { className: "pr-print-note", textContent: f.parcels.find(pf => pf.model).model.note })
        );
      }
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
          "A count marked + is a floor: the query returns at most eight features per layer." +
          (f.multi
            ? " For this selection each parcel was matched separately and the rows merged: " +
              "named features near more than one parcel are counted once; a count is a floor " +
              "where features carry no name to merge on."
            : ""),
      })
    );

    appendFigure(root, "context");

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
    } else if (!opps.nearest.length) {
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
      // A sub-heading, not just a bolder paragraph: js/docx-writer.js maps h3
      // to Heading2, so this is also what gives the DOCX a real outline entry
      // under "Shared opportunities".
      oppSection.append(
        el("h3", { textContent: "Nearest " + opps.nearest.length })
      );
      oppSection.append(
        el("p", {
          className: "pr-print-note",
          textContent:
            "Sorted by distance from the parcel boundary, closest first. Contact details are printed " +
            "because this report is for internal NRPC coalition members.",
        })
      );
      opps.nearest.forEach(r => {
        const item = el("div", { className: "pr-opp-print" });
        // Same card as the panel, same order, plain-text email — a mailto on
        // paper is a string with extra punctuation.
        opportunityCardLines(r, "pr-opp-print", { linkEmail: false }).forEach(node =>
          item.append(node)
        );
        oppSection.append(item);
      });
      const printBeyond = opps.items.length - opps.nearest.filter(r => r.relation !== WIDER).length;
      if (printBeyond > 0) {
        oppSection.append(
          el("p", {
            className: "pr-print-note",
            textContent:
              `${printBeyond} further contribution${printBeyond === 1 ? " is" : "s are"} on this parcel, on a ` +
              `parcel touching it, or within ${opps.bufferMetres} m and ${
                printBeyond === 1 ? "is" : "are"
              } not printed — this section is the nearest ${opps.nearest.length}. ` +
              `The map below draws all of them.`,
          })
        );
      }
      const printWiden = widenNote(opps);
      if (printWiden) {
        oppSection.append(el("p", { className: "pr-print-note", textContent: printWiden }));
      }
      const printBulk = bulkLoadNote(opps);
      if (printBulk) {
        oppSection.append(el("p", { className: "pr-print-note", textContent: printBulk }));
      }
      const printEmail = contactEmailNote(opps);
      if (printEmail) {
        oppSection.append(el("p", { className: "pr-print-note", textContent: printEmail }));
      }
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
    // How far the search went and what it discarded — on the page, because the
    // printed report is the one that gets forwarded without the map beside it.
    const printAdjLine = adjacencyNote(opps);
    if (printAdjLine) {
      oppSection.append(el("p", { className: "pr-print-note", textContent: printAdjLine }));
    }
    // Skip the boilerplate when the section has nothing to qualify.
    if (opps && (opps.items.length || !opps.unavailable.length)) {
      oppSection.append(
        el("p", {
          className: "pr-print-note",
          // opps.note already explains what the distances are measured from;
          // the only thing left to say on paper is what they are not.
          textContent: opps.note + " They are not travel distances.",
        })
      );
    }
    // The adjacency map belongs INSIDE the opportunities section, not after
    // it: it is the evidence for the tiers the section just listed.
    appendFigure(oppSection, "opportunity");
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
          "The name and — where the record carries one — the email of the person who " +
          "contributed each shared opportunity ARE printed here, because they are who to " +
          "call and this report is written for internal NRPC coalition members. Neither " +
          "reaches the language model: the request it is sent carries the organisation " +
          "and the description, never the individual.",
      }),
      el("p", {
        textContent:
          "The brief is written by a language model from the data above and is not a " +
          "substitute for a site visit, a survey, or a title search.",
      })
    );
    // A capture that did not happen is said out loud rather than left as a
    // gap the reader has to notice.
    if (maps && maps.failures && maps.failures.length) {
      foot.append(
        el("p", {
          textContent:
            "Some maps could not be captured for this export (" +
            maps.failures.join(", ") +
            ") and the sections they belong to are printed without them.",
        })
      );
    }
    root.append(foot);

    // -- the 8.5 x 11 plates, one per page --
    // Last, and page-broken before each, so they are sheets a reader can pull
    // out. Three of them since 27 Aug: the parcel and its neighbourhood, then
    // ecological sensitivity and suitability, then the nearest shared
    // opportunities with the whole card in the legend.
    const plateList = (maps && maps.plates) || (maps && maps.plate ? [maps.plate] : []);
    plateList.forEach(pl => {
      const plate = el("section", { className: "pr-print-plate" });
      const img = el("img", { className: "pr-print-plate-img" });
      img.src = pl.dataUrl;
      img.alt = pl.alt || "Parcel map plate.";
      img.setAttribute("data-nrpc-figure", "plate-" + pl.name);
      img.setAttribute("data-nrpc-plate-orientation", pl.orientation);
      img.width = pl.width;
      img.height = pl.height;
      plate.append(img);
      root.append(plate);

      // Plate 3's legend is nine lines a site, drawn on a landscape sheet that
      // the DOCX scales to the 7-inch text column. Measured at that width the
      // body type lands at about 6.5 pt — legible in the PDF, marginal in
      // Word, and unreadable if anyone prints the .docx at anything less than
      // 100%. So the DOCX gets the same rows a second time as real text under
      // the image. The PDF does not need it and does not get it: the plate is
      // the deliverable, and repeating a legend under it on paper is noise.
      if (pl.name === "sites" && pl.legendRows && pl.legendRows.length) {
        const t = el("table", { className: "pr-print-plate-legend pr-docx-only" });
        pl.legendRows.forEach(([kk, vv]) => {
          const tr = el("tr");
          tr.append(el("td", { textContent: kk }), el("td", { textContent: vv }));
          t.append(tr);
        });
        root.append(t);
      }
    });
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
    // Multi-select: the same control on desktop and on the phone, because
    // this header is also the mobile sheet's header. Ctrl/Cmd/Shift-click
    // does the same thing without the mode for anyone with a keyboard.
    const addToggle = el("button", {
      id: "pr-add-toggle",
      type: "button",
      textContent: "+ Add parcels",
      title:
        "Add parcels: while on, clicking the map adds each parcel to the selection " +
        "instead of replacing it (clicking a selected parcel removes it). " +
        "Ctrl-, Cmd- or Shift-click does the same without turning this on. " +
        "The report covers every selected parcel.",
    });
    const closeBtn = el("button", { id: "pr-close", textContent: "×", title: "Close" });
    header.append(title, addToggle, closeBtn);

    const body = el("div", { id: "pr-body" });

    const hint = el("div", {
      className: "pr-hint",
      textContent: "Click a parcel on the map to load its details.",
    });
    body.append(hint);

    // The selection bar: one chip per selected parcel, shown whenever the
    // selection is plural (or add mode is on, so the mechanism is visible
    // before the second parcel lands).
    const selBar = el("div", { id: "pr-selection", className: "hidden" });
    body.append(selBar);

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

    // Appears with the facts, not with the brief: a parcel is shareable and
    // exportable the moment it is selected. "Export as PDF" stays where it
    // was — it prints the brief, so it still waits for one.
    const shareRow = el("div", { id: "pr-share-row", className: "hidden" });
    const docxBtn = el("button", {
      id: "pr-export-docx",
      type: "button",
      textContent: "Export as DOCX",
      title: "A Word document of this report — the same sections as the printed one",
    });
    const shareBtn = el("button", {
      id: "pr-share",
      type: "button",
      textContent: "Share",
      title:
        "Copies a link to this parcel. The link opens the same parcel; it does not " +
        "carry the generated brief, your API key, or owner names.",
    });
    const shareNote = el("span", {
      className: "pr-export-note",
      id: "pr-share-note",
      textContent: "The link opens this parcel — not the brief.",
    });
    shareRow.append(docxBtn, shareBtn, shareNote);

    body.append(factsBox, actions, reportBox, exportRow, shareRow);

    // One toast for the panel's own messages — "Link copied", "DOCX failed".
    // The mobile layer has its own; this one belongs to the report and works
    // on a desktop too.
    const toast = el("div", { id: "pr-toast", className: "hidden" });
    document.body.appendChild(toast);
    let toastTimer = null;
    function say(text, kind, ms) {
      toast.textContent = text;
      toast.className = kind ? "pr-toast-" + kind : "";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.add("hidden"), ms || 3500);
    }

    // The printable document. Lives outside the panel, hidden on screen, and
    // is the only thing the print stylesheet leaves visible.
    const printRoot = el("div", { id: "pr-print" });
    document.body.appendChild(printRoot);

    // -- generate / owner toggle --
    const generateBtn = el("button", { id: "pr-generate", textContent: "Generate report" });
    const ownerWrap = el("label", { className: "pr-owner-toggle" });
    const ownerCb = el("input", { type: "checkbox", id: "pr-include-owner" });
    // ON unless this browser has been told otherwise. The panel and the printed
    // report always state the owner; this only governs whether the MODEL is
    // told, so it is an opt-out from sending a public record to a third party,
    // not the switch that decides whether the report answers the question.
    ownerCb.checked = (() => {
      try {
        return localStorage.getItem(OWNER_KEY) !== "0";
      } catch (_) {
        return true;
      }
    })();
    ownerCb.addEventListener("change", () => {
      try {
        localStorage.setItem(OWNER_KEY, ownerCb.checked ? "1" : "0");
      } catch (_) {}
    });
    ownerWrap.append(
      ownerCb,
      el("span", {
        textContent: "Include owner name in the brief",
        title:
          "Owner, taxpayer and the taxpayer's mailing address are public Hennepin County " +
          "assessor records. They are always shown in the panel and the exported report; " +
          "untick this to keep them out of the request sent to Anthropic.",
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
    // The selected parcels, in the order they were added: {pid, feature,
    // facts, point}. One entry is the single-parcel report unchanged; more
    // than one and `facts` above becomes combineFacts() over these.
    let selection = [];
    // While on, a plain map click ADDS the parcel to the selection instead of
    // replacing it. Ctrl/Cmd/Shift-click adds regardless.
    let addMode = false;
    let busy = false;
    let abortCtl = null;
    // Date.now() at the moment the current selection started. Set by
    // beginLoad(), read by selectParcelFeature() for the total stage timing.
    let loadStart = 0;
    // The finished report: its Markdown, the HTML we rendered from it, when it
    // finished, and which model wrote it. Null until one completes — which is
    // exactly the condition the export button appears under.
    let lastReport = null;
    // Where the current selection was made, in lon/lat. Companion features
    // (Street View) need the point, not just the attributes.
    let lastPoint = null;
    // A companion module may claim a map click before the parcel path sees it
    // — see setClickInterceptor() below. There is exactly one, because there
    // is exactly one map-click handler in the app.
    let clickInterceptor = null;
    const selectListeners = [];

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
      // One companion panel over the map at a time — opening the report closes
      // Street View. js/panel-exclusivity.js carries the rule and the reason
      // (two open panels took the map's own click surface away).
      if (window.NRPCPanels) window.NRPCPanels.claim("report");
      panel.classList.add("open");
      tab.textContent = "▶";
    }
    function closePanel() {
      panel.classList.remove("open");
      tab.textContent = "◀";
    }
    if (window.NRPCPanels) {
      window.NRPCPanels.register("report", {
        isOpen: () => panel.classList.contains("open"),
        close: closePanel,
      });
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
      shareRow.classList.remove("hidden");
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

    /**
     * Clear the panel back to "loading" and start the clock. Every selection
     * begins here, whichever path asked for it.
     */
    function beginLoad() {
      if (abortCtl) abortCtl.abort();
      facts = null;
      selection = [];
      clearReport();
      keyForm.classList.add("hidden");
      factsBox.classList.add("hidden");
      actions.classList.add("hidden");
      shareRow.classList.add("hidden");
      hint.classList.remove("hidden");
      hint.textContent = "Loading parcel…";
      openPanel();
      highlightLayer.removeAll();
      renderChips();

      lastPoint = null;
      loadStart = Date.now();
      resetTimings(loadStart);
      return loadStart;
    }

    /**
     * The add-path counterpart of beginLoad(): the selection and its rendered
     * facts stay on screen, but a brief mid-stream is aborted and a finished
     * one cleared — a report over two parcels is not the report over three.
     */
    function beginAdd() {
      if (abortCtl) abortCtl.abort();
      clearReport();
      keyForm.classList.add("hidden");
      openPanel();
      setStatus("Adding parcel…", "busy");
      loadStart = Date.now();
      resetTimings(loadStart);
      return loadStart;
    }

    // One chip per selected parcel. Clicking a chip's × removes that parcel;
    // the bar appears once the selection is plural or add mode is on.
    function renderChips() {
      selBar.innerHTML = "";
      const show = selection.length > 1 || (addMode && selection.length > 0);
      selBar.classList.toggle("hidden", !show);
      title.textContent =
        selection.length > 1 ? `Parcels Report (${selection.length})` : "Parcel Report";
      if (!show) return;
      selection.forEach(entry => {
        const chip = el("span", { className: "pr-chip" });
        const label = el("span", {
          className: "pr-chip-label",
          textContent: "PID " + entry.pid,
          title: [entry.facts.identity.address, entry.facts.identity.city].filter(Boolean).join(", ") || "",
        });
        const x = el("button", {
          className: "pr-chip-x",
          type: "button",
          textContent: "×",
          title: "Remove this parcel from the selection",
        });
        x.addEventListener("click", () => removeParcel(entry.pid));
        chip.append(label, x);
        selBar.append(chip);
      });
      if (selection.length > 1) {
        const note = el("span", {
          className: "pr-chip-note",
          textContent: "One report covers all " + selection.length + ".",
        });
        selBar.append(note);
      }
    }

    /**
     * Everything downstream of "the selection changed": derive the report
     * facts (one parcel's own, or combineFacts() over all of them), redraw
     * every outline, render, and tell the listeners. Every path that adds,
     * removes or replaces parcels ends here, so none of them can drift.
     */
    function finishSelection(point) {
      if (!selection.length) {
        facts = null;
        lastPoint = null;
        highlightLayer.removeAll();
        renderChips();
        clearReport();
        factsBox.classList.add("hidden");
        actions.classList.add("hidden");
        shareRow.classList.add("hidden");
        hint.classList.remove("hidden");
        hint.textContent = "Click a parcel on the map to load its details.";
        setStatus("");
        return null;
      }
      facts = selection.length === 1 ? selection[0].facts : combineFacts(selection);
      lastPoint = point ? { ...point } : { ...selection[selection.length - 1].point };
      highlightLayer.removeAll();
      selection.forEach(entry => {
        if (!entry.feature || !entry.feature.geometry) return;
        highlightLayer.add(
          new Graphic({
            geometry: {
              type: "polygon",
              rings: entry.feature.geometry.rings,
              spatialReference: { wkid: 4326 },
            },
            symbol: HIGHLIGHT_SYMBOL,
          })
        );
      });
      stageTimings.total = { startedAt: 0, ms: Date.now() - loadStart };
      stageTimings.pid = facts.multi ? facts.multi.pids.join(",") : facts.identity.pid;
      renderChips();
      showFacts(facts);
      setStatus("");
      selectListeners.forEach(fn => {
        try {
          fn(facts, lastPoint);
        } catch (e) {
          console.warn("[parcel-report] onSelect listener failed:", e);
        }
      });
      return facts;
    }

    function removeParcel(pid) {
      const before = selection.length;
      selection = selection.filter(e => e.pid !== pid);
      if (selection.length === before) return;
      clearReport();
      finishSelection(null);
    }

    /**
     * Everything downstream of "we are holding the parcel feature": outline it,
     * assemble the facts, render them. This is the seam the selection paths
     * meet at — the desktop map click, the mobile "use my location" tap and a
     * PID selection — so none can drift. Call beginLoad() first. REPLACES the
     * selection; the add path goes through toggleParcelFeature().
     */
    async function selectParcelFeature(feature, lon, lat) {
      if (!feature) {
        hint.textContent = "No Hennepin County parcel at that point.";
        return null;
      }
      const f = await assembleFacts(feature, lon, lat);
      selection = [{ pid: f.identity.pid, feature, facts: f, point: { lon, lat } }];
      return finishSelection({ lon, lat });
    }

    /**
     * The add path: a parcel already selected is removed, anything else is
     * assembled and appended. Call beginAdd() first.
     */
    async function toggleParcelFeature(feature, lon, lat) {
      if (!feature) {
        say("No Hennepin County parcel at that point.", "warn", 3500);
        setStatus("");
        return facts;
      }
      const pid = clean(feature.attributes && feature.attributes.PID);
      const already = pid && selection.some(e => e.pid === pid);
      if (already) {
        selection = selection.filter(e => e.pid !== pid);
        say("PID " + pid + " removed from the selection.", "ok", 3000);
        return finishSelection(null);
      }
      const f = await assembleFacts(feature, lon, lat);
      selection.push({ pid: f.identity.pid, feature, facts: f, point: { lon, lat } });
      return finishSelection({ lon, lat });
    }

    function setAddMode(on) {
      addMode = !!on;
      addToggle.classList.toggle("pr-add-on", addMode);
      renderChips();
    }
    addToggle.addEventListener("click", () => setAddMode(!addMode));

    async function loadParcel(lon, lat) {
      beginLoad();
      try {
        const feature = await timed("parcel", () => fetchParcelAt(lon, lat));
        await selectParcelFeature(feature, lon, lat);
      } catch (e) {
        hint.textContent = `Could not load the parcel: ${e.message}`;
      }
    }

    /**
     * Select a parcel by PID and move the map to it — the third selection
     * path, after the map click and the mobile fix. A search result and a
     * `?pid=` deep link both land here, and both end in the SAME
     * selectParcelFeature() the other two do, so none of the four can drift.
     *
     * The "point" a PID selection was made at is the centre of the parcel's
     * own bounding box; the report shows it as the clicked point, which is
     * true of how the selection was made.
     */
    async function selectByPid(pid, opts) {
      const o = opts || {};
      // A search result or a deep link honours the same add mode a map click
      // does, unless the caller says otherwise — so "Add parcels" plus the
      // search box builds a selection without touching the map.
      const additive = (o.add !== undefined ? o.add : addMode) && selection.length > 0;
      if (additive) beginAdd();
      else beginLoad();
      try {
        const feature = await timed("parcel", () => fetchParcelByPid(pid));
        if (!feature) {
          if (additive) say(`No Hennepin County parcel with PID ${pid}.`, "warn", 3500);
          else hint.textContent = `No Hennepin County parcel with PID ${pid}.`;
          setStatus("");
          return additive ? facts : null;
        }
        const bbox = feature.geometry ? ringsBBox(feature.geometry) : null;
        const lon = bbox ? (bbox.xmin + bbox.xmax) / 2 : null;
        const lat = bbox ? (bbox.ymin + bbox.ymax) / 2 : null;
        const f = additive
          ? await toggleParcelFeature(feature, lon, lat)
          : await selectParcelFeature(feature, lon, lat);
        if (bbox && o.zoom !== false) {
          // Padded so the parcel is not flush against the panel edge.
          const pad = padBBox(bbox, 120);
          const target = {
            type: "extent",
            xmin: pad.xmin, ymin: pad.ymin, xmax: pad.xmax, ymax: pad.ymax,
            spatialReference: { wkid: 4326 },
          };
          // A goTo animation is driven by requestAnimationFrame, and a HIDDEN
          // tab does not run one: the promise never settles and the map never
          // moves. That is not a hypothetical — it is exactly what a shared
          // "?pid=" link opened in a background tab does, and it is how this
          // was found (measured: goTo pending past 45 s with document.hidden
          // true). So a hidden tab jumps straight to the extent, and the
          // animation is kept for the case it can actually be seen.
          if (document.hidden) view.extent = target;
          else view.goTo({ target }).catch(() => {
            /* the user interrupted the animation — they win */
          });
        }
        return f;
      } catch (e) {
        hint.textContent = `Could not load PID ${pid}: ${e.message}`;
        return null;
      }
    }

    /**
     * Select several parcels by PID — the multi-parcel deep link
     * (?pid=A,B,C), and the path a script drives. Sequential on purpose:
     * each parcel's assembly is itself concurrent inside, and the selection
     * renders progressively. Zooms once, to the whole selection.
     */
    async function selectPids(pids, opts) {
      const o = opts || {};
      const list = (pids || []).filter(Boolean);
      if (!list.length) return null;
      let f = await selectByPid(list[0], { ...o, add: false, zoom: false });
      for (const pid of list.slice(1)) {
        f = await selectByPid(pid, { ...o, add: true, zoom: false });
      }
      if (o.zoom !== false && selection.length) {
        const boxes = selection
          .map(e => (e.feature.geometry ? ringsBBox(e.feature.geometry) : null))
          .filter(Boolean);
        if (boxes.length) {
          const all = boxes.reduce((acc, b) => ({
            xmin: Math.min(acc.xmin, b.xmin),
            ymin: Math.min(acc.ymin, b.ymin),
            xmax: Math.max(acc.xmax, b.xmax),
            ymax: Math.max(acc.ymax, b.ymax),
          }));
          const pad = padBBox(all, 120);
          const target = {
            type: "extent",
            xmin: pad.xmin, ymin: pad.ymin, xmax: pad.xmax, ymax: pad.ymax,
            spatialReference: { wkid: 4326 },
          };
          // Same hidden-tab rule as selectByPid: a background tab runs no
          // animation frames, so a goTo there never settles.
          if (document.hidden) view.extent = target;
          else view.goTo({ target }).catch(() => {});
        }
      }
      return f;
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
          system: facts.multi ? SYSTEM_PROMPT + SYSTEM_PROMPT_MULTI : SYSTEM_PROMPT,
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

    // ── Share ────────────────────────────────────────────────────────────────
    //
    // The share mechanism IS the deep link: ?pid=<PID> on this same page, which
    // main.js resolves on load through selectByPid(). Nothing else goes in the
    // URL — not the Anthropic key, not the owner or taxpayer names, and not the
    // brief. The brief is a paid generation from a private key and it is not
    // reproducible from a URL, so sharing it would promise something the link
    // cannot deliver; the tooltip and the note beside the button say so.

    function shareUrl() {
      if (!facts) return null;
      // A multi-parcel selection shares as ?pid=A,B,C — the same deep link,
      // reopened by selectPids() into the same selection.
      const pid = facts.multi ? facts.multi.pids.join(",") : facts.identity && facts.identity.pid;
      if (!pid) return null;
      const u = new URL(window.location.href);
      u.hash = "";
      u.search = "";
      u.searchParams.set("pid", pid);
      return u.toString();
    }

    shareBtn.addEventListener("click", async () => {
      const url = shareUrl();
      if (!url) return;
      const title = facts.multi
        ? `Parcels ${facts.multi.pids.join(", ")}`
        : "Parcel " + facts.identity.pid;
      const where = facts.multi
        ? [`${facts.multi.count} parcels`, facts.identity.city].filter(Boolean).join(", ")
        : [facts.identity.address, facts.identity.city].filter(Boolean).join(", ");
      // navigator.share is the right thing on a phone and needs the gesture we
      // are already inside. It rejects with AbortError when the user dismisses
      // the sheet — that is not a failure and must not fall through to a
      // "copied" toast for a link that was not copied.
      if (navigator.share) {
        try {
          await navigator.share({ title, text: where || title, url });
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return;
          // Anything else (no permission, unsupported target): fall through.
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        // 5 s, not the 3.5 s default: this one carries a caveat the reader
        // has to finish before it goes.
        say("Link copied — it opens this parcel, not the brief.", "ok", 5000);
      } catch (e) {
        // Clipboard denied (an insecure origin, or a browser that wants a
        // stricter gesture). Show the link rather than swallowing it.
        shareNote.textContent = url;
        shareNote.classList.add("pr-share-url");
        say("Could not reach the clipboard — the link is shown below.", "warn", 6000);
      }
    });

    // ── Export as DOCX ───────────────────────────────────────────────────────
    //
    // Built from the SAME print document "Export as PDF" prints, so the two
    // exports cannot drift into two different reports. It does not wait for a
    // brief: the facts, the scores, the context layers and the shared
    // opportunities are worth a document on their own, and the brief is added
    // to it when there is one.
    /**
     * Capture the report maps. Runs at EXPORT time, not on every selection:
     * four captures cost seconds and most selections are never exported, so
     * paying for them on each click would make the map feel slow for a feature
     * the user did not ask for.
     *
     * Never throws. A failed capture returns a result whose `failures` list
     * the print document prints, and the export goes ahead without the figure.
     */
    let lastMaps = null;
    async function prepareMaps(onStatus) {
      if (!window.NRPCReportMaps || !facts) return null;
      const t0 = Date.now();
      try {
        const maps = await window.NRPCReportMaps.buildAll(facts, onStatus, {
          // Plate 3's legend is the report's own card. See
          // opportunityLegendLines().
          cardLines: opportunityLegendLines,
        });
        maps.wallMs = Date.now() - t0;
        lastMaps = maps;
        return maps;
      } catch (e) {
        console.warn("[parcel-report] map capture failed wholesale:", e);
        return { figures: [], plates: [], plate: null, failures: ["all maps"], totalMs: Date.now() - t0 };
      }
    }

    docxBtn.addEventListener("click", async () => {
      if (!facts) return;
      if (!window.NRPCDocx) {
        say("The DOCX writer did not load (js/docx-writer.js).", "warn", 6000);
        return;
      }
      const label = docxBtn.textContent;
      docxBtn.disabled = true;
      docxBtn.textContent = "Preparing maps…";
      try {
        const meta = lastReport || { generatedAt: new Date(), model: null };
        const maps = await prepareMaps(s => {
          docxBtn.textContent = "Preparing maps…";
          setStatus(s, "ok");
        });
        docxBtn.textContent = "Building…";
        setStatus("");
        buildPrintDoc(printRoot, facts, lastReport ? lastReport.html : null, meta, maps);
        const slug = facts.multi
          ? facts.multi.count <= 3
            ? facts.multi.pids.join("+")
            : `${facts.multi.count}-parcels`
          : facts.identity.pid || "parcel";
        const docTitle = facts.multi
          ? `Parcels Report ${facts.multi.pids.join(", ")}`
          : "Parcel Report " + (facts.identity.pid || "parcel");
        const blob = await window.NRPCDocx.docxFromPrintRoot(printRoot, docTitle);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${facts.multi ? "parcels-report" : "parcel-report"}-${slug}.docx`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 2000);
        say(
          lastReport
            ? "DOCX saved — facts, scores, context, opportunities and the brief."
            : "DOCX saved — facts, scores, context and opportunities. Generate a report to include the brief.",
          "ok",
          5000
        );
      } catch (e) {
        say("Could not build the DOCX: " + e.message, "warn", 6000);
      } finally {
        docxBtn.disabled = false;
        docxBtn.textContent = label;
      }
    });

    exportBtn.addEventListener("click", async () => {
      if (!facts || !lastReport) return;
      const label = exportBtn.textContent;
      exportBtn.disabled = true;
      exportBtn.textContent = "Preparing maps…";
      let maps = null;
      try {
        maps = await prepareMaps(s => setStatus(s, "ok"));
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = label;
        setStatus("");
      }
      buildPrintDoc(printRoot, facts, lastReport.html, lastReport, maps);
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

    /**
     * THE map click handler. There is one, and it lives here.
     *
     * MERGE NOTE (integrate, 2026-08-26): the `street-view` branch registered a
     * second `view.on("click")` that opened its own right-hand panel, so a
     * merged click opened two panels on top of each other. Rather than let two
     * features race for the same gesture, the primary action — select the
     * parcel, open its report — stays here and unconditional, and a companion
     * feature may CLAIM a click by registering an interceptor that returns
     * true. Street View registers one, and only claims while the user has its
     * pick mode switched on.
     */
    async function handleMapClick(lat, lon, event) {
      if (typeof lat !== "number" || typeof lon !== "number") return null;
      if (clickInterceptor) {
        let claimed = false;
        try {
          claimed = clickInterceptor(lat, lon, event) === true;
        } catch (e) {
          console.warn("[parcel-report] click interceptor failed:", e);
        }
        if (claimed) return "intercepted";
      }
      // A modifier key adds to the selection whatever the mode; the header
      // toggle adds for anyone without a keyboard. ArcGIS wraps the DOM event
      // as event.native. Either way there must already be a selection to add
      // to — a modified first click is a plain selection.
      const native = event && event.native;
      const modified = !!(native && (native.ctrlKey || native.metaKey || native.shiftKey));
      if ((addMode || modified) && selection.length) {
        beginAdd();
        try {
          const feature = await timed("parcel", () => fetchParcelAt(lon, lat));
          await toggleParcelFeature(feature, lon, lat);
        } catch (e) {
          say("Could not load the parcel: " + e.message, "warn", 4000);
          setStatus("");
        }
        return "parcel-added";
      }
      await loadParcel(lon, lat);
      return "parcel";
    }

    view.on("click", async event => {
      const pt = event.mapPoint;
      if (!pt || typeof pt.latitude !== "number") return;
      await handleMapClick(pt.latitude, pt.longitude, event);
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
      // The body of the one map-click handler, callable without the map's
      // pointer pipeline. ArcGIS's own input manager does not turn synthesized
      // CDP pointer events into a view "click" in a background tab, so this is
      // how the click path — interceptor first, parcel second — is exercised
      // in a test. Returns "intercepted" or "parcel".
      mapClick: (lat, lon) => handleMapClick(lat, lon, null),
      hasClickInterceptor: () => !!clickInterceptor,
      // The one-panel-at-a-time invariant, as an assertion. { ok, open, count }
      // — ok is false the moment the report and the panorama are both up.
      assertOnePanel: () =>
        window.NRPCPanels
          ? window.NRPCPanels.assertOnePanel()
          : { ok: false, open: [], count: 0, error: "NRPCPanels not loaded" },
      // Wall-clock per stage for the last parcel loaded, in ms, with the
      // offset from the click at which each stage started — that is what
      // shows adjacency running alongside the context fetches rather than
      // after them. Read by outputs/make-timings.py; nothing in the UI uses it.
      get timings() {
        return JSON.parse(JSON.stringify(stageTimings));
      },
      get facts() {
        return facts;
      },
      showReport: md => showReport(md, modelSelect.value),
      selectByPid,
      // Multi-parcel test surface: build a selection without a keyboard or a
      // map gesture, and read back what is selected.
      selectPids,
      addByPid: pid => selectByPid(pid, { add: true }),
      removeParcel,
      setAddMode,
      get selection() {
        return selection.map(e => e.pid);
      },
      shareUrl,
      // Build the .docx and hand it back rather than downloading it, so a test
      // can open the bytes without driving a browser download.
      docxBlob: async withMaps => {
        const meta = lastReport || { generatedAt: new Date(), model: null };
        const maps = withMaps === false ? null : await prepareMaps(() => {});
        buildPrintDoc(printRoot, facts, lastReport ? lastReport.html : null, meta, maps);
        return window.NRPCDocx.docxFromPrintRoot(printRoot, "Parcel Report");
      },
      buildPrintDoc: async withMaps => {
        if (!facts || !lastReport) return false;
        const maps = withMaps === false ? null : await prepareMaps(() => {});
        buildPrintDoc(printRoot, facts, lastReport.html, lastReport, maps);
        document.body.classList.add("pr-print-ready");
        return true;
      },
      // The capture pipeline on its own, for verifying a map without building
      // a document around it. Returns {figures, plate, totalMs, failures}.
      prepareMaps: onStatus => prepareMaps(onStatus || (() => {})),
      get maps() {
        return lastMaps;
      },
    };

    updateFooter();

    // The surface a companion module drives the panel through. Everything here
    // is already used internally by the desktop path; nothing is mobile-only.
    const api = {
      view,
      Graphic,
      GraphicsLayer,
      beginLoad,
      selectParcelFeature,
      loadParcel,
      // Wrapped in the same stage timer the desktop path uses, so a mobile
      // selection shows up in dev.timings with a `parcel` stage like any other.
      fetchParcelAt: (lon, lat) => timed("parcel", () => fetchParcelAt(lon, lat)),
      openPanel,
      closePanel,
      isOpen: () => panel.classList.contains("open"),
      panel,
      body,
      header,
      tab,
      setHint: text => {
        hint.textContent = text;
        hint.classList.remove("hidden");
      },
      hasFacts: () => !!facts,
      onExport: fn => exportBtn.addEventListener("click", fn),
      // Where the open report's parcel is, or null.
      lastPoint: () => (lastPoint ? { ...lastPoint } : null),
      // The third selection path: by PID, from a search result or a deep link.
      selectByPid,
      // Several PIDs into one selection — the ?pid=A,B,C deep link.
      selectPids,
      // Multi-select state, for companion features that need to know.
      isAddMode: () => addMode,
      setAddMode,
      selectedPids: () => selection.map(e => e.pid),
      // The parcel lookups the search box drives. They live here because this
      // file already owns PARCEL_BASE and its field names; main.js owns the UI
      // and knows nothing about the service.
      search: { byPid: searchByPid, byAddress: searchByAddress },
      // The URL the Share button writes. Exposed so a caller can show it
      // without going through the clipboard.
      shareUrl,
      identity: () => (facts && facts.identity ? { ...facts.identity } : null),
      // Called after every successful selection, with (facts, point).
      onSelect: fn => {
        if (typeof fn === "function") selectListeners.push(fn);
      },
      /**
       * Hand a companion feature the right of first refusal on a map click.
       * fn(lat, lon, event) returns true to claim it — in which case no parcel
       * is selected for that click. One interceptor at a time, deliberately:
       * two features silently fighting over a click is the bug this replaces.
       */
      setClickInterceptor: fn => {
        clickInterceptor = typeof fn === "function" ? fn : null;
      },
    };
    window.NRPCParcelReport.api = api;

    // Hand off to the mobile layer, if it is present and this is a phone. It
    // decides for itself whether to do anything; on a desktop it returns
    // immediately and the app is unchanged.
    if (window.NRPCMobile && typeof window.NRPCMobile.init === "function") {
      try {
        window.NRPCMobile.init(api);
      } catch (e) {
        console.warn("[mobile] init failed, desktop behaviour retained:", e);
      }
    }
  }

  window.NRPCParcelReport = { init };
})();

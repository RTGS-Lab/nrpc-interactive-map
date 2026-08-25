/* ──────────────────────────────────────────────────────────────────────────
 * Parcel Report
 *
 * Click a parcel → a panel of the facts we can pull for it → "Generate report"
 * → a written site summary from Claude, streamed into the panel.
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
  const yearOrNull = v => {
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

  async function esriQuery(url, params) {
    const body = new URLSearchParams({ f: "json", ...params });
    const res = await fetch(url + "/query", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
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

  /**
   * Everything we know about the clicked parcel, in one plain object. This is
   * both what the panel renders and (minus the owner fields, unless asked)
   * what gets sent to the model. One shape, one source of truth.
   */
  async function assembleFacts(feature, lon, lat) {
    if (!feature) return null;

    const a = feature.attributes;
    const bbox = feature.geometry ? ringsBBox(feature.geometry) : null;

    const [scores, context, total] = await Promise.all([
      fetchModelScores(a.PID),
      bbox ? fetchContext(padBBox(bbox, CONTEXT_BUFFER_M)) : Promise.resolve([]),
      modelTotal(),
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
        yearBuilt: yearOrNull(a.BUILD_YR),
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
    "scores, and the natural-resource layers that fall on or near the parcel.",
    "",
    "Rules:",
    "- Use ONLY the supplied JSON. Do not add facts, history, ecology, or numbers from",
    "  anywhere else, and do not estimate a number the JSON does not contain.",
    "- Where a field is null or missing and it matters, say plainly that it is missing.",
    "- Context layers were matched against the parcel's bounding box padded by the given",
    "  buffer, so a hit means 'on or near', never 'inside'. Word it that way.",
    "- A count marked truncated is a floor, not a total.",
    "- Round figures for readability but never change them.",
    "- No preamble, no sign-off, no offer to help further.",
    "",
    "Write in Markdown, under 350 words, in exactly these sections:",
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
    "## What to check next",
    "Two to four concrete next steps for a planner, each tied to something specific in",
    "the data — including anything the data could not answer.",
  ].join("\n");

  function buildUserMessage(facts, includeOwner) {
    const payload = JSON.parse(JSON.stringify(facts));
    if (!includeOwner) {
      delete payload.owner;
      payload.ownerWithheld =
        "Owner and taxpayer names were deliberately withheld from this request.";
    }
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
    return rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
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
    body.append(factsBox, actions, reportBox);

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

    async function loadParcel(lon, lat) {
      if (abortCtl) abortCtl.abort();
      facts = null;
      reportBox.classList.add("hidden");
      reportBox.innerHTML = "";
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
      reportBox.classList.remove("hidden");
      reportBox.innerHTML = "";

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
        setStatus(text ? "Done." : "The model returned nothing.", text ? "ok" : "warn");
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

    updateFooter();
  }

  window.NRPCParcelReport = { init };
})();

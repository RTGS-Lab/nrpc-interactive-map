// Parcel export: "Export PDF" and "Export Word (.docx)" for the parcel in the Parcel card.
//
// Ask (Bryan, 2026-11-12): "Provide a PDF and word doc export of the parcel as well. Look at the
// other parcel export branch as an example of what these outputs should look like (minus all the
// LLM stuff)".
//
// PORTED, not rewritten, from branch multi-parcel @891c06a (RTGS-Lab/nrpc-interactive-map):
// - js/parcel-report.js: printTable(), fmtDateTime(), saleDate(), the shape of buildPrintDoc()
//   (kicker / title / sub / meta header, "The parcel" record table, inline figure, notes, footer
//   with the sources line), rasterizePrintImages() and the window.print() path ("No PDF library,
//   by choice": #pr-print + a print stylesheet; the browser's "Save as PDF" writes the file),
//   and the DOCX path (the SAME #pr-print rendered by js/docx-writer.js, so the two cannot drift).
// - js/report-maps.js: the off-screen second MapView, aerial basemap, parcel outline symbol,
//   frameExtent(), capture(), whenVisible(), whenStable(), paintSettled() (the user's map never
//   moves). Only the "facts" figure; a county locator is added on the same capture path (spec
//   3.5: "add a small county locator").
// - js/docx-writer.js: copied verbatim (last changed at 645457e on multi-parcel).
// - The print CSS for #pr-print / .pr-print-* in styles.css.
// - Met Council summary: the reference's context-layer idea (CONTEXT_LAYERS, fetchContext), here
//   one row per Met Council layer intersected with the parcel polygon (Bryan, round 8 addition).
// DROPPED: the LLM brief, its API-key form, model picker, streaming and prompts; shared
// opportunities, context layers and plates; owner / taxpayer rows (the card never prints owner
// fields); the demo login. The template "why this score" sentences come from the card.
//
// The scorecard section prints what the card shows (window.NRPCParcelCard ... .print): rank line
// or the protected / MSP line, class, the six category bars as a two-column table (category |
// drawn bar + "earned of possible; county median, 90th percentile") so the DOCX keeps every
// number where it drops the drawing, the why sentences, and the inputs with their sources (links
// only to full source layers, round-7 rule).
//
// Drop-out: this file and its script tag can be removed and the map still works; the buttons are
// added by this module into the Parcel section header.

window.NRPCParcelExport = (() => {
  "use strict";
  const fmt = n => Number(n).toLocaleString("en-US");
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    kids.flat().filter(k => k != null).forEach(k => n.append(k));
    return n;
  };
  const clean = v => (v == null ? "" : String(v).trim());
  const money = v => (v == null || v === "" || isNaN(Number(v)) ? null : "$" + Math.round(Number(v)).toLocaleString("en-US"));

  // ── ported from report-maps.js @891c06a ──────────────────────────────────────────────────
  const AERIAL_BASEMAP = "satellite";
  const ESRI_ATTRIB =
    "Imagery: Esri World Imagery — Esri, Maxar, Earthstar Geographics, and the GIS User Community";
  const DATA_ATTRIB = "Parcels: Hennepin County Survey Division";
  const INLINE_W = 1600, INLINE_H = 1000, LOCATOR_W = 700, LOCATOR_H = 700;
  const SYM_PARCEL = { type: "simple-fill", color: [255, 190, 60, 0.18], outline: { color: [255, 150, 0, 1], width: 4 } };
  const CITIES = "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Hennepin%20County%20Cities/FeatureServer/0/query";
  const COUNTY_PARCELS = "https://gis.hennepin.us/arcgis/rest/services/Maps/NATURALRESOURCES/MapServer/2/query";

  let modules = null, hiddenView = null, hiddenContainer = null, countyOutline = null;

  function loadModules() {
    if (modules) return Promise.resolve(modules);
    return new Promise((resolve, reject) => {
      if (typeof require !== "function") return reject(new Error("ArcGIS AMD loader not present"));
      require(["esri/Map", "esri/views/MapView", "esri/layers/GraphicsLayer", "esri/Graphic",
               "esri/geometry/geometryEngine", "esri/geometry/support/webMercatorUtils", "esri/geometry/Polygon"],
        (Map, MapView, GraphicsLayer, Graphic, geometryEngine, webMercatorUtils, Polygon) => {
          modules = { Map, MapView, GraphicsLayer, Graphic, geometryEngine, webMercatorUtils, Polygon };
          resolve(modules);
        }, reject);
    });
  }

  async function ensureView(w, h) {
    const m = await loadModules();
    if (!hiddenView) {
      hiddenContainer = document.createElement("div");
      hiddenContainer.id = "nrpc-report-map-stage";
      hiddenContainer.setAttribute("aria-hidden", "true");
      Object.assign(hiddenContainer.style, { position: "fixed", left: "-20000px", top: "0",
        width: w + "px", height: h + "px", pointerEvents: "none" });
      document.body.appendChild(hiddenContainer);
      hiddenView = new m.MapView({ container: hiddenContainer, map: new m.Map({ basemap: AERIAL_BASEMAP }),
        ui: { components: [] }, constraints: { snapToZoom: false, rotationEnabled: false } });
      await hiddenView.when();
    }
    if (hiddenContainer.style.width !== w + "px" || hiddenContainer.style.height !== h + "px") {
      hiddenContainer.style.width = w + "px"; hiddenContainer.style.height = h + "px";
      await new Promise(r => { if (document.hidden) return setTimeout(r, 60); requestAnimationFrame(() => requestAnimationFrame(r)); });
    }
    return hiddenView;
  }

  function frameExtent(m, graphics, marginFraction) {
    let ext = null;
    graphics.forEach(gr => {
      const e = gr.geometry && gr.geometry.extent;
      if (!e) return;
      const we = e.spatialReference && e.spatialReference.isWebMercator ? e
        : m.webMercatorUtils.geographicToWebMercator(gr.geometry).extent;
      ext = ext ? ext.union(we) : we.clone();
    });
    if (!ext) return null;
    ext.expand(1 + (marginFraction == null ? 0.18 : marginFraction) * 2);
    return ext;
  }

  const SETTLE_MS = 400;
  function paintSettled(resolve) {
    setTimeout(() => { if (document.hidden) return resolve(); requestAnimationFrame(() => requestAnimationFrame(resolve)); }, SETTLE_MS);
  }
  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise(resolve => {
      const on = () => { if (document.hidden) return; document.removeEventListener("visibilitychange", on); resolve(); };
      document.addEventListener("visibilitychange", on);
    });
  }
  function whenStable(view, timeoutMs) {
    return new Promise(resolve => {
      let handle = null;
      const done = () => { if (handle) handle.remove(); handle = null; clearTimeout(timer); paintSettled(resolve); };
      const timer = setTimeout(done, timeoutMs);
      if (!view.updating) return done();
      handle = view.watch("updating", up => { if (!up) done(); });
    });
  }

  // capture(): the reference's, for two kinds -- "facts" (aerial, parcel outline) and "locator"
  // (light grey basemap, county outline, the parcel as a red dot).
  async function capture(kind, parcelGeom, opts) {
    const o = opts || {};
    const w = o.width || INLINE_W, h = o.height || INLINE_H;
    try {
      await whenVisible();
      const m = await loadModules();
      const view = await ensureView(w, h);
      view.map.basemap = kind === "locator" ? "gray-vector" : AERIAL_BASEMAP;
      const layer = new m.GraphicsLayer({ listMode: "hide" });
      view.map.removeAll();
      view.map.add(layer);
      let frame;
      if (kind === "locator") {
        const county = await countyGeometry(m);
        if (!county) return null;
        const c = parcelGeom.extent.center;
        const g1 = new m.Graphic({ geometry: county, symbol: { type: "simple-fill", color: [255, 255, 255, 0],
          outline: { color: [40, 40, 40, 1], width: 2 } } });
        const g2 = new m.Graphic({ geometry: c, symbol: { type: "simple-marker", size: 16, color: [220, 30, 30, 1],
          outline: { color: [255, 255, 255, 1], width: 2 } } });
        layer.addMany([g1, g2]); frame = [g1];
      } else {
        const g = new m.Graphic({ geometry: parcelGeom, symbol: SYM_PARCEL });
        layer.add(g); frame = [g];
      }
      const ext = frameExtent(m, frame, o.marginFraction);
      if (!ext) return null;
      await view.goTo(ext, { animate: false });
      await view.when();
      await whenStable(view, o.timeoutMs || 12000);
      const shot = await view.takeScreenshot({ width: w, height: h, format: "jpg", quality: 90 });
      return { kind, dataUrl: shot.dataUrl, width: w, height: h, capturedAt: new Date() };
    } catch (e) {
      console.warn("[parcel-export] capture failed for", kind, e);
      return null;
    }
  }

  // County outline for the locator: the union of the 46 cities (the Cities layer the Zoom to
  // tool uses; the county boundary service blocks cross-origin requests).
  async function countyGeometry(m) {
    if (countyOutline) return countyOutline;
    try {
      const u = CITIES + "?" + new URLSearchParams({ where: "1=1", returnGeometry: "true", outSR: "3857",
        maxAllowableOffset: "60", f: "json" });
      const d = await (await fetch(u)).json();
      const polys = (d.features || []).map(f => ({ type: "polygon", rings: f.geometry.rings, spatialReference: { wkid: 3857 } }));
      const merged = m.geometryEngine.union(polys.map(p => new m.Polygon(p)));
      // close the slivers where neighbouring city polygons do not quite meet
      const g = m.geometryEngine.buffer(m.geometryEngine.buffer(merged, 80, "meters"), -80, "meters");
      countyOutline = g;
      return g;
    } catch (e) { console.warn("[parcel-export] county outline failed", e); return null; }
  }

  // ── Metropolitan Council layers: js/metc-layers.js (shared with the Parcel card; cached per PID,
  // so an export after the card reuses its results) ──
  async function metcSummary(pid, parcelGeom) {
    return window.NRPCMetc ? window.NRPCMetc.summary(pid, parcelGeom) : null;
  }
  function metcRows(rows) {
    const M = window.NRPCMetc;
    return rows.map(r => [r.label, `${r.error ? "" : r.count ? "yes -- " : ""}${M.valueText(r)}. ${M.sourceText(r)}`]);
  }

  // ── county record (no owner fields) ──────────────────────────────────────────────────────
  async function countyRecord(pid) {
    try {
      const u = COUNTY_PARCELS + "?" + new URLSearchParams({ where: `PID='${pid.replace(/'/g, "''")}'`,
        outFields: "HOUSE_NO,STREET_NM,MUNIC_NM,ZIP_CD,ABBREV_ADDN_NM,LOT,BLOCK,PARCEL_AREA,PROPERTY_TYPE_CD1_NAME," +
          "HMSTD_CD1_NAME,BUILD_YR,FORFEIT_LAND_IND,SCHOOL_DIST_NO,WATERSHED_NO,MKT_VAL_TOT,EST_LAND_MKT_VAL1," +
          "EST_BLDG_MKT_VAL1,TAX_TOT,SALE_DATE,SALE_PRICE,SALE_CODE_NAME",
        returnGeometry: "false", f: "json" });
      return ((await (await fetch(u)).json()).features || [])[0]?.attributes || null;
    } catch (e) { return null; }
  }

  // ── ported from parcel-report.js @891c06a ────────────────────────────────────────────────
  function fmtDateTime(d) {
    try { return d.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }); }
    catch (_) { return d.toISOString(); }
  }
  function saleDate(v) {   // Hennepin publishes SALE_DATE as YYYYMM.
    const s = clean(v);
    if (!s) return null;
    return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
  }
  function printTable(rows) {
    const kept = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!kept.length) return null;
    const t = el("table", { className: "pr-print-table" });
    kept.forEach(([k, v]) => {
      const tr = el("tr");
      tr.append(el("th", { textContent: k }), v instanceof Node ? el("td", {}, v) : el("td", { textContent: String(v) }));
      t.append(tr);
    });
    return t;
  }

  const SOURCE_LINE =
    "Sources, queried live from ArcGIS REST at the moment of export: Hennepin County Parcel Base " +
    "(the parcel record; owner fields are not printed); Hennepin County Parcel Prioritization Model " +
    "Results, v1.0 (category scores, overall score, published rank); the NRPC model explorer's replay " +
    "of v1 (input values and points; it reproduces the published scores); already-protected parcels " +
    "(>= 50% of the parcel in the V2 protected set) and MSP Airport parcels are not ranked; " +
    "Metropolitan Council layers (protection and improvement opportunities, existing natural systems, " +
    "ecologically sensitive and significant areas), the map's hosted copies, queried with the parcel polygon.";

  function figureNode(fig, title, caption, source) {
    if (!fig) return null;
    const node = el("figure", { className: "pr-print-figure" });
    const img = el("img", { className: "pr-print-figure-img" });
    img.decoding = "sync";
    img.src = fig.dataUrl;
    img.alt = title + " — " + caption;
    img.width = fig.width; img.height = fig.height;
    const cap = el("figcaption");
    cap.append(el("span", { className: "pr-print-figure-title", textContent: title + " " }),
               el("span", { className: "pr-print-figure-caption", textContent: caption }),
               el("span", { className: "pr-print-figure-source", textContent: source }));
    node.append(img, cap);
    return node;
  }

  // A drawn bar for the PDF; the DOCX reads the cell's text, so the numbers travel in the text.
  function barCell(c) {
    const pct = x => `${Math.max(0, Math.min(100, 100 * x / c.possible)).toFixed(2)}%`;
    const wrap = el("span", { className: "pr-bar" });
    wrap.append(el("span", { className: "pr-bar-fill" }), el("span", { className: "pr-bar-mark pr-bar-p50" }),
                el("span", { className: "pr-bar-mark pr-bar-p90" }));
    wrap.children[0].style.width = pct(c.earned);
    wrap.children[1].style.left = pct(c.p50);
    wrap.children[2].style.left = pct(c.p90);
    const txt = el("span", { className: "pr-bar-text",
      textContent: `${c.earned.toFixed(1)} of ${c.possible.toFixed(0)} points; county median ${c.p50.toFixed(1)}, ` +
                   `90th percentile ${c.p90.toFixed(1)}` });
    return el("span", { className: "pr-bar-cell" }, wrap, txt);
  }

  function buildPrintDoc(root, P, rec, maps, meta, metc) {
    root.innerHTML = "";
    const section = (heading, ...kids) => {
      const kept = kids.filter(Boolean);
      if (!kept.length) return;
      const s = el("section", { className: "pr-print-section" });
      s.append(el("h2", { textContent: heading }), ...kept);
      root.append(s);
    };
    const r = rec || {};
    const st = clean(r.STREET_NM).replace(/ADDRESS UNASSIGNED/i, "");
    const address = st ? [r.HOUSE_NO ? `${r.HOUSE_NO} ${st}` : st, clean(r.MUNIC_NM), clean(r.ZIP_CD) !== "00000" ? clean(r.ZIP_CD) : ""]
      .filter(Boolean).join(", ") : (P.addr || "No street address on the county record");

    const head = el("header", { className: "pr-print-head" });
    head.append(
      el("div", { className: "pr-print-kicker", textContent: "NRPC Interactive Map · Parcel Report" }),
      el("h1", { className: "pr-print-title", textContent: "PID " + P.pid }),
      el("div", { className: "pr-print-sub", textContent: address }),
      el("div", { className: "pr-print-meta", textContent: `Generated ${fmtDateTime(meta.generatedAt)} · ${P.runLabel}` }));
    root.append(head);

    const legal = [clean(r.ABBREV_ADDN_NM), clean(r.LOT) ? "Lot " + clean(r.LOT) : null, clean(r.BLOCK) ? "Block " + clean(r.BLOCK) : null]
      .filter(Boolean).join(", ");
    const soldOn = saleDate(r.SALE_DATE);
    const sale = soldOn ? [soldOn, money(r.SALE_PRICE), clean(r.SALE_CODE_NAME)].filter(Boolean).join(" · ") : null;
    const sqft = Number(r.PARCEL_AREA);
    section("The parcel", printTable([
      ["PID", P.pid],
      ["Address", address],
      ["Legal description", legal],
      ["Size", P.acres ? `${P.acres.toFixed(2)} acres` + (sqft ? ` (${Math.round(sqft).toLocaleString("en-US")} sq ft)` : "") : null],
      ["Property type", clean(r.PROPERTY_TYPE_CD1_NAME)],
      ["Homestead", clean(r.HMSTD_CD1_NAME)],
      ["Year built", Number(r.BUILD_YR) > 0 ? clean(r.BUILD_YR) : null],
      ["Tax-forfeit land", clean(r.FORFEIT_LAND_IND)],
      ["School district", clean(r.SCHOOL_DIST_NO)],
      ["Watershed no.", clean(r.WATERSHED_NO)],
      ["Est. market value", money(r.MKT_VAL_TOT)],
      ["Est. land value", money(r.EST_LAND_MKT_VAL1)],
      ["Est. building value", money(r.EST_BLDG_MKT_VAL1)],
      ["Total tax", money(r.TAX_TOT)],
      ["Last sale", sale],
    ]), rec ? null : el("p", { className: "pr-print-note", textContent: "The county parcel record could not be reached at export time." }));

    const figs = maps || {};
    const fFacts = figureNode(figs.facts, "Figure 1. The parcel",
      `The parcel outlined on aerial imagery. PID ${P.pid}${P.acres ? `, ${P.acres.toFixed(2)} acres` : ""}.`,
      `${DATA_ATTRIB}. ${ESRI_ATTRIB}. Captured ${figs.facts ? figs.facts.capturedAt.toLocaleString() : ""}.`);
    const fLoc = figureNode(figs.locator, "Figure 2. Where in Hennepin County",
      "The county outlined, the parcel as a red dot.", `County outline: Hennepin County cities (46). Basemap: Esri.`);
    if (fFacts) root.append(fFacts);
    if (fLoc) root.append(fLoc);
    if (!fFacts || !fLoc) root.append(el("p", { className: "pr-print-note",
      textContent: "A map figure could not be captured at export time; the rest of the report is complete." }));

    // the scorecard -- the card's own numbers and words
    const rankRows = [["Overall score", `${P.overall.toFixed(1)} of 100 (${P.overall.toFixed(4)})`],
                      ["Rank", P.rankLine]];
    if (P.cls) rankRows.push(["Class", P.cls.label]);
    if (P.rule) rankRows.push(["Rule", P.rule]);
    rankRows.push(["Published rank, all parcels (v1.0)", fmt(P.published)]);
    const swatch = P.cls ? el("p", { className: "pr-print-note" },
      el("span", { className: "pr-swatch", style: `background:${P.cls.color}` }), " " + P.cls.label) : null;
    if (swatch) swatch.firstChild.style.background = P.cls.color;
    const bars = P.sumOk ? printTable(P.cats.map(c => [`${c.label} (${Math.round(100 * c.weight)}%)`, barCell(c)])) : null;
    section("Parcel scorecard", printTable(rankRows), swatch, el("h3", { textContent: "Category points" }), bars,
      el("p", { className: "pr-print-note", textContent: P.sumOk
        ? `Tick marks: county median (solid) and 90th percentile (dashed) of ranked parcels. The six category points add up to the overall score (${P.overall.toFixed(4)}).`
        : `Data mismatch: the categories add up to ${P.sum.toFixed(4)}, the overall score is ${P.overall.toFixed(4)}. Bars omitted.` }),
      el("h3", { textContent: "Why this score" }), el("ul", {}, P.why.map(t => el("li", { textContent: t }))));

    if (metc) section("Metropolitan Council layers", printTable(metcRows(metc)),
      el("p", { className: "pr-print-note", textContent: "Each layer queried at export time with the parcel's " +
        "polygon (intersects); values are the layer's own category field; the share is the overlap's area " +
        "over the parcel's area." }));

    if (P.inputs) {
      const s = el("section", { className: "pr-print-section" });
      s.append(el("h2", { textContent: "Inputs and sources" }));
      P.cats.forEach(c => {
        const ins = P.inputs.filter(i => i.category === c.key);
        if (!ins.length) return;
        s.append(el("h3", { textContent: c.label }));
        const ul = el("ul");
        ins.forEach(i => {
          const li = el("li", { textContent: `${i.label}: value read ${i.value ?? "[not on file]"}, ` +
            `${i.points == null ? "[not on file]" : i.points.toFixed(2)} points, within-category weight ${Math.round(100 * i.within)}%. ` });
          i.sources.forEach(src => {
            li.append(document.createTextNode(`Source: ${src.text}`));
            src.links.forEach((l, k) => {
              li.append(document.createTextNode(k ? ", " : ". Source layer: "));
              li.append(el("a", { href: l.href, textContent: l.name }));
            });
            li.append(document.createTextNode(". "));
          });
          ul.append(li);
        });
        s.append(ul);
      });
      root.append(s);
    } else {
      root.append(el("p", { className: "pr-print-note", textContent: "Inputs not published for this run." }));
    }

    const foot = el("footer", { className: "pr-print-foot" });
    foot.append(el("p", { textContent: `${P.runLabel} · map build: branch protected-rerank${meta.commit ? " " + meta.commit : ""} · ` +
                                       `card data built ${meta.built || "[not on file]"} · exported ${fmtDateTime(meta.generatedAt)}` }),
                el("p", { textContent: SOURCE_LINE }));
    root.append(foot);
  }

  // ported: decode every image, then draw it into a canvas that takes its place (print raster).
  async function rasterizePrintImages(printRoot) {
    const deadline = ms => new Promise(r => setTimeout(r, ms));
    for (const im of [...printRoot.querySelectorAll("img")]) {
      try {
        if (im.decode) await Promise.race([im.decode().catch(() => {}), deadline(10000)]);
        const w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) continue;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(im, 0, 0);
        c.className = im.className;
        for (const a of im.getAttributeNames()) if (!["src", "class", "width", "height"].includes(a)) c.setAttribute(a, im.getAttribute(a));
        im.replaceWith(c);
      } catch (e) { /* a decoded img still usually prints */ }
    }
  }

  // ── buttons and the two paths ────────────────────────────────────────────────────────────
  let card, printRoot, pdfBtn, docBtn, lastDoc = null;

  async function prepare(btn) {
    const P = card.print;
    if (!P || !card.feature) throw new Error("Select a parcel first.");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Preparing maps…";
    try {
      const geom = card.feature.geometry;
      const metcJob = metcSummary(P.pid, geom);   // in parallel with the map captures; cached per PID
      const [facts, rec, run] = await Promise.all([
        capture("facts", geom, { marginFraction: 0.35 }),
        countyRecord(P.pid), fetch("data/card-v1-run.json").then(r => r.json()).catch(() => ({})),
      ]);
      const loc = await capture("locator", geom, { width: LOCATOR_W, height: LOCATOR_H, marginFraction: 0.06 });
      btn.textContent = "Loading Met Council layers…";
      const metc = await metcJob;
      btn.textContent = "Building…";
      const meta = { generatedAt: new Date(), built: run.source && run.source.built, commit: window.NRPC_BUILD || "" };
      buildPrintDoc(printRoot, P, rec, { facts, locator: loc }, meta, metc);
      lastDoc = { pid: P.pid, facts: !!facts, locator: !!loc, record: !!rec,
                  metc: (metc || []).map(r => ({ label: r.label, count: r.count, values: r.values, share: r.share, error: r.error,
                                                 text: window.NRPCMetc.valueText(r) })) };
      return P;
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function exportPdf() {
    await prepare(pdfBtn);
    await rasterizePrintImages(printRoot);
    document.body.classList.add("pr-print-ready");
    window.print();
  }

  async function docxBlob() {
    const P = await prepare(docBtn);
    if (!window.NRPCDocx) throw new Error("The DOCX writer did not load (js/docx-writer.js).");
    return { blob: await window.NRPCDocx.docxFromPrintRoot(printRoot, "Parcel Report " + P.pid), pid: P.pid };
  }

  async function exportDocx() {
    const { blob, pid } = await docxBlob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `parcel-report-${pid}.docx`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function init(parcelCard) {
    card = parcelCard;
    if (!card || !card.section) return null;
    printRoot = document.getElementById("pr-print") || el("div", { id: "pr-print" });
    if (!printRoot.parentNode) document.body.appendChild(printRoot);
    window.addEventListener("afterprint", () => document.body.classList.remove("pr-print-ready"));
    pdfBtn = el("button", { type: "button", className: "pc-export", textContent: "Export PDF",
      title: "Print-ready report of this parcel; choose \"Save as PDF\" in the print dialog" });
    docBtn = el("button", { type: "button", className: "pc-export", textContent: "Export Word (.docx)",
      title: "Download this parcel's report as a Word document" });
    const run = (fn, btn) => async () => {
      try { await fn(); } catch (e) { btn.title = "Export failed: " + e.message; console.warn("[parcel-export]", e); }
    };
    pdfBtn.addEventListener("click", run(exportPdf, pdfBtn));
    docBtn.addEventListener("click", run(exportDocx, docBtn));
    // an action bar at the top of the Parcel section (persistent; the card body re-renders)
    const bar = el("div", { className: "pc-exportbar" }, pdfBtn, docBtn);
    card.section.body.prepend(bar);
    const api = { exportPdf, exportDocx, docxBlob, prepare: () => prepare(pdfBtn), rasterize: () => rasterizePrintImages(printRoot),
                  get last() { return lastDoc; } };
    if (window.__nrpc) window.__nrpc.exporter = api;
    return api;
  }

  return { init };
})();

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
 * Four maps, each making one argument:
 *
 *   facts        the parcel outline on aerial imagery — "this is the parcel"
 *   context      parcel + the 250 m ring — "this is what 'within 250 m' means"
 *   opportunity  parcel + adjacent parcels (dashed) + contributions by tier —
 *                the adjacency argument, which is the one a reader disputes
 *   plate        the 8.5 x 11 page: all of the above with full cartographic
 *                furniture composed on top with canvas 2D
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
    },
  };

  const TIER_LABEL = {
    "on the parcel": "On the parcel",
    "on an adjacent parcel": "On an adjacent parcel",
    nearby: "Nearby (within 250 m)",
  };

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
          "esri/Graphic",
          "esri/geometry/Polygon",
          "esri/geometry/geometryEngine",
          "esri/geometry/support/webMercatorUtils",
        ],
        (Map, MapView, GraphicsLayer, Graphic, Polygon, geometryEngine, webMercatorUtils) => {
          modules = { Map, MapView, GraphicsLayer, Graphic, Polygon, geometryEngine, webMercatorUtils };
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
    let ring = null;
    if (kind === "context" || kind === "plate") {
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

    if (kind === "opportunity" || kind === "plate") {
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

    if (kind === "opportunity" || kind === "plate") {
      (mg.features || []).forEach(f => {
        const geom = geomFromEsriJson(f.geometry);
        if (!geom) return;
        // Drawn, but not framed on — see frameOn above.
        g.push(new m.Graphic({ geometry: geom, symbol: scaleWidths(tierSymbol(f.relation, geom.type), k) }));
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
      view.map.add(layer);
      layer.addMany(built.graphics);

      const ext = frameExtent(m, built.frameOn.length ? built.frameOn : built.graphics, o.marginFraction);
      if (!ext) return null;
      await view.goTo(ext, { animate: false });
      await view.when();

      // takeScreenshot() captures what has been drawn, so wait for the tiles.
      await whenStable(view, o.timeoutMs || 12000);

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

  /** Resolve when the view stops updating, or when the clock runs out. */
  function whenStable(view, timeoutMs) {
    return new Promise(resolve => {
      let handle = null;
      const done = () => {
        if (handle) handle.remove();
        clearTimeout(timer);
        // One more frame so the last tile is composited before the capture.
        requestAnimationFrame(() => requestAnimationFrame(resolve));
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
   * Compose the printed plate: the captured map inset in a bordered frame with
   * title, scale bar, north arrow, legend, corner coordinates, date and
   * sources. Returns a PNG data URL.
   */
  async function composePlate(shot, facts, opts) {
    const o = opts || {};
    const W = shot.plateW;
    const H = shot.plateH;
    const S = W / 2550; // scale every dimension off the portrait width

    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    const pad = Math.round(110 * S);
    const titleH = Math.round(210 * S);
    const footH = Math.round(300 * S);
    const mapX = pad;
    const mapY = pad + titleH;
    const mapW = W - pad * 2;
    const mapH = H - mapY - footH - pad;

    // -- title block --
    const id = facts.identity || {};
    const title = id.address ? `${id.address}, ${id.city || ""}`.replace(/,\s*$/, "") : "Hennepin County parcel";
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `700 ${Math.round(58 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(title, pad, pad - Math.round(26 * S));
    ctx.font = `${Math.round(34 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#444";
    ctx.fillText(
      `PID ${id.pid || "unknown"}` + (id.zip ? ` · ${id.zip}` : ""),
      pad,
      pad + Math.round(52 * S)
    );
    ctx.font = `${Math.round(26 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#666";
    ctx.fillText("NRPC Interactive Map · parcel and shared-opportunity context", pad, pad + Math.round(104 * S));

    // -- the map --
    const img = await loadImage(shot.dataUrl);
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();
    // The capture was taken at the plate's own aspect ratio, so this is a
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
    ctx.fillText(`1 cm ≈ ${Math.round(mPerPx * (W / 21.59) / 10) * 10} m at 8.5 in wide`, bx, by + barH + Math.round(6 * S));
    ctx.restore();

    // -- north arrow --
    drawNorthArrow(ctx, mapX + mapW - Math.round(86 * S), mapY + Math.round(116 * S), Math.round(62 * S));

    // -- legend --
    const entries = legendEntries(facts);
    if (entries.length) {
      ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
      const lw = Math.round(
        Math.max(...entries.map(e => ctx.measureText(e.label).width)) + 96 * S
      );
      const lh = Math.round(entries.length * 40 * S + 58 * S);
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
      ctx.fillText("Legend", lx + Math.round(18 * S), ly + Math.round(14 * S));
      ctx.font = `${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
      entries.forEach((e, i) => {
        const ey = ly + Math.round(56 * S + i * 40 * S);
        const sw = Math.round(38 * S);
        const sh = Math.round(20 * S);
        const sx = lx + Math.round(18 * S);
        ctx.fillStyle = e.fill;
        ctx.fillRect(sx, ey, sw, sh);
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = Math.max(1, Math.round(2.5 * S));
        if (e.dash) ctx.setLineDash([Math.round(6 * S), Math.round(5 * S)]);
        ctx.strokeRect(sx, ey, sw, sh);
        ctx.setLineDash([]);
        ctx.fillStyle = "#111";
        ctx.fillText(e.label, sx + sw + Math.round(14 * S), ey - Math.round(2 * S));
      });
      ctx.restore();
    }

    // -- footer: date + sources --
    const fy = mapY + mapH + Math.round(58 * S);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111";
    ctx.font = `700 ${Math.round(24 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillText("Map produced " + fmtDate(shot.capturedAt), pad, fy);
    ctx.font = `${Math.round(21 * S)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = "#444";
    const lines = [
      DATA_ATTRIB,
      ESRI_ATTRIB,
      "Projection: Web Mercator (EPSG:3857). Grid: WGS 84 (EPSG:4326) corner coordinates. North is true north.",
      "Produced by the NRPC Interactive Map, University of Minnesota. Not a survey; boundaries are approximate.",
    ];
    let yy = fy + Math.round(38 * S);
    lines.forEach(t => {
      wrap(ctx, t, W - pad * 2).forEach(l => {
        ctx.fillText(l, pad, yy);
        yy += Math.round(28 * S);
      });
    });

    // Slightly higher quality than the inline figures: the plate carries text
    // (title, legend, scale bar) that JPEG blocking would soften.
    return cv.toDataURL("image/jpeg", 0.94);
  }

  function legendEntries(facts) {
    const out = [
      { label: "Subject parcel", fill: "rgba(255,190,60,0.35)", stroke: "rgb(255,150,0)" },
      { label: "Parcels touching it", fill: "rgba(120,120,120,0.22)", stroke: "rgb(60,60,60)", dash: true },
      { label: "250 m context ring", fill: "rgba(80,190,255,0.20)", stroke: "rgb(60,170,230)", dash: true },
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
   * @returns {Promise<{figures: object[], plate: object|null, totalMs: number,
   *                    failures: string[]}>}
   */
  async function buildAll(facts, onProgress) {
    const say = onProgress || function () {};
    const t0 = performance.now();
    const failures = [];
    const figures = [];

    if (!facts || !facts.parcelRings) {
      return { figures: [], plate: null, totalMs: 0, failures: ["no parcel geometry"] };
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
          return (
            `Contributions coloured by tier, with the parcels touching this one shown dashed. ` +
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

    // -- the plate --
    say("Preparing maps… the 8.5 × 11 page");
    let plate = null;
    try {
      const box = parcelAspect(facts);
      const size = box > 1.25 ? PLATE_LANDSCAPE : PLATE_PORTRAIT;
      // Capture at the plate's map window aspect, not the page aspect.
      const S = size.w / 2550;
      const pad = Math.round(110 * S);
      const mapW = size.w - pad * 2;
      const mapH = size.h - (pad + Math.round(210 * S)) - Math.round(300 * S) - pad;
      const shot = await capture(facts, "plate", {
        width: Math.min(mapW, 2400),
        height: Math.min(mapH, 2400),
        marginFraction: 0.16,
        timeoutMs: 20000,
      });
      if (shot) {
        shot.plateW = size.w;
        shot.plateH = size.h;
        const dataUrl = await composePlate(shot, facts, {});
        plate = {
          dataUrl,
          width: size.w,
          height: size.h,
          orientation: size === PLATE_LANDSCAPE ? "landscape" : "portrait",
          capturedAt: shot.capturedAt,
          captureMs: shot.captureMs,
          resolutionMPerPx: shot.resolutionMPerPx,
          extent4326: shot.extent4326,
        };
      } else {
        failures.push("plate");
      }
    } catch (e) {
      console.warn("[report-maps] plate failed:", e);
      failures.push("plate");
    }

    return {
      figures,
      plate,
      totalMs: Math.round(performance.now() - t0),
      failures,
    };
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
    composePlate,
    // Exposed for tests and for the scale-bar verification.
    _internals: { niceScaleMetres, parcelAspect, AERIAL_BASEMAP, ESRI_ATTRIB, DATA_ATTRIB },
  };
})();

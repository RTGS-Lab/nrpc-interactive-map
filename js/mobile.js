/**
 * Mobile: the parcel you are standing on.
 *
 * On a phone the map's normal question — "which parcel did you click?" — has a
 * better answer than a fingertip on a 445,000-feature layer: the GPS already
 * knows. One tap on "Use my location" turns a fix into the same parcel context
 * the desktop click produces: facts, seven model scores and rank, nine context
 * layers, shared opportunities by adjacency, the brief, the PDF.
 *
 * Nothing here runs on a desktop. init() returns immediately unless the page is
 * a phone (or ?mobile=1 forces it), and every style in styles.css that this
 * feature needs is gated on the `nrpc-mobile` class this file puts on <html>.
 * The desktop path is untouched — same click handler, same pipeline.
 *
 * Three things a phone needs that a desktop does not:
 *
 *  1. HTTPS. `navigator.geolocation` is a secure-context API: it is present but
 *     always errors on `http://` to anything but localhost. See serve-mobile.sh.
 *  2. A gesture. Browsers — iOS Safari especially — will not prompt for
 *     location outside a user gesture, so the fix always starts from a button.
 *  3. Less map. The county Parcel Base is drawn from a 445k-feature service;
 *     on a phone radio it is the slowest thing on screen and the locate path
 *     never needs it, because the parcel is fetched by one REST query at the
 *     point and drawn as a single graphic. It is off by default here and
 *     switchable back on from the menu.
 */
(function () {
  "use strict";

  // Both halves of the design's test: a small viewport OR a touch pointer.
  // `?mobile=1` / `?mobile=0` overrides it, which is how this gets exercised in
  // a desktop browser and in the 390x844 iframe harness.
  const MEDIA = "(max-width: 768px), (pointer: coarse)";

  function forced() {
    const m = /[?&]mobile=([01])/.exec(window.location.search);
    return m ? m[1] === "1" : null;
  }

  function isMobile() {
    const f = forced();
    if (f !== null) return f;
    try {
      return window.matchMedia(MEDIA).matches;
    } catch (_) {
      return false;
    }
  }

  const GEO_OPTS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

  // How far the fix has to move before "Follow me" re-selects the parcel.
  // Below this a re-query would usually land on the same PID and cost a round
  // trip on a phone radio for nothing.
  const REFOLLOW_M = 30;

  // Accuracy circles bigger than this say "indoors / cell-tower fix" rather
  // than "here"; we still select, but the UI says the answer is a guess.
  const ACCURACY_WARN_M = 100;

  const POSITION_SYMBOL = {
    type: "simple-marker",
    style: "circle",
    size: 13,
    color: [0, 121, 193, 1],
    outline: { color: [255, 255, 255, 1], width: 2.5 },
  };

  const ACCURACY_SYMBOL = {
    type: "simple-fill",
    color: [0, 121, 193, 0.13],
    outline: { color: [0, 121, 193, 0.55], width: 1 },
  };

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    kids.forEach(k => k && n.append(k));
    return n;
  };

  /** A 64-point ring approximating a circle of `metres` around lon/lat. */
  function circleRing(lon, lat, metres, steps) {
    const n = steps || 64;
    const dLat = metres / 111320;
    const dLon = metres / (111320 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return ring;
  }

  function haversineM(aLon, aLat, bLon, bLat) {
    const R = 6371000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const la1 = (aLat * Math.PI) / 180;
    const la2 = (bLat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Plain language for every way a fix can fail. The browser's own messages
   * ("User denied Geolocation") are not what someone standing in a field
   * needs to read, and the commonest cause by far — an http:// origin — does
   * not even reach the geolocation error codes on some browsers.
   */
  function geoErrorText(err) {
    if (!window.isSecureContext) {
      return (
        "Location needs a secure connection. This page is on http://, so the " +
        "browser will not share a position. Open it over https:// (or on " +
        "localhost) and try again."
      );
    }
    const code = err && err.code;
    if (code === 1) {
      return (
        "Location permission was denied. Allow it for this site in the " +
        "browser's site settings, or tap the map to pick a parcel by hand."
      );
    }
    if (code === 2) {
      return (
        "No position available. The device could not get a fix — outdoors " +
        "with a clear sky helps. Tap the map to pick a parcel by hand."
      );
    }
    if (code === 3) {
      return "Timed out waiting for a fix after 10 seconds. Try again, or tap the map to pick a parcel.";
    }
    return "Could not get a location: " + ((err && err.message) || "unknown error") + ".";
  }

  function metres(m) {
    if (typeof m !== "number" || !isFinite(m)) return null;
    return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  }

  // ── The parcel layer we do not want on a phone ────────────────────────────

  /**
   * The county Parcel Base under Boundaries. Matched by service URL, not by
   * title, because the title is editable in ArcGIS Online and the URL is the
   * same one parcel-report.js queries.
   */
  const PARCEL_LAYER_URL = "gis.hennepin.us/arcgis/rest/services/Maps/NATURALRESOURCES/MapServer/2";

  function findParcelLayer(view) {
    let found = null;
    view.map.allLayers.forEach(l => {
      const u = (l.url || "") + (l.layerId !== undefined && l.layerId !== null ? "/" + l.layerId : "");
      if (!found && u.indexOf(PARCEL_LAYER_URL) !== -1) found = l;
    });
    return found;
  }

  // ── init ──────────────────────────────────────────────────────────────────

  function init(api) {
    if (!isMobile()) return null;
    if (!api || !api.view) return null;

    const { view, Graphic, GraphicsLayer } = api;
    document.documentElement.classList.add("nrpc-mobile");

    // -- the heavy parcel layer, off --
    const parcelLayer = findParcelLayer(view);
    let parcelLayerWasVisible = false;
    if (parcelLayer) {
      parcelLayerWasVisible = parcelLayer.visible !== false;
      parcelLayer.visible = false;
    }

    // -- graphics for the fix --
    const locateLayer = new GraphicsLayer({ listMode: "hide" });
    view.map.add(locateLayer);

    // -- state --
    let watchId = null;
    let last = null; // { lon, lat, accuracy }
    let lastSelectedAt = null; // { lon, lat }
    let busy = false;
    let lastTiming = null;

    // ── toast ───────────────────────────────────────────────────────────────
    const toast = el("div", { id: "mb-toast", className: "hidden" });
    document.body.appendChild(toast);
    let toastTimer = null;
    function say(text, kind, ms) {
      toast.textContent = text;
      toast.className = kind ? "mb-" + kind : "";
      clearTimeout(toastTimer);
      if (ms !== 0) toastTimer = setTimeout(() => toast.classList.add("hidden"), ms || 5000);
    }

    // ── the locate bar ──────────────────────────────────────────────────────
    const bar = el("div", { id: "mb-bar" });

    const locateBtn = el("button", {
      id: "mb-locate",
      type: "button",
      // The label is the whole feature. Keep it a sentence, not an icon.
      innerHTML: '<span class="mb-locate-icon" aria-hidden="true"></span><span>Use my location</span>',
    });

    const followWrap = el("label", { id: "mb-follow-wrap" });
    const followCb = el("input", { type: "checkbox", id: "mb-follow" });
    followWrap.append(followCb, el("span", { textContent: "Follow me" }));

    bar.append(locateBtn, followWrap);
    document.body.appendChild(bar);

    const fixLine = el("div", { id: "mb-fix", className: "hidden" });
    document.body.appendChild(fixLine);

    // ── menu button (the desktop toolbar, collapsed) ─────────────────────────
    const menuBtn = el("button", {
      id: "mb-menu-btn",
      type: "button",
      title: "Map tools",
      innerHTML: "<span></span><span></span><span></span>",
    });
    document.body.appendChild(menuBtn);

    const scrim = el("div", { id: "mb-scrim", className: "hidden" });
    document.body.appendChild(scrim);

    function menuOpen() {
      return document.documentElement.classList.contains("mb-menu-open");
    }
    function setMenu(open) {
      setClass(document.documentElement, "mb-menu-open", open);
      setClass(scrim, "hidden", !open);
      setClass(menuBtn, "open", open);
    }
    // ── The surface manager ─────────────────────────────────────────────────
    //
    // On a 1440px desktop the toolbar's six tools are independent widgets and
    // it does not matter that two can be open at once — there is room. On a
    // 390px screen it matters a great deal: two open panels cover the map
    // completely, including the position dot the whole feature exists to
    // show. So on mobile the tools, the drawer and the report sheet are ONE
    // stack with one rule: exactly one surface is open at a time.
    //
    // This does not reimplement any of main.js's open/close logic, which
    // would guarantee the two drift apart. Every tool in the toolbar happens
    // to represent "open" the same way — `hidden` off the panel, `active` on
    // its button — so the manager watches that class and enforces exclusivity
    // *around* the desktop handlers. They still own opening and closing; this
    // owns what else must close, and how the result is sized for a phone.

    const SURFACES = [
      { name: "layers", wrap: "layer-list-wrapper", toggle: "layers-toggle" },
      { name: "legend", wrap: "legend-wrapper", toggle: "legend-toggle" },
      { name: "contribute", wrap: "contribute-wrapper", toggle: "contribute-toggle" },
      { name: "basemap", wrap: "basemap-dropdown", toggle: "basemap-btn" },
      { name: "zoomto", wrap: "city-dropdown-list", toggle: "city-dropdown-btn" },
      { name: "clipzip", wrap: "clip-zip-dropdown", toggle: "clip-zip-btn" },
    ];

    /**
     * Add or remove a class ONLY if that actually changes the element.
     *
     * This is not a micro-optimisation, it is the whole reason the manager
     * works. `classList.add()` on a token that is already present still
     * rewrites the class attribute, and a rewritten attribute still queues a
     * MutationRecord — so an observer that "closes what is already closed"
     * wakes itself, and six observers that close each other wake each other,
     * forever, inside the microtask queue. That does not throw and it does not
     * log: it silently freezes the renderer before the first paint. Measured
     * here on 2026-08-26 — all six observers hit a 300-callback debug cap
     * during page load, and the tab stopped responding to CDP entirely.
     *
     * Every class write in the manager goes through this.
     */
    function setClass(node, name, on) {
      if (!node) return false;
      if (node.classList.contains(name) === !!on) return false;
      node.classList.toggle(name, !!on);
      return true;
    }

    const wrapOf = s => document.getElementById(s.wrap);
    const toggleOf = s => document.getElementById(s.toggle);

    function surfaceIsOpen(s) {
      const w = wrapOf(s);
      return !!w && !w.classList.contains("hidden");
    }

    function openSurfaceName() {
      const s = SURFACES.find(surfaceIsOpen);
      return s ? s.name : null;
    }

    function closeSurface(s) {
      let changed = setClass(wrapOf(s), "hidden", true);
      changed = setClass(wrapOf(s), "mb-surface", false) || changed;
      changed = setClass(toggleOf(s), "active", false) || changed;
      return changed;
    }

    function closeSurfaces(except) {
      let changed = false;
      SURFACES.forEach(s => {
        if (s !== except) changed = closeSurface(s) || changed;
      });
      return changed;
    }

    /**
     * The topmost thing covering the map, or null. Order matters: it is what
     * Escape and the back gesture dismiss, one layer at a time.
     */
    function topmost() {
      if (api.isOpen()) return "sheet";
      const n = openSurfaceName();
      if (n) return n;
      if (menuOpen()) return "drawer";
      return null;
    }

    function closeTopmost() {
      const t = topmost();
      if (!t) return false;
      if (t === "sheet") api.closePanel();
      else if (t === "drawer") setMenu(false);
      else closeSurfaces();
      return true;
    }

    /** Everything closed — the landing state, and what tapping the map gives. */
    function closeAll() {
      closeSurfaces();
      setMenu(false);
    }

    // A tool opening is the event everything else hangs off. Every branch is
    // idempotent, so a callback that has nothing to do writes nothing and
    // wakes nobody — including itself.
    SURFACES.forEach(s => {
      const w = wrapOf(s);
      if (!w) return;
      new MutationObserver(() => {
        if (!surfaceIsOpen(s)) {
          setClass(w, "mb-surface", false);
          return;
        }
        closeSurfaces(s);
        // mb-surface re-sizes it for the phone: full width, above the locate
        // bar, capped in height. It overrides the inline top/left main.js
        // computed from the toolbar button's rect — a rect that was inside
        // the drawer this panel is replacing.
        const justOpened = setClass(w, "mb-surface", true);
        setMenu(false);
        // The report sheet is a surface too, and it loses to a tool the user
        // just asked for. It stays recoverable from the "Parcel report" chip.
        if (api.isOpen()) api.closePanel();
        // Only on the opening edge, or the back stack would gain an entry
        // every time anything rewrote this element's class attribute.
        if (justOpened) pushSurface(s.name);
      }).observe(w, { attributes: true, attributeFilter: ["class"] });
    });

    // The hamburger is the way in AND the way out. If anything is covering
    // the map it closes that first; only from a clear map does it open the
    // drawer. Without this the one always-visible control appears dead
    // whenever a tool is up.
    menuBtn.addEventListener("click", () => {
      if (menuOpen()) {
        setMenu(false);
        return;
      }
      if (openSurfaceName() || api.isOpen()) {
        closeAll();
        if (api.isOpen()) api.closePanel();
        return;
      }
      setMenu(true);
      pushSurface("drawer");
    });

    scrim.addEventListener("click", closeAll);

    // Tapping the map dismisses whatever is over it. The map click that
    // selects a parcel is a separate handler in parcel-report.js and still
    // runs — which is right: picking a parcel should close the tool panel and
    // open the sheet, in that order.
    view.on("click", () => {
      if (openSurfaceName()) closeSurfaces();
      if (menuOpen()) setMenu(false);
    });

    // Escape, and the phone's back gesture. Each closes one layer.
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && closeTopmost()) e.preventDefault();
    });

    // Back gesture: every surface push adds one history entry, and popping it
    // closes that surface instead of leaving the app. `popping` keeps the
    // close from pushing a new entry and trapping the user in the page.
    let depth = 0;
    let popping = false;
    function pushSurface(name) {
      if (popping) return;
      depth++;
      try {
        history.pushState({ mbSurface: name, mbDepth: depth }, "");
      } catch (_) {
        /* file:// or a sandbox without history — Escape still works */
      }
    }
    window.addEventListener("popstate", () => {
      if (depth <= 0) return;
      depth--;
      popping = true;
      closeTopmost();
      popping = false;
    });

    // A place in the menu for the one map setting the mobile build changes.
    // Without it "where did the parcel lines go?" has no answer on the phone.
    if (parcelLayer) {
      const row = el("label", { id: "mb-parcel-layer-row" });
      const cb = el("input", { type: "checkbox", id: "mb-parcel-layer" });
      cb.checked = false;
      cb.addEventListener("change", () => {
        parcelLayer.visible = cb.checked;
        if (cb.checked) say("Parcel outlines on — slower to draw on a phone.", "info", 4000);
      });
      row.append(
        cb,
        el("span", {
          textContent: "Parcel outlines",
          title: "Off by default on mobile: 445,000 features is slow on a phone radio.",
        })
      );
      // Injected into the toolbar the desktop already builds, so it travels
      // with it into the drawer.
      const toggleBar = document.getElementById("toggle-bar");
      if (toggleBar) toggleBar.appendChild(row);
      else bar.appendChild(row);
    }

    // Picking a tool closes the drawer. The manager does this too when the
    // tool actually opens; this covers the buttons that toggle something
    // OTHER than a panel (Home), which would otherwise leave the drawer
    // sitting over the result.
    const toolbarEl = document.getElementById("toggle-bar");
    if (toolbarEl) {
      toolbarEl.addEventListener("click", e => {
        if (e.target.closest("#mb-parcel-layer-row")) return;
        if (e.target.closest("button, calcite-button")) setTimeout(() => setMenu(false), 60);
      });
    }

    // ── the report panel, as a bottom sheet ──────────────────────────────────
    //
    // Same DOM the desktop uses. Only the geometry changes: it comes up from
    // the bottom in three stops instead of sliding in from the right.
    const panel = api.panel;
    const grip = el("div", { id: "mb-grip" });
    grip.append(el("div", { className: "mb-grip-bar" }));
    panel.insertBefore(grip, panel.firstChild);

    // Re-locate without closing the sheet. The big button at the bottom is
    // hidden once the sheet is up (it would sit under it), and "walk to the
    // next parcel, look again" is the actual field loop — so the affordance
    // has to survive into the open sheet. Icon-only, but 44px.
    const sheetLocate = el("button", {
      id: "mb-sheet-locate",
      type: "button",
      title: "Use my location again",
      innerHTML: '<span class="mb-locate-icon" aria-hidden="true"></span>',
    });
    sheetLocate.addEventListener("click", () => locateBtn.click());
    api.header.insertBefore(sheetLocate, api.header.lastChild);

    const STOPS = ["peek", "half", "full"];
    let stop = "half";
    function setStop(name) {
      stop = name;
      STOPS.forEach(s => setClass(panel, "mb-" + s, s === name));
    }
    setStop("half");

    // Drag: pointer events, so one code path covers touch and a mouse in
    // device emulation. Vertical travel is converted to the nearest stop on
    // release rather than to a free position — a sheet that lands anywhere is
    // a sheet you have to fiddle with, and this one gets used one-handed.
    // Only the grip is draggable, and pointer capture is taken on the grip
    // alone — never on the panel — so #pr-body keeps every wheel, touch-move
    // and scroll event it needs. A sheet you cannot scroll is worse than a
    // sheet you cannot drag.
    let dragFrom = null;
    grip.addEventListener("pointerdown", e => {
      dragFrom = { y: e.clientY, stop };
      grip.setPointerCapture(e.pointerId);
      panel.classList.add("mb-dragging");
    });
    grip.addEventListener("pointermove", e => {
      if (!dragFrom) return;
      const dy = e.clientY - dragFrom.y;
      panel.style.setProperty("--mb-drag", dy + "px");
    });
    function endDrag(e) {
      if (!dragFrom) return;
      const dy = e.clientY - dragFrom.y;
      panel.style.removeProperty("--mb-drag");
      panel.classList.remove("mb-dragging");
      const i = STOPS.indexOf(dragFrom.stop);
      dragFrom = null;
      if (dy < -40) setStop(STOPS[Math.min(STOPS.length - 1, i + 1)]);
      else if (dy > 40) {
        if (i === 0) api.closePanel();
        else setStop(STOPS[Math.max(0, i - 1)]);
      }
    }
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    // A wheel over the sheet is a desktop/emulator gesture, not a phone one,
    // but it is how this gets reviewed — and at the peek stop there is often
    // nothing to scroll, so the wheel would look broken. Scrolling past the
    // top of an already-scrolled-to-top sheet raises it a stop instead.
    api.body.addEventListener(
      "wheel",
      e => {
        if (dragFrom) return;
        const atTop = api.body.scrollTop <= 0;
        const atBottom =
          api.body.scrollTop + api.body.clientHeight >= api.body.scrollHeight - 1;
        const i = STOPS.indexOf(stop);
        if (e.deltaY < 0 && atTop && i > 0) {
          // scrolled up past the top: nothing more to reveal, so shrink
          setStop(STOPS[i - 1]);
        } else if (e.deltaY > 0 && atBottom && i < STOPS.length - 1) {
          setStop(STOPS[i + 1]);
        }
      },
      { passive: true }
    );

    grip.addEventListener("click", () => {
      // A tap on the grip cycles up, then wraps to peek. Cheaper than a drag
      // when the sheet is where you can reach it.
      const i = STOPS.indexOf(stop);
      setStop(STOPS[(i + 1) % STOPS.length]);
    });

    // The sheet is the sixth surface, and the one that wins: selecting a
    // parcel closes whatever tool was open. Watched rather than wrapped —
    // openPanel() is called from inside parcel-report.js and all this needs
    // is to react to the result.
    //
    // A closed sheet must stay recoverable. On the desktop that is the side
    // tab; here the same button becomes a pill above the locate bar, shown
    // only once a parcel has been loaded. Without it, "open the menu" would
    // silently throw away the parcel you just walked to.
    let sheetWasOpen = false;
    function syncSheetChip() {
      const open = panel.classList.contains("open");
      setClass(api.tab, "mb-chip-hidden", open || !api.hasFacts());
    }
    new MutationObserver(() => {
      const open = panel.classList.contains("open");
      if (open && !sheetWasOpen) {
        setMenu(false);
        closeSurfaces();
        pushSurface("sheet");
      }
      sheetWasOpen = open;
      syncSheetChip();
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });
    api.tab.textContent = "Parcel report";
    setClass(api.tab, "mb-chip-hidden", true);

    // ── the locate path ─────────────────────────────────────────────────────

    function drawFix(lon, lat, accuracy) {
      locateLayer.removeAll();
      if (typeof accuracy === "number" && accuracy > 0) {
        locateLayer.add(
          new Graphic({
            geometry: {
              type: "polygon",
              rings: [circleRing(lon, lat, accuracy)],
              spatialReference: { wkid: 4326 },
            },
            symbol: ACCURACY_SYMBOL,
          })
        );
      }
      locateLayer.add(
        new Graphic({
          geometry: { type: "point", longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } },
          symbol: POSITION_SYMBOL,
        })
      );
    }

    function showFix(lon, lat, accuracy) {
      const a = metres(accuracy);
      fixLine.textContent =
        "You are at " +
        lat.toFixed(5) +
        ", " +
        lon.toFixed(5) +
        (a ? " · accurate to about " + a : "");
      fixLine.classList.toggle(
        "mb-fix-rough",
        typeof accuracy === "number" && accuracy > ACCURACY_WARN_M
      );
      fixLine.classList.remove("hidden");
    }

    /**
     * The whole mobile answer, from a fix to the context. One REST query for
     * the parcel under the point (the same query the desktop click makes), then
     * the shared seam — so facts, scores, context layers, opportunities and the
     * brief are identical to the desktop's, by construction.
     */
    async function selectAt(lon, lat, accuracy, t0) {
      busy = true;
      locateBtn.disabled = true;
      locateBtn.classList.add("mb-busy");
      const startedAt = typeof t0 === "number" ? t0 : performance.now();
      try {
        view.goTo({ center: [lon, lat], zoom: 17 }).catch(() => {});
        api.beginLoad();
        setStop("half");
        const feature = await api.fetchParcelAt(lon, lat);
        if (!feature) {
          say(
            "No Hennepin County parcel at this position" +
              (typeof accuracy === "number" && accuracy > ACCURACY_WARN_M
                ? " — the fix is only accurate to about " + metres(accuracy) + "."
                : "."),
            "warn"
          );
        }
        await api.selectParcelFeature(feature, lon, lat);
        lastSelectedAt = feature ? { lon, lat } : null;
        lastTiming = {
          totalMs: Math.round(performance.now() - startedAt),
          accuracyM: typeof accuracy === "number" ? Math.round(accuracy) : null,
          at: new Date().toISOString(),
        };
        syncSheetChip();
        if (feature) {
          console.log(
            "[mobile] time to context: " + lastTiming.totalMs + " ms (tap to facts on screen)"
          );
        }
      } catch (e) {
        api.setHint("Could not load the parcel: " + e.message);
        say("Could not load the parcel: " + e.message, "warn");
      } finally {
        busy = false;
        locateBtn.disabled = false;
        locateBtn.classList.remove("mb-busy");
      }
    }

    function onPosition(pos, t0) {
      const { longitude: lon, latitude: lat, accuracy } = pos.coords;
      last = { lon, lat, accuracy };
      drawFix(lon, lat, accuracy);
      showFix(lon, lat, accuracy);
      return selectAt(lon, lat, accuracy, t0);
    }

    locateBtn.addEventListener("click", () => {
      if (busy) return;
      const t0 = performance.now();
      if (!navigator.geolocation) {
        say("This browser has no geolocation. Tap the map to pick a parcel by hand.", "warn", 8000);
        return;
      }
      say("Getting your location…", "info", 0);
      locateBtn.classList.add("mb-busy");
      navigator.geolocation.getCurrentPosition(
        pos => {
          clearTimeout(toastTimer);
          toast.classList.add("hidden");
          onPosition(pos, t0);
        },
        err => {
          locateBtn.classList.remove("mb-busy");
          say(geoErrorText(err), "warn", 12000);
        },
        GEO_OPTS
      );
    });

    // ── follow me ───────────────────────────────────────────────────────────
    //
    // Off by default: watchPosition with high accuracy holds the GPS on, and
    // this app is opened in the field on a phone whose battery has to last the
    // site visit. When it is on, the dot tracks every fix but the parcel is
    // only re-selected once the fix has actually moved — a metre of GPS jitter
    // must not cost a round trip.
    followCb.addEventListener("change", () => {
      if (followCb.checked) {
        if (!navigator.geolocation) {
          followCb.checked = false;
          say("This browser has no geolocation.", "warn");
          return;
        }
        watchId = navigator.geolocation.watchPosition(
          pos => {
            const { longitude: lon, latitude: lat, accuracy } = pos.coords;
            last = { lon, lat, accuracy };
            drawFix(lon, lat, accuracy);
            showFix(lon, lat, accuracy);
            if (busy) return;
            const moved = lastSelectedAt
              ? haversineM(lastSelectedAt.lon, lastSelectedAt.lat, lon, lat)
              : Infinity;
            if (moved > REFOLLOW_M) selectAt(lon, lat, accuracy);
          },
          err => {
            followCb.checked = false;
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            watchId = null;
            say(geoErrorText(err), "warn", 12000);
          },
          GEO_OPTS
        );
        say("Following. The parcel re-selects when you move about " + REFOLLOW_M + " m.", "info", 5000);
      } else {
        if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    });

    // Stop the GPS when the page is backgrounded; resume when it comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      } else if (!document.hidden && followCb.checked && watchId === null) {
        followCb.dispatchEvent(new Event("change"));
      }
    });

    // Landing state: nothing covering the map. The desktop opens with the
    // layer list showing, which is right at 1440px and wrong at 390 — a 300px
    // panel over a 390px map hides the thing it is a legend for. The only
    // controls on a fresh mobile screen are the hamburger, "Use my location"
    // and "Follow me".
    closeSurfaces();

    // ── tap-to-select still works ───────────────────────────────────────────
    // The desktop click handler in parcel-report.js is untouched, so a tap on
    // the map is the fallback when location is denied. All this does is make
    // sure the sheet does not swallow the map underneath it.
    api.setHint("Tap “Use my location”, or tap the map to pick a parcel.");

    const controller = {
      isMobile: true,
      // The surface manager, for tests and for the console.
      surfaces: {
        get open() {
          return topmost();
        },
        close: closeTopmost,
        closeAll,
        names: SURFACES.map(s => s.name),
      },
      setStop,
      get stop() {
        return stop;
      },
      setMenu,
      selectAt,
      drawFix,
      parcelLayer,
      parcelLayerWasVisible,
      get lastFix() {
        return last;
      },
      get lastTiming() {
        return lastTiming;
      },
    };
    window.NRPCMobile.controller = controller;
    return controller;
  }

  window.NRPCMobile = { init, isMobile, circleRing, haversineM, geoErrorText };
})();

// One right-side container for the map's side content: "Top parcels" (js/top-parcels.js) and
// "Parcel" (js/parcel-card.js), stacked as sections, each collapsible to its header.
//
// Asks (Bryan, 2026-11-12): "The table of ranks should be a right side popout and there should be
// an option to collapse it or expand it."; "On a parcel click, instead of a popup table, have a
// panel open on the right and a parcel scorecard be added ... it needs to behave well with the
// table and they need to have sensible collapse and open options."
//
// Why one container, not two drawers: one edge, one width, one view padding; the sections cannot
// cover each other, and the whole container collapses to one strip.
// - Container modes: open | wide (all table columns; reads over the map) | collapsed (a slim strip
//   naming what is inside). Edge handle and strip toggle it; Escape collapses it. Kept in
//   localStorage (try/catch: a private window keeps it for the page only).
// - Sections: shown or hidden (the toolbar button / a close button), expanded or collapsed to
//   their header (a button with aria-expanded). Only the user collapses a section (round 6,
//   Bryan: "I'd still want the list to be visible unless I fully collapse it"; replaces the
//   round-5 accordion). Both expanded = a stacked split ("sp-both"): the list keeps 6 rows, the
//   card fills the rest and scrolls. Stacked in Wider too: side by side would leave each under
//   300 px at 1280-1440 px. The phone uses the same stack (list one scroll up, never closed).
// - "Wider" sits in the Top parcels header (no band of its own, finding 15) and stops at the
//   toolbar's right edge, so the toolbar stays reachable (finding 14); hidden when it would not
//   be wider. Escape closes the innermost open thing: an open <details>, then the section the
//   focus is in; on the edge tab or strip it collapses the container (finding 10).
// - An explicit open (the toolbar button, a parcel click) always expands a collapsed container;
//   the width choice (open / wide) is what carries over a reload.
// - View padding: while the container is shown the view is padded by its width, so the Zoom to
//   tool's goTo, a row's Zoom to and the map's own corner buttons sit beside it. On a phone the
//   open container covers the map; the padding is the collapsed strip.
//
// Exposes window.NRPCSidePanel.init(view) -> { section(id, title, order), setMode(m), mode,
// layout(), isPhone() }.

window.NRPCSidePanel = (() => {
  const KEY = "nrpc.side.mode";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window: page only */ } },
  };
  let view, el, body, handle, strip, stripLabel, wideBtn = null, basePadding = null;
  let mode = "open", lastOpen = "open";
  const sections = [];
  const isPhone = () => window.innerWidth <= 760;

  function shown() { return sections.some(s => s.visible); }

  function setMode(m, focus) {
    if (m === "wide" && isPhone()) m = "open";
    mode = m;
    if (m !== "collapsed") lastOpen = m;
    store.set(KEY, m);
    layout();
    if (focus) (m === "collapsed" ? strip : handle).focus();
  }

  // Wider stops 16 px right of the toolbar so its buttons stay reachable.
  function wideWidth() {
    const bar = document.getElementById("toggle-bar");
    const right = bar ? bar.getBoundingClientRect().right : 0;
    return Math.max(0, Math.min(1000, window.innerWidth - right - 16));
  }

  function openWidth() {
    const css = getComputedStyle(el).getPropertyValue("--sp-open-w").trim() || "480px";
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;width:${css}`;
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().width; probe.remove();
    return px;
  }

  function layout() {
    const on = shown();
    el.classList.toggle("hidden", !on);
    el.classList.toggle("sp-collapsed", mode === "collapsed");
    el.classList.toggle("sp-wide", mode === "wide");
    handle.setAttribute("aria-expanded", mode === "collapsed" ? "false" : "true");
    handle.setAttribute("aria-label", mode === "collapsed" ? "Expand the side panel" : "Collapse the side panel");
    handle.firstElementChild.innerHTML = mode === "collapsed" ? "&lsaquo;" : "&rsaquo;";
    strip.setAttribute("aria-expanded", mode === "collapsed" ? "false" : "true");
    const ww = wideWidth(), canWide = !isPhone() && ww > openWidth() + 60;
    el.style.setProperty("--sp-wide-w", `${Math.round(ww)}px`);
    if (mode === "wide" && !canWide) { mode = "open"; el.classList.remove("sp-wide"); }
    if (wideBtn) {
      wideBtn.hidden = !canWide;
      wideBtn.setAttribute("aria-pressed", mode === "wide" ? "true" : "false");
      wideBtn.textContent = mode === "wide" ? "Narrower" : "Wider";
    }
    const vis = sections.filter(s => s.visible).sort((a, b) => a.order - b.order);
    stripLabel.textContent = vis.map(s => s.stripText()).join("  |  ") || "Panel";
    vis.forEach((s, i) => { s.el.classList.toggle("sp-first", i === 0); });
    const both = vis.filter(s => s.expanded).length > 1;
    el.classList.toggle("sp-both", both);
    vis.forEach(s => { s.el.style.flex = !s.expanded ? "0 0 auto" : both && s.id === "top" ? "0 0 auto" : "1 1 auto"; });
    if (basePadding === null) basePadding = { ...view.padding };
    let right = 0;
    if (on) {
      if (mode === "collapsed" || isPhone()) right = 40;
      else if (mode === "wide") right = openWidth();      // wide reads over the map
      else right = el.getBoundingClientRect().width;
    }
    view.padding = { ...basePadding, right: (basePadding.right || 0) + Math.round(right) };
  }

  // A section: header button (title + one-line summary + chevron) and a body.
  function section(id, title, order) {
    const sec = document.createElement("section");
    sec.className = "sp-section hidden";
    sec.id = `sp-${id}`;
    sec.style.order = order;
    sec.innerHTML = `
      <div class="sp-sec-head">
        <button type="button" class="sp-sec-toggle" aria-expanded="true" aria-controls="sp-${id}-body">
          <span class="sp-chev" aria-hidden="true"></span>
          <span class="sp-sec-title"></span>
          <span class="sp-sec-sum"></span>
        </button>
        <span class="sp-sec-extra"></span>
        <button type="button" class="sp-sec-close" aria-label="Close ${title}">&times;</button>
      </div>
      <div class="sp-sec-body" id="sp-${id}-body"></div>`;
    sec.querySelector(".sp-sec-title").textContent = title;
    body.appendChild(sec);
    const tgl = sec.querySelector(".sp-sec-toggle");
    const s = {
      id, title, order, el: sec, body: sec.querySelector(".sp-sec-body"), visible: false,
      expanded: store.get(`nrpc.side.${id}.expanded`, "1") === "1", summary: "",
      onShow: null, onHide: null,
      stripText() { return this.summary ? `${title} · ${this.summary}` : title; },
      setSummary(t) { this.summary = t || ""; sec.querySelector(".sp-sec-sum").textContent = this.summary; layout(); },
      expand(v = true) {
        // a collapsed section keeps its place: scroll offsets of [data-keep-scroll] elements
        const keep = [...this.body.querySelectorAll("[data-keep-scroll]")];
        if (!v && this.expanded) this.scrolls = keep.map(k => k.scrollTop);
        this.expanded = v; store.set(`nrpc.side.${id}.expanded`, v ? "1" : "0");
        sec.classList.toggle("sp-sec-collapsed", !v);
        tgl.setAttribute("aria-expanded", v ? "true" : "false");
        layout();
        // restore after layout gives the section its height back (else scrollTop clamps to 0)
        if (v && this.scrolls) { const sc = this.scrolls; keep.forEach((k, i) => { k.scrollTop = sc[i] || 0; }); }
      },
      show(v = true) {
        if (this.visible === v) { if (v && mode === "collapsed") setMode(lastOpen); return; }
        this.visible = v;
        sec.classList.toggle("hidden", !v);
        if (v && mode === "collapsed") mode = lastOpen;
        layout();
        (v ? this.onShow : this.onHide)?.();
      },
    };
    s.expanded = store.get(`nrpc.side.${id}.expanded`, "1") === "1";
    sec.classList.toggle("sp-sec-collapsed", !s.expanded);
    tgl.setAttribute("aria-expanded", s.expanded ? "true" : "false");
    s.focusHeader = () => tgl.focus();
    s.addHeadButton = b => sec.querySelector(".sp-sec-extra").appendChild(b);
    tgl.addEventListener("click", () => s.expand(!s.expanded));
    sec.querySelector(".sp-sec-close").addEventListener("click", () => s.show(false));
    sections.push(s);
    return s;
  }

  function init(v) {
    view = v;
    el = document.createElement("aside");
    el.id = "side-panel";
    el.className = "hidden";
    el.setAttribute("aria-label", "Side panel");
    el.innerHTML = `
      <button type="button" class="sp-handle" aria-controls="sp-body" aria-expanded="true"
              aria-label="Collapse the side panel"><span aria-hidden="true">&rsaquo;</span></button>
      <button type="button" class="sp-strip" aria-controls="sp-body" aria-expanded="false"
              aria-label="Expand the side panel"><span class="sp-strip-label"></span></button>
      <div class="sp-body" id="sp-body"></div>`;
    document.body.appendChild(el);
    body = el.querySelector(".sp-body");
    handle = el.querySelector(".sp-handle");
    strip = el.querySelector(".sp-strip");
    stripLabel = el.querySelector(".sp-strip-label");
    wideBtn = document.createElement("button");
    wideBtn.type = "button"; wideBtn.className = "sp-wide"; wideBtn.textContent = "Wider";
    wideBtn.setAttribute("aria-pressed", "false");
    handle.addEventListener("click", () => setMode(mode === "collapsed" ? lastOpen : "collapsed", true));
    strip.addEventListener("click", () => setMode(lastOpen, true));
    wideBtn.addEventListener("click", () => setMode(mode === "wide" ? "open" : "wide", true));
    el.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const a = document.activeElement;
      const det = a && a.closest && a.closest("details[open]");
      if (det && el.contains(det)) { det.open = false; det.querySelector("summary")?.focus(); return; }
      const s = sections.find(x => x.visible && x.el.contains(a));
      if (s) {
        s.show(false);
        const next = sections.find(x => x.visible);
        if (next) next.focusHeader(); else document.getElementById("top-parcels-toggle")?.focus();
        return;
      }
      if (mode !== "collapsed") setMode("collapsed", true);
    });
    window.addEventListener("resize", () => layout());
    const saved = store.get(KEY, "open");
    mode = ["open", "wide", "collapsed"].includes(saved) ? saved : "open";
    if (mode !== "collapsed") lastOpen = mode;
    return { section, setMode, layout, isPhone, get: id => sections.find(x => x.id === id),
             get wideButton() { return wideBtn; },
             get mode() { return mode; }, get el() { return el; } };
  }

  return { init };
})();

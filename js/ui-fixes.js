// Layout, UX and accessibility fixes from the UI review (2026-W46/2026-11-12T0646-THURSDAY/
// 03-nrpc-map-ui-review-SUBAGENT/13-output-20261112-nrpc-map-ui-review.md), applied to the map's
// existing DOM so main.js changes stay small. Bryan, 2026-11-12: "Make all changes locally ...
// and then I'll review."
//
// - Toggles carry aria-controls + aria-expanded, kept in step with what they open (finding 10).
// - An open menu (Basemap, Zoom to, Clip & Zip) puts a transparent backdrop under itself: a click
//   outside closes the menu and goes no further, so it cannot select the parcel underneath
//   (finding 7). Escape closes the innermost open thing: a menu, then a left panel; the side
//   panel handles its own Escape (finding 10).
// - Menus stay on screen; on a phone one thing is open at a time (finding 2); the left panels
//   start under the toolbar, which wraps on a phone.
// - The disabled Zoom button says why (finding 6).
// - Popups of the other layers: a title and numbers with at most 2 decimals (finding 8).
//
// Exposes window.NRPCUiFixes.init(view, refs).

window.NRPCUiFixes = (() => {
  const PHONE_MAX = 760;
  const isPhone = () => window.innerWidth <= PHONE_MAX;
  const byId = id => document.getElementById(id);
  const isOpen = el => !!el && !el.classList.contains("hidden");

  function init(view, refs) {
    const menus = [["basemap-btn", "basemap-dropdown"], ["city-dropdown-btn", "city-dropdown-list"],
                   ["clip-zip-btn", "clip-zip-dropdown"]];
    const panels = [["legend-toggle", "legend-wrapper"], ["layers-toggle", "layer-list-wrapper"],
                    ["contribute-toggle", "contribute-wrapper"]];

    // ── backdrop under an open menu ────────────────────────────────────────────────────────
    const backdrop = document.createElement("div");
    backdrop.id = "menu-backdrop";
    backdrop.className = "hidden";
    backdrop.setAttribute("aria-hidden", "true");
    document.body.appendChild(backdrop);

    function closeMenus() {
      let closed = null;
      menus.forEach(([b, d]) => {
        const D = byId(d);
        if (isOpen(D)) { D.classList.add("hidden"); byId(b)?.classList.remove("active"); closed = byId(b); }
      });
      sync();
      return closed;
    }
    const swallow = e => { e.preventDefault(); e.stopPropagation(); };
    backdrop.addEventListener("pointerdown", e => { swallow(e); closeMenus(); });
    ["pointerup", "click", "mousedown", "mouseup", "touchstart", "touchend"].forEach(t =>
      backdrop.addEventListener(t, swallow));

    // ── aria-expanded, backdrop, on-screen menus, one-at-a-time on a phone ──────────────────
    let last = new Map();
    function sync() {
      [...menus, ...panels].forEach(([b, d]) => {
        const B = byId(b), D = byId(d);
        if (!B || !D) return;
        B.setAttribute("aria-controls", d);
        const open = isOpen(D);
        B.setAttribute("aria-expanded", open ? "true" : "false");
        if (open && !last.get(d)) opened(d, D);
        last.set(d, open);
      });
      backdrop.classList.toggle("hidden", !menus.some(([, d]) => isOpen(byId(d))));
    }

    function opened(id, el) {
      // keep a menu inside the window
      if (menus.some(([, d]) => d === id)) {
        requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
        });
      }
      if (!isPhone()) return;
      // phone: one thing open at a time
      panels.forEach(([b, d]) => {
        if (d !== id && isOpen(byId(d)) && panels.some(([, p]) => p === id)) {
          byId(d).classList.add("hidden"); byId(b)?.classList.remove("active");
        }
      });
      const sp = refs.sidePanel;
      if (sp && !sp.el.classList.contains("hidden") && sp.mode !== "collapsed") sp.setMode("collapsed");
    }

    const mo = new MutationObserver(() => sync());
    [...menus, ...panels].forEach(([, d]) => { const D = byId(d); if (D) mo.observe(D, { attributes: true, attributeFilter: ["class"] }); });

    // phone: the side panel opening closes the left panels
    if (refs.sidePanel) {
      new MutationObserver(() => {
        const el = refs.sidePanel.el;
        if (isPhone() && !el.classList.contains("hidden") && !el.classList.contains("sp-collapsed")) {
          panels.forEach(([b, d]) => { if (isOpen(byId(d))) { byId(d).classList.add("hidden"); byId(b)?.classList.remove("active"); } });
        }
      }).observe(refs.sidePanel.el, { attributes: true, attributeFilter: ["class"] });
    }

    // on a phone at load: only the Legend
    if (isPhone()) panels.forEach(([b, d]) => {
      if (d !== "legend-wrapper" && isOpen(byId(d))) { byId(d).classList.add("hidden"); byId(b)?.classList.remove("active"); }
    });
    sync();

    // ── Escape: innermost first ────────────────────────────────────────────────────────────
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      const closed = closeMenus();
      if (closed) { e.stopPropagation(); e.preventDefault(); closed.focus(); return; }
      const a = document.activeElement;
      for (const [b, d] of panels) {
        const D = byId(d);
        if (isOpen(D) && D.contains(a)) {
          e.stopPropagation(); e.preventDefault();
          D.classList.add("hidden"); byId(b)?.classList.remove("active"); byId(b)?.focus();
          return;
        }
      }
    }, true);

    // ── left panels start under the toolbar (it wraps on a phone) ───────────────────────────
    const place = () => {
      const r = refs.toggleBar.getBoundingClientRect();
      if (r.height) refs.panelsContainer.style.top = `${Math.round(r.bottom + 8)}px`;
    };
    new ResizeObserver(place).observe(refs.toggleBar);
    window.addEventListener("resize", place);
    place();

    // ── disabled Zoom says why ─────────────────────────────────────────────────────────────
    const zb = byId("city-zoom-btn");
    if (zb) {
      const t = () => { zb.title = zb.disabled ? "Tick an area first" : "Zoom to the ticked areas"; };
      new MutationObserver(t).observe(zb, { attributes: true, attributeFilter: ["disabled"] }); t();
    }

    // ── popups of the other layers: a title, at most 2 decimals ─────────────────────────────
    const model = refs.modelV1 && refs.modelV1.model && refs.modelV1.model.layer;
    view.map.allLayers.filter(l => l.type === "feature" && l !== model && !l.nrpcHelper).forEach(l => {
      l.load().then(() => {
        const pt = l.popupTemplate;
        if (!pt) return;
        if (!pt.title || /^\s*\{[^}]+\}\s*$/.test(String(pt.title))) pt.title = l.title || pt.title;
        const tidy = fis => (fis || []).forEach(fi => {
          if (fi.format && typeof fi.format.places === "number" && fi.format.places > 2) {
            fi.format.places = 2; fi.format.digitSeparator = true;
          }
        });
        tidy(pt.fieldInfos);
        (Array.isArray(pt.content) ? pt.content : []).forEach(c => { if (c && c.type === "fields") tidy(c.fieldInfos); });
      }).catch(() => {});
    });

    return { sync, closeMenus };
  }

  return { init };
})();

/**
 * panel-exclusivity.js — one companion panel over the map at a time.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `integrate` merge settled the *click* collision — there is exactly one
 * `view.on("click")` handler, in parcel-report.js — but it did not settle the
 * *panel* collision. It deliberately let both panels stand at once and gave
 * them side-by-side geometry (`#parcel-report-panel.open ~ #street-view-panel
 * { right: 400px }`). Measured on the desktop build at a 1056px viewport, that
 * left the Street View panel at x 169–656 and the report at x 655–1056: 887px
 * of panel over a 1056px window, and `document.elementFromPoint` at (300,600)
 * and (500,650) — ordinary map positions — returned `#street-view-no-img` and
 * `#sv-key-input` instead of the view's canvas. So two panels open did not just
 * look crowded, it took the map's click surface away, which is the behaviour
 * reported as "the click logic doesn't work for the Street View and Parcel
 * report".
 *
 * THE RULE
 * --------
 *   The map has exactly one companion panel open at a time.
 *   Opening either the Parcel Report or Street View closes the other.
 *
 * Close, not dock. Both are full-height right-edge panels, so docking is what
 * the merge already tried; the numbers above are the result. The map is the
 * primary object on this page and it keeps its surface.
 *
 * This is the rule mobile.js already enforces for its own surfaces
 * ("one surface at a time"). On a phone mobile.js remains the arbiter and this
 * module stands aside, so the two cannot fight over the same close.
 *
 * HOW
 * ---
 * Each panel registers an {isOpen, close} pair under a name and calls claim()
 * on the way open. claim() closes every other registered panel. A re-entrancy
 * guard matters: closing Street View also leaves pick mode, and a close handler
 * that re-entered claim() would recurse.
 */
window.NRPCPanels = (function () {
  const panels = new Map(); // name -> { isOpen(), close() }
  let claiming = false;

  // On a phone, mobile.js owns surface arbitration (drawer / sheet / panorama
  // share one ladder and a history stack). Two arbiters would double-close.
  function mobileOwnsIt() {
    return document.documentElement.classList.contains("nrpc-mobile");
  }

  function register(name, ctl) {
    if (!name || !ctl || typeof ctl.isOpen !== "function" || typeof ctl.close !== "function") {
      console.warn("[panels] ignoring bad registration:", name);
      return;
    }
    panels.set(name, ctl);
  }

  function isOpen(ctl) {
    try {
      return !!ctl.isOpen();
    } catch (e) {
      console.warn("[panels] isOpen() failed:", e);
      return false;
    }
  }

  /**
   * `name` is opening. Close everything else. Returns the names closed, which
   * is what a test asserts on.
   */
  function claim(name) {
    if (mobileOwnsIt() || claiming) return [];
    claiming = true;
    const closed = [];
    try {
      panels.forEach((ctl, n) => {
        if (n === name || !isOpen(ctl)) return;
        try {
          ctl.close();
          closed.push(n);
        } catch (e) {
          console.warn("[panels] close() failed for", n, e);
        }
      });
    } finally {
      claiming = false;
    }
    return closed;
  }

  function openNames() {
    const out = [];
    panels.forEach((ctl, n) => {
      if (isOpen(ctl)) out.push(n);
    });
    return out;
  }

  /** Close whichever panel is open. Escape's target on the desktop. */
  function closeTopmost() {
    const open = openNames();
    if (!open.length) return null;
    // With the rule holding there is at most one; if a future panel ever
    // breaks it, the last registered is the one on top.
    const name = open[open.length - 1];
    try {
      panels.get(name).close();
    } catch (e) {
      console.warn("[panels] closeTopmost failed:", e);
      return null;
    }
    return name;
  }

  /** The invariant, as an assertion a test can read. */
  function assertOnePanel() {
    const open = openNames();
    return { ok: open.length <= 1, open: open, count: open.length };
  }

  return { register, claim, openNames, closeTopmost, assertOnePanel, names: () => [...panels.keys()] };
})();

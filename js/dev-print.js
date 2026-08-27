/**
 * dev-print.js — drive the "Export as PDF" path from a URL, with no API key.
 *
 * Nothing in the UI loads this behaviour: it is inert unless the URL carries
 * `?dev-print=1`, and it only ever calls the SAME dev hooks a human export
 * goes through (NRPCParcelReport.dev.showReport → .buildPrintDoc → print()).
 * It exists so the printed page can be regression-tested in a real browser —
 * Firefox's print engine is not Chrome's, and a print bug is invisible to
 * every test that stops at the DOM.
 *
 *   index.html?pid=<PID>&dev-print=1          select, mock a brief, print
 *   index.html?pid=<PID>&dev-print=1&auto=0   … but stop before window.print()
 *
 * Query parameters:
 *   pid        Hennepin PID to select. Required.
 *   dev-print  1 to arm this module.
 *   auto       0 to build #pr-print but not call window.print().
 *   maps       0 to skip the map captures (faster; no figures, no plate).
 *   drop-page-margin
 *              1 to delete the `@page { margin }` declaration before printing,
 *              which is what Firefox itself does whenever the print dialog's
 *              Margins dropdown is set to anything but "Default":
 *
 *                // toolkit/content/global/print.js
 *                target.honorPageRuleMargins = value == "default";
 *
 *              With the rule gone Firefox falls back to the dialog's own
 *              margins — 0 for "None" — and the report bleeds off the sheet.
 *              There is no pref for honorPageRuleMargins, so this is the only
 *              way to reproduce that user's output from a script. Use it with
 *              make-firefox-pdf.sh's `none` mode to print what they see.
 *
 * Progress is written to document.title so a headless driver can watch it
 * without a console pipe, and the final state is left on
 * window.__nrpcDevPrint = { state, error }.
 *
 * See docs/dev-print.md.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  if (params.get("dev-print") !== "1") return;

  const pid = (params.get("pid") || "").replace(/[^0-9]/g, "");
  const withMaps = params.get("maps") !== "0";
  const auto = params.get("auto") !== "0";

  const dropPageMargin = params.get("drop-page-margin") === "1";

  const status = { state: "starting", error: null };
  window.__nrpcDevPrint = status;

  /**
   * Strip the margin off every `@page` rule in every stylesheet we can read,
   * standing in for Firefox's honorPageRuleMargins=false. Returns the number
   * of rules touched so the caller can tell "simulated" from "no-op".
   */
  function stripPageMargins() {
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // cross-origin (the Esri theme); it has no @page rule
      }
      for (const rule of Array.from(rules || [])) {
        if (rule.type === CSSRule.PAGE_RULE && rule.style.margin !== "") {
          rule.style.removeProperty("margin");
          rule.style.removeProperty("margin-top");
          rule.style.removeProperty("margin-right");
          rule.style.removeProperty("margin-bottom");
          rule.style.removeProperty("margin-left");
          n++;
        }
      }
    }
    return n;
  }

  function step(state) {
    status.state = state;
    document.title = "dev-print: " + state;
    console.log("[dev-print] " + state);
  }

  function fail(e) {
    status.error = (e && e.message) || String(e);
    step("error: " + status.error);
  }

  /** Poll until `fn()` is truthy, or give up. Returns the value or null. */
  function waitFor(label, fn, timeoutMs) {
    const limit = timeoutMs || 60000;
    const t0 = Date.now();
    return new Promise(resolve => {
      (function tick() {
        let v = null;
        try {
          v = fn();
        } catch (_) {
          v = null;
        }
        if (v) return resolve(v);
        if (Date.now() - t0 > limit) {
          console.warn("[dev-print] timed out waiting for " + label);
          return resolve(null);
        }
        setTimeout(tick, 250);
      })();
    });
  }

  // A canned brief, in the shape showReport() takes: the markdown a real
  // generation streams in. Deliberately long enough to run past one page, so
  // the multi-page layout — page breaks, headings kept with their text, the
  // figures between sections — is what gets printed.
  const MOCK_BRIEF = [
    "## Summary",
    "",
    "This parcel is a mock brief written by the dev-print harness, not by a model. It",
    "exists so the export path can be exercised end to end without an API key and",
    "without spending a token. The text below is filler of a realistic length: a real",
    "brief runs several hundred words across four or five headings, and the printed",
    "layout has to survive that.",
    "",
    "## Conservation value",
    "",
    "The scores in the prioritisation model above are the county-wide ranking, not a",
    "site assessment. A high overall value with a low habitat quality score usually",
    "means the parcel matters for what it connects rather than for what is on it, and",
    "that distinction changes which partner is the right one to call first.",
    "",
    "- Spatial context carries the most weight in the composite score.",
    "- Risk of conversion is a forward-looking estimate, not an observed trend.",
    "- Size is scored against the county distribution, so a suburban parcel scores low.",
    "",
    "## Adjacency and context",
    "",
    "The figures on this page are captured from the live map at export time. They are",
    "arguments rather than decoration: the aerial shows what the tabular record cannot,",
    "and the context map shows the parcel in relation to the protected land around it.",
    "A reader who gets this report forwarded to them will not have the map beside them.",
    "",
    "## What to do next",
    "",
    "Confirm the ownership and the current use before any outreach. The county record",
    "is authoritative for the boundary and the assessed value, and is frequently stale",
    "on use. A site visit settles in ten minutes what the record cannot settle at all.",
    "",
    "1. Verify the parcel boundary against the survey.",
    "2. Check the shared opportunities listed above for an existing relationship.",
    "3. Decide whether this is a fee acquisition or an easement conversation.",
  ].join("\n");

  async function run() {
    try {
      if (!pid) throw new Error("dev-print needs a ?pid=");

      step("waiting for the app");
      const dev = await waitFor(
        "NRPCParcelReport.dev",
        () => window.NRPCParcelReport && window.NRPCParcelReport.dev,
        90000
      );
      if (!dev) throw new Error("NRPCParcelReport.dev never appeared");

      step("selecting parcel " + pid);
      await dev.selectByPid(pid);
      const facts = await waitFor("parcel facts", () => dev.facts, 60000);
      if (!facts) throw new Error("no facts for PID " + pid);

      step("mocking the brief");
      dev.showReport(MOCK_BRIEF);

      step(withMaps ? "capturing maps" : "building (no maps)");
      const built = await dev.buildPrintDoc(withMaps);
      if (!built) throw new Error("buildPrintDoc() returned false");

      // The images are data: URLs, but an <img> that has just been inserted
      // has not necessarily decoded. Printing before it does is how a figure
      // comes out blank.
      const imgs = Array.from(document.querySelectorAll("#pr-print img"));
      await Promise.all(
        imgs.map(img =>
          img.complete && img.naturalWidth
            ? Promise.resolve()
            : img.decode
              ? img.decode().catch(() => {})
              : new Promise(r => {
                  img.addEventListener("load", r, { once: true });
                  img.addEventListener("error", r, { once: true });
                })
        )
      );

      if (dropPageMargin) {
        step("dropped @page margin on " + stripPageMargins() + " rule(s)");
      }

      step("ready: " + imgs.length + " images");
      if (!auto) return;

      // One frame, so the print stylesheet has been applied to the document
      // the class just armed.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      step("printing");
      window.print();
      step("printed");
    } catch (e) {
      fail(e);
    }
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();

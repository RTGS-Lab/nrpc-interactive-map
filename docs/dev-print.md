# Printing the parcel report

"Export as PDF" has no PDF library behind it. It builds a print-only copy of the
report into `#pr-print`, adds `body.pr-print-ready` to arm the print stylesheet,
and calls `window.print()`. The browser writes the file.

That means **the browser's print engine is part of this feature**, and the two
engines do not agree. A DOM test cannot see a print bug; only a real PDF can.

---

## The Firefox margin trap

Firefox honours `@page { margin }` **only while the print dialog's "Margins"
dropdown says "Default"**. From `toolkit/content/global/print.js`:

```js
target.honorPageRuleMargins = value == "default";
target.ignoreUnwriteableMargins = value == "none";
```

On any other setting Firefox discards the page rule's margins and uses the
dialog's own, which for **"None" are zero**. The report then prints to all four
paper edges: text touching the trim, and a figure sized `width: 100%` growing
from the 7.2in usable box to the full 8.5in sheet.

Measured on PID 1011722310002, Letter (see the agent findings file for the
full table):

| Firefox "Margins" | printed margin, all four sides |
|---|---|
| Default | 0.65in — the page rule is applied |
| None | 0.00in — the page rule is discarded |
| Minimum / Custom | the dialog's value, not the page rule's |

There is **no pref** for `honorPageRuleMargins`, so this cannot be forced from a
profile and cannot be detected from the page. Chrome has no equivalent switch —
it always applies the page rule — which is why the report looked correct there
throughout.

### What the stylesheet does about it

`styles.css` is written so that losing the page rule costs as little as
possible:

- `#pr-print` is capped at `max-width: 7.2in` with `margin: 0 auto`. When the
  page rule applies, the containing block is already 7.2in and this does
  nothing. When it does not, the document is centred in the 8.5in sheet and the
  side margins come back on their own.
- Every image is capped in inches (`max-width` / `max-height`) with `width` and
  `height` both `auto`, so the browser scales it inside the box and keeps its
  aspect ratio. Nothing is sized `width: 100%`, because that means "however wide
  the paper turned out to be".

**Left and right margins therefore survive any Margins setting. Top and bottom
do not** — no CSS can put back a margin the engine has decided not to apply. A
user printing with "Margins: None" gets correct side margins, correctly sized
figures, and text that starts at the very top of the sheet.

**If the report prints edge to edge, the fix is in the print dialog: set
Margins to "Default".**

---

## Printing it from a script

`js/dev-print.js` drives the whole export path from a URL, with no API key and
no tokens spent. It is inert unless `?dev-print=1` is present, and it only calls
the same `NRPCParcelReport.dev` hooks a human export goes through.

```
index.html?pid=<PID>&dev-print=1
```

| Parameter | Effect |
|---|---|
| `pid` | Hennepin PID to select. Required. |
| `dev-print=1` | Arms the module. |
| `auto=0` | Build `#pr-print`, but do not call `window.print()`. Use for Chrome's `--print-to-pdf`, which prints the page itself. |
| `maps=0` | Skip the four map captures — much faster, but no figures and no plate. |
| `drop-page-margin=1` | Delete the `@page` margin before printing, standing in for a Firefox whose Margins dropdown is not "Default". This is the only way to reproduce that user's output from a script. |

Progress is written to `document.title` and left on `window.__nrpcDevPrint`, so a
driver can watch it without a console pipe.

### The harnesses

Both live in the chief-of-staff task directory for 2026-08-27
(`00-firefox-print-bleed-AGENT/outputs/`), not in this repo, because they write
PDFs rather than ship code:

- `make-firefox-pdf.sh` — a throwaway Firefox profile with
  `print.always_print_silent` and the "Mozilla Save to PDF" printer pointed at a
  file. Firefox has no `--print-to-pdf`. Note that `--headless` **fails** here:
  ArcGIS's `MapView` needs a GL surface and headless Firefox's software
  compositor cannot map a default framebuffer, so the harness runs a real
  Firefox under `xvfb-run`.
- `make-chrome-pdf.sh` — `google-chrome --headless --print-to-pdf` with
  `auto=0`, as the reference.
- `measure-pdf.py` — per page, the printed margin on each of the four sides and
  the largest blank run. The printed margin is the only margin that matters; it
  is not necessarily the one the CSS asked for.

Serve the repo on **8780** (`python3 -m http.server 8780 --bind 127.0.0.1`);
ports 8765–8767 belong to the demo trees.

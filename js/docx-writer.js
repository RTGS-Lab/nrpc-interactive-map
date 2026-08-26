// ── DOCX writer ──────────────────────────────────────────────────────────────
//
// A .docx is a ZIP of XML parts, and this app already ships a ZIP writer for
// Clip & Zip (JSZip, loaded before ArcGIS in index.html). So "Export as DOCX"
// needs no new dependency — only the four parts a valid WordprocessingML
// document must contain:
//
//   [Content_Types].xml          what each part is
//   _rels/.rels                  the package's root relationship → the document
//   word/_rels/document.xml.rels the document's relationship → the styles
//   word/document.xml            the content
//   word/styles.xml              the named styles the content refers to
//
// The content comes from the SAME DOM the print view builds — #pr-print, filled
// by buildPrintDoc(). That is deliberate: the PDF and the DOCX cannot drift
// apart into two different reports, because there is one document and two
// renderers. Nothing here knows what a parcel is.
//
// Exposed as a global, like shp-writer.js and export-utils.js.
//
// Pure JS. No ArcGIS dependency; JSZip is the only external, and it is already
// on the page.

(function () {
  "use strict";

  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
  const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  // Word measures in twips: 1/20 pt, so 1 inch = 1440.
  const PAGE_W = 12240; // 8.5"
  const PAGE_H = 15840; // 11"
  const MARGIN = 1080; // 0.75"
  const BODY_W = PAGE_W - 2 * MARGIN; // usable width for tables
  const LABEL_W = Math.round(BODY_W * 0.3);
  const VALUE_W = BODY_W - LABEL_W;

  function xml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Control characters are not legal in XML 1.0 and Word refuses the file
      // outright rather than skipping them. Tab and newline are handled as
      // runs before this point; everything else in that range goes.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }

  /**
   * One run. `fmt` is {b, i, sz (half-points), color, mono}.
   *
   * xml:space="preserve" is not optional: without it Word eats the leading and
   * trailing spaces that separate adjacent runs, and "PID 2411921110001"
   * arrives as "PID2411921110001".
   */
  function run(text, fmt) {
    if (text === "") return "";
    const f = fmt || {};
    const props = [];
    if (f.b) props.push("<w:b/>");
    if (f.i) props.push("<w:i/>");
    if (f.mono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    if (f.color) props.push(`<w:color w:val="${f.color}"/>`);
    if (f.sz) props.push(`<w:sz w:val="${f.sz}"/><w:szCs w:val="${f.sz}"/>`);
    const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
    // Soft line breaks inside one logical paragraph.
    const body = xml(text).split("\n").join("</w:t><w:br/><w:t xml:space=\"preserve\">");
    return `<w:r>${rPr}<w:t xml:space="preserve">${body}</w:t></w:r>`;
  }

  function para(runsXml, style, opts) {
    const o = opts || {};
    const props = [];
    if (style) props.push(`<w:pStyle w:val="${style}"/>`);
    if (o.numId) {
      props.push(
        `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${o.numId}"/></w:numPr>`
      );
    }
    if (o.indent) props.push(`<w:ind w:left="${o.indent}"/>`);
    if (o.spaceBefore || o.spaceAfter) {
      props.push(
        `<w:spacing${o.spaceBefore ? ` w:before="${o.spaceBefore}"` : ""}${
          o.spaceAfter ? ` w:after="${o.spaceAfter}"` : ""
        }/>`
      );
    }
    if (o.keepNext) props.push("<w:keepNext/>");
    const pPr = props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
    return `<w:p>${pPr}${runsXml || ""}</w:p>`;
  }

  function cell(runsXml, width, style) {
    return (
      `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
      `<w:tcMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>` +
      `<w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>` +
      `</w:tcPr>${para(runsXml, style)}</w:tc>`
    );
  }

  /** A two-column label/value table, the shape printTable() produces. */
  function table(rows) {
    const border =
      '<w:tblBorders>' +
      ["top", "left", "bottom", "right", "insideH", "insideV"]
        .map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>`)
        .join("") +
      "</w:tblBorders>";
    const body = rows
      .map(
        ([k, v]) =>
          "<w:tr>" +
          cell(run(k, { b: true, sz: 18 }), LABEL_W, "TableText") +
          cell(run(v, { sz: 18 }), VALUE_W, "TableText") +
          "</w:tr>"
      )
      .join("");
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="${BODY_W}" w:type="dxa"/>${border}` +
      `<w:tblLayout w:type="fixed"/></w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="${LABEL_W}"/><w:gridCol w:w="${VALUE_W}"/></w:tblGrid>` +
      body +
      "</w:tbl>" +
      // A table must be followed by a paragraph, or Word reports the file as
      // corrupt. LibreOffice is forgiving; Word is not.
      para(run("", { sz: 8 }))
    );
  }

  // ── DOM → runs ─────────────────────────────────────────────────────────────

  /** Inline children of one block element, carrying bold / italic / code. */
  function inlineRuns(node, fmt) {
    const f = fmt || {};
    let out = "";
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) {
        // Collapse the whitespace an HTML renderer would have collapsed.
        out += run(n.nodeValue.replace(/\s+/g, " "), f);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === "br") {
        out += '<w:r><w:br/></w:r>';
        return;
      }
      const next = { ...f };
      if (tag === "strong" || tag === "b") next.b = true;
      if (tag === "em" || tag === "i") next.i = true;
      if (tag === "code") next.mono = true;
      out += inlineRuns(n, next);
    });
    return out;
  }

  const textOf = n => (n.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Walk one block-level element and append its DOCX to `out`.
   *
   * Everything buildPrintDoc() can produce is handled: the header block, the
   * h2 sections, the label/value tables, the shared-opportunity blocks, the
   * rendered brief (h3/h4/p/ul), and the footer. An element this does not
   * recognise falls through to "a paragraph of its text", which is the right
   * failure: a new section added to the print view appears in the DOCX as
   * plain prose rather than disappearing from it.
   */
  function block(node, out) {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, " ").trim();
      if (t) out.push(para(run(t)));
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    const cls = node.className || "";

    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map(tr => [
        textOf(tr.children[0] || { textContent: "" }),
        textOf(tr.children[1] || { textContent: "" }),
      ]);
      if (rows.length) out.push(table(rows));
      return;
    }

    if (tag === "ul" || tag === "ol") {
      [...node.children].forEach(li => {
        out.push(para(inlineRuns(li), "ListBullet", { numId: 1 }));
      });
      return;
    }

    if (tag === "h1") {
      out.push(para(inlineRuns(node, { b: true }), "Title"));
      return;
    }
    if (tag === "h2") {
      out.push(para(inlineRuns(node, { b: true }), "Heading1", { keepNext: true }));
      return;
    }
    if (tag === "h3") {
      out.push(para(inlineRuns(node, { b: true }), "Heading2", { keepNext: true }));
      return;
    }
    if (tag === "h4" || tag === "h5" || tag === "h6") {
      out.push(para(inlineRuns(node, { b: true }), "Heading3", { keepNext: true }));
      return;
    }

    // The print view's own semantic classes, mapped to styles rather than to
    // guesses about the tag.
    if (/pr-print-kicker/.test(cls)) {
      out.push(para(inlineRuns(node, { sz: 16, color: "777777" }), "Small"));
      return;
    }
    if (/pr-print-sub\b/.test(cls)) {
      out.push(para(inlineRuns(node, { sz: 24 }), "Subtitle"));
      return;
    }
    if (/pr-print-meta|pr-print-note|pr-opp-print-by|pr-opp-print-meta/.test(cls)) {
      out.push(para(inlineRuns(node, { sz: 16, color: "777777" }), "Small"));
      return;
    }
    if (/pr-opp-print-org/.test(cls)) {
      out.push(para(inlineRuns(node, { b: true })));
      return;
    }
    if (/pr-opp-print-head/.test(cls)) {
      // organisation, then where it sits — one line, the second part greyed.
      const org = node.querySelector(".pr-opp-print-org");
      const where = node.querySelector(".pr-opp-print-where");
      out.push(
        para(
          run(org ? textOf(org) : textOf(node), { b: true }) +
            (where ? run("  " + textOf(where), { sz: 16, color: "777777" }) : ""),
          null,
          { spaceBefore: 120, keepNext: true }
        )
      );
      return;
    }
    if (/pr-opp-print-type/.test(cls)) {
      out.push(para(inlineRuns(node, { i: true, sz: 18 })));
      return;
    }

    // A container: recurse. A leaf with text: one paragraph.
    const hasElementChildren = [...node.childNodes].some(
      n => n.nodeType === 1 && !/^(strong|b|em|i|code|br|span|a)$/i.test(n.tagName)
    );
    if (hasElementChildren) {
      node.childNodes.forEach(n => block(n, out));
      return;
    }
    const runs = inlineRuns(node);
    if (runs) out.push(para(runs));
  }

  // ── The parts ──────────────────────────────────────────────────────────────

  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    "</Types>";

  const ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";

  const DOC_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${OFFICE_REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${OFFICE_REL}/numbering" Target="numbering.xml"/>` +
    "</Relationships>";

  const NUMBERING =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:numbering xmlns:w="${W}">` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">' +
    '<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>' +
    '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>' +
    "</w:lvl></w:abstractNum>" +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    "</w:numbering>";

  function styleDef(id, name, opts) {
    const o = opts || {};
    const rPr = [];
    if (o.sz) rPr.push(`<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`);
    if (o.b) rPr.push("<w:b/>");
    if (o.color) rPr.push(`<w:color w:val="${o.color}"/>`);
    if (o.caps) rPr.push("<w:caps/>");
    const pPr = [];
    if (o.before || o.after) {
      pPr.push(
        `<w:spacing w:before="${o.before || 0}" w:after="${o.after || 0}"/>`
      );
    }
    if (o.keepNext) pPr.push("<w:keepNext/>");
    return (
      `<w:style w:type="paragraph" w:styleId="${id}">` +
      `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
      (pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "") +
      (rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "") +
      "</w:style>"
    );
  }

  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:styles xmlns:w="${W}">` +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
    '<w:sz w:val="20"/><w:szCs w:val="20"/>' +
    "</w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    styleDef("Title", "Title", { sz: 40, b: true, before: 0, after: 60 }) +
    styleDef("Subtitle", "Subtitle", { sz: 24, color: "444444", after: 60 }) +
    styleDef("Heading1", "heading 1", { sz: 26, b: true, before: 320, after: 120, keepNext: true }) +
    styleDef("Heading2", "heading 2", { sz: 22, b: true, before: 240, after: 100, keepNext: true }) +
    styleDef("Heading3", "heading 3", { sz: 20, b: true, before: 200, after: 80, keepNext: true }) +
    styleDef("Small", "Small", { sz: 16, color: "777777", after: 100 }) +
    styleDef("TableText", "Table Text", { sz: 18, after: 0 }) +
    styleDef("ListBullet", "List Bullet", { after: 60 }) +
    "</w:styles>";

  function coreProps(title) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xml(title)}</dc:title>` +
      "<dc:creator>NRPC Interactive Map</dc:creator>" +
      "<cp:lastModifiedBy>NRPC Interactive Map</cp:lastModifiedBy>" +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      "</cp:coreProperties>"
    );
  }

  /**
   * Turn the filled print root into a .docx Blob.
   *
   * @param {HTMLElement} root  #pr-print, already filled by buildPrintDoc()
   * @param {string} title      document title for the file's properties
   * @returns {Promise<Blob>}
   */
  async function docxFromPrintRoot(root, title) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip is not loaded — it must come before ArcGIS in index.html.");
    }
    if (!root || !root.childNodes.length) {
      throw new Error("Nothing to export: the print document is empty.");
    }

    const out = [];
    root.childNodes.forEach(n => block(n, out));

    const sectPr =
      "<w:sectPr>" +
      `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
      `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
      'w:header="720" w:footer="720" w:gutter="0"/>' +
      "</w:sectPr>";

    const document_xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="${W}"><w:body>${out.join("")}${sectPr}</w:body></w:document>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.folder("_rels").file(".rels", ROOT_RELS);
    zip.folder("docProps").file("core.xml", coreProps(title || "Parcel Report"));
    const word = zip.folder("word");
    word.file("document.xml", document_xml);
    word.file("styles.xml", STYLES);
    word.file("numbering.xml", NUMBERING);
    word.folder("_rels").file("document.xml.rels", DOC_RELS);

    // No compression level games: a .docx is small and Word cares only that
    // the entries are DEFLATE or STORE.
    return zip.generateAsync({
      type: "blob",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      compression: "DEFLATE",
    });
  }

  window.NRPCDocx = { docxFromPrintRoot };
})();

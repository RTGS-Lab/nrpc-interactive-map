// Toolbar search: an address or a parcel ID (PID).
//
// Ask (Bryan, 2026-11-12): "While at it, also add the search bar (by address, parcel ID)".
// Spec: parcel report card spec section 2.2 ("Search by address or PID ... One field in the
// toolbar; PID prefix, house number + street prefix, city"), built on branch integrate b3b40a7.
// PORTED from branch integrate (js/parcel-report.js searchByPid / searchByAddress / searchRow and
// the js/main.js toolbar field #tb-search + #tb-search-clear + the #tb-search-results listbox):
// the same layer, the same queries, the same row shape. Added: up to 8 suggestions, a city after a
// comma narrows the address, combobox roles, "/" to focus, and choosing a result does what "Zoom
// to selected" does (zoom with the Zoom to tool's code, the one highlight, the Parcel card).
// Not added: the Esri World Geocoder (an option only, not used: the layer's own query needs no
// key). Owner fields are never requested or shown.
//
// Exposes window.NRPCSearch.init(view, card, toolbar) -> { search(text), choose(pid) }.

window.NRPCSearch = (() => {
  "use strict";
  const PARCEL_BASE = "https://gis.hennepin.us/arcgis/rest/services/Maps/NATURALRESOURCES/MapServer/2";
  const SEARCH_LIMIT = 8;
  const clean = v => (v == null ? "" : String(v).trim());
  const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  let view, card, input, clearBtn, list, ctl = null, seq = 0, active = -1, results = [];

  async function esriQuery(params, signal) {
    const u = `${PARCEL_BASE}/query?` + new URLSearchParams({ ...params, f: "json" });
    const r = await fetch(u, { signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j;
  }

  // ported: the row a result shows (PID, house number + street, city)
  const searchRow = f => {
    const a = f.attributes;
    let street = clean(a.STREET_NM), house = clean(a.HOUSE_NO);
    if (/ADDRESS UNASSIGNED/i.test(street)) { street = ""; house = ""; }
    return { pid: clean(a.PID), address: [house !== "0" ? house : "", street].filter(Boolean).join(" ") || null,
             city: clean(a.MUNIC_NM) ? titleCase(clean(a.MUNIC_NM)) : null };
  };

  // ported: PIDs beginning with these digits; a full 13 digits matches exactly one
  async function searchByPid(digits, signal) {
    const d = String(digits || "").replace(/[^0-9]/g, "");
    if (!d) return [];
    const where = d.length >= 13 ? `PID='${d.slice(0, 13)}'` : `PID LIKE '${d}%'`;
    const j = await esriQuery({ where, outFields: "PID,HOUSE_NO,STREET_NM,MUNIC_NM", returnGeometry: "false",
                                orderByFields: "PID", resultRecordCount: String(SEARCH_LIMIT) }, signal);
    return (j.features || []).map(searchRow);
  }

  // ported: "224 83rd" -> HOUSE_NO=224 AND UPPER(STREET_NM) LIKE '83RD%'; added: ", city" narrows
  async function searchByAddress(text, signal) {
    let [t, city] = String(text || "").toUpperCase().split(",").map(x => x.trim());
    if (!t || t.length < 3) return [];
    const esc1 = v => v.replace(/'/g, "''").replace(/[%_]/g, "");
    const m = t.match(/^(\d+)\s+(.*)$/);
    let where;
    if (m && m[2]) where = `HOUSE_NO=${m[1]} AND UPPER(STREET_NM) LIKE '${esc1(m[2])}%'`;
    else if (m) where = `HOUSE_NO=${m[1]}`;
    else if (/^\d+$/.test(t)) where = `HOUSE_NO=${t}`;
    else where = `UPPER(STREET_NM) LIKE '${esc1(t)}%'`;
    if (city) where += ` AND UPPER(MUNIC_NM) LIKE '${esc1(city)}%'`;
    const j = await esriQuery({ where, outFields: "PID,HOUSE_NO,STREET_NM,MUNIC_NM", returnGeometry: "false",
                                orderByFields: "STREET_NM,HOUSE_NO", resultRecordCount: String(SEARCH_LIMIT) }, signal);
    return (j.features || []).map(searchRow);
  }

  // A PID typed with or without dashes or spaces: mostly digits and at least 4 of them.
  const looksLikePid = t => { const d = t.replace(/[\s-]/g, ""); return /^\d{4,}$/.test(d); };

  async function search(text) {
    const my = ++seq;
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const t = String(text || "").trim();
    if (t.length < 3) { render(null); return []; }
    let rows = [];
    try {
      rows = looksLikePid(t) ? await searchByPid(t, ctl.signal) : await searchByAddress(t, ctl.signal);
      if (!rows.length && looksLikePid(t) === false && /^\d{4,}/.test(t)) rows = await searchByPid(t, ctl.signal);
    } catch (e) {
      if (e.name === "AbortError") return [];
      rows = [];
    }
    if (my !== seq) return rows;
    render(rows);
    return rows;
  }

  function optionText(r) {
    return `${r.address || "No street address"}${r.city ? ", " + r.city : ""} -- ${r.pid}`;
  }

  function render(rows) {
    results = rows || [];
    active = -1;
    list.innerHTML = "";
    if (rows === null) { close(); return; }
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "ps-none"; li.setAttribute("role", "option"); li.setAttribute("aria-disabled", "true");
      li.textContent = "No match";
      list.appendChild(li);
    }
    rows.forEach((r, i) => {
      const li = document.createElement("li");
      li.id = `ps-opt-${i}`; li.setAttribute("role", "option"); li.setAttribute("aria-selected", "false");
      li.dataset.pid = r.pid;
      li.textContent = optionText(r);
      li.addEventListener("mousedown", e => { e.preventDefault(); choose(r.pid); });
      list.appendChild(li);
    });
    open();
  }
  function open() { list.hidden = false; input.setAttribute("aria-expanded", "true"); place(); }
  function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
  function place() {
    const r = input.getBoundingClientRect();
    list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 300) - 8))}px`;
    list.style.top = `${r.bottom + 4}px`;
    list.style.minWidth = `${Math.max(r.width, 300)}px`;
  }
  function setActive(i) {
    const opts = [...list.querySelectorAll("li[data-pid]")];
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach((o, k) => { o.classList.toggle("ps-active", k === active); o.setAttribute("aria-selected", k === active ? "true" : "false"); });
    input.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  }

  // Choosing a result = "Zoom to selected": the card (its one highlight) and the shared zoom.
  async function choose(pid) {
    close();
    const r = results.find(x => x.pid === pid);
    if (r) input.value = optionText(r);
    const f = await card.select(pid, { focus: false });
    if (f) await card.zoomTo();
    return f;
  }

  function init(v, parcelCard, toolbar) {
    view = v; card = parcelCard;
    if (!card || !toolbar) return null;
    const wrap = document.createElement("div");
    wrap.id = "ps-wrap";
    wrap.innerHTML = `
      <input id="ps-input" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search an address or parcel ID" title="Search an address or parcel ID (press / to focus)"
             role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ps-list"
             aria-label="Search an address or parcel ID">
      <button id="ps-clear" type="button" aria-label="Clear the search" hidden>&times;</button>`;
    const before = toolbar.querySelector("#city-dropdown-wrapper");
    toolbar.insertBefore(wrap, before || null);
    input = wrap.querySelector("#ps-input");
    clearBtn = wrap.querySelector("#ps-clear");
    list = document.createElement("ul");
    list.id = "ps-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Search results");
    list.hidden = true;
    document.body.appendChild(list);

    let timer = null;
    input.addEventListener("input", () => {
      clearBtn.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), 250);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden && results.length) open(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const opts = [...list.querySelectorAll("li[data-pid]")];
        const pick = opts[active] || opts[0];
        if (pick) choose(pick.dataset.pid);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        input.value = ""; clearBtn.hidden = true; seq++; render(null);
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.addEventListener("focus", () => { if (results.length || list.querySelector(".ps-none")) open(); });
    clearBtn.addEventListener("click", () => { input.value = ""; clearBtn.hidden = true; seq++; render(null); input.focus(); });
    document.addEventListener("keydown", e => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      // "/" is text in a text field; anywhere else (a select included) it opens the search
      if (t && ((t.tagName === "INPUT" && !/^(checkbox|radio|button|submit|range)$/i.test(t.type)) || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault(); input.focus(); input.select();
    });
    window.addEventListener("resize", () => { if (!list.hidden) place(); });
    const api = { search, choose, get results() { return results; } };
    if (window.__nrpc) window.__nrpc.search = api;
    return api;
  }

  return { init };
})();

require([
  "esri/WebMap",
  "esri/views/MapView",
  "esri/widgets/Home",
  "esri/widgets/LayerList",
  "esri/widgets/Legend",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
], (WebMap, MapView, Home, LayerList, Legend, GraphicsLayer, Graphic) => {

  const webmap = new WebMap({
    portalItem: {
      id: "d664f1d163544d25bb92921e5c4bf214"
    }
  });

  const view = new MapView({
    container: "viewDiv",
    map: webmap,
    constraints: {
      rotationEnabled: false
    }
  });

  // ── Minimal SHP writer ──────────────────────────────────────────────────────

  function writeInt32BE(buf, val, offset) {
    buf[offset]     = (val >>> 24) & 0xff;
    buf[offset + 1] = (val >>> 16) & 0xff;
    buf[offset + 2] = (val >>>  8) & 0xff;
    buf[offset + 3] =  val         & 0xff;
  }
  function writeInt32LE(buf, val, offset) {
    buf[offset]     =  val         & 0xff;
    buf[offset + 1] = (val >>>  8) & 0xff;
    buf[offset + 2] = (val >>> 16) & 0xff;
    buf[offset + 3] = (val >>> 24) & 0xff;
  }
  function writeDoubleLEInto(buf, val, offset) {
    const tmp = new Float64Array([val]);
    const bytes = new Uint8Array(tmp.buffer);
    for (let i = 0; i < 8; i++) buf[offset + i] = bytes[i];
  }

  // Returns {shp, shx} as Uint8Array
  function buildSHP(features) {
    // Determine shape type from first geometry
    const geomType = features.length ? features[0].geometry.type : "point";
    let shpType;
    if (geomType === "point" || geomType === "multipoint") shpType = 1;
    else if (geomType === "polyline") shpType = 3;
    else shpType = 5; // polygon

    // Build record buffers first
    const records = features.map((f, idx) => {
      const geom = f.geometry;
      let content;
      if (shpType === 1) {
        // Point: 4 (type) + 16 (x,y)
        content = new Uint8Array(20);
        writeInt32LE(content, 1, 0);
        writeDoubleLEInto(content, geom.longitude ?? geom.x, 4);
        writeDoubleLEInto(content, geom.latitude  ?? geom.y, 12);
      } else if (shpType === 3 || shpType === 5) {
        // Polyline or Polygon
        const paths = shpType === 3
          ? (geom.paths  || [])
          : (geom.rings  || []);
        const numParts  = paths.length;
        const numPoints = paths.reduce((s, p) => s + p.length, 0);
        // 4 type + 32 bbox + 4 numParts + 4 numPoints + 4*numParts + 16*numPoints
        const byteLen = 4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints;
        content = new Uint8Array(byteLen);
        writeInt32LE(content, shpType, 0);
        // Compute bbox
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        paths.forEach(p => p.forEach(([x, y]) => {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }));
        writeDoubleLEInto(content, minX, 4);
        writeDoubleLEInto(content, minY, 12);
        writeDoubleLEInto(content, maxX, 20);
        writeDoubleLEInto(content, maxY, 28);
        writeInt32LE(content, numParts,  36);
        writeInt32LE(content, numPoints, 40);
        let off = 44;
        let ptIdx = 0;
        paths.forEach(p => {
          writeInt32LE(content, ptIdx, off); off += 4;
          ptIdx += p.length;
        });
        paths.forEach(p => p.forEach(([x, y]) => {
          writeDoubleLEInto(content, x, off); off += 8;
          writeDoubleLEInto(content, y, off); off += 8;
        }));
      }
      return { recNum: idx + 1, content };
    });

    // Compute total SHP file length in 16-bit words
    const headerWords = 50;
    let dataBytes = 0;
    records.forEach(r => { dataBytes += 8 + r.content.length; }); // 8 = rec header
    const totalWords = headerWords + dataBytes / 2;

    const shp = new Uint8Array(100 + dataBytes);
    // File header
    writeInt32BE(shp, 9994, 0);
    writeInt32BE(shp, totalWords, 24);
    writeInt32LE(shp, 1000, 28);
    writeInt32LE(shp, shpType, 32);
    // Overall bbox — required for all shape types so renderers know the extent
    if (features.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (shpType === 1) {
        features.forEach(f => {
          const x = f.geometry.longitude ?? f.geometry.x;
          const y = f.geometry.latitude  ?? f.geometry.y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        });
      } else {
        features.forEach(f => {
          const paths = shpType === 3 ? (f.geometry.paths || []) : (f.geometry.rings || []);
          paths.forEach(p => p.forEach(([x, y]) => {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }));
        });
      }
      writeDoubleLEInto(shp, minX, 36);
      writeDoubleLEInto(shp, minY, 44);
      writeDoubleLEInto(shp, maxX, 52);
      writeDoubleLEInto(shp, maxY, 60);
    }

    const shx = new Uint8Array(100 + records.length * 8);
    writeInt32BE(shx, 9994, 0);
    writeInt32BE(shx, 50 + records.length * 4, 24);
    writeInt32LE(shx, 1000, 28);
    writeInt32LE(shx, shpType, 32);

    let shpOff = 100;
    records.forEach((r, i) => {
      // SHP record header (big-endian record num + content length in 16-bit words)
      writeInt32BE(shp, r.recNum, shpOff);
      writeInt32BE(shp, r.content.length / 2, shpOff + 4);
      shp.set(r.content, shpOff + 8);

      // SHX record
      const offsetWords = shpOff / 2;
      const contentWords = r.content.length / 2;
      writeInt32BE(shx, offsetWords,  100 + i * 8);
      writeInt32BE(shx, contentWords, 100 + i * 8 + 4);

      shpOff += 8 + r.content.length;
    });

    return { shp, shx };
  }

  // DBF writer
  function buildDBF(features) {
    if (!features.length) return new Uint8Array(32 + 1);
    const attrs = features[0].attributes || {};
    const fields = Object.keys(attrs).filter(k => k !== null && k !== undefined);

    // Truncate field names to 10 chars, type all as Character (C) with width 254
    const fieldDefs = fields.map(name => ({
      name: name.substring(0, 10),
      type: "C",
      length: 254
    }));

    const headerSize = 32 + fieldDefs.length * 32 + 1;
    const recordSize = 1 + fieldDefs.reduce((s, f) => s + f.length, 0);
    const totalSize  = headerSize + features.length * recordSize + 1;
    const buf = new Uint8Array(totalSize);

    // Header
    buf[0] = 3; // version
    const now = new Date();
    buf[1] = now.getFullYear() - 1900;
    buf[2] = now.getMonth() + 1;
    buf[3] = now.getDate();
    writeInt32LE(buf, features.length, 4);
    buf[8]  = headerSize & 0xff;
    buf[9]  = (headerSize >> 8) & 0xff;
    buf[10] = recordSize & 0xff;
    buf[11] = (recordSize >> 8) & 0xff;

    // Field descriptors
    const enc = new TextEncoder();
    fieldDefs.forEach((f, i) => {
      const off = 32 + i * 32;
      const nameBytes = enc.encode(f.name);
      buf.set(nameBytes.slice(0, 10), off);
      buf[off + 11] = f.type.charCodeAt(0);
      buf[off + 16] = f.length;
    });
    buf[32 + fieldDefs.length * 32] = 0x0d; // header terminator

    // Records
    let off = headerSize;
    features.forEach(feat => {
      buf[off++] = 0x20; // not deleted
      const a = feat.attributes || {};
      fieldDefs.forEach((f, fi) => {
        const val = a[fields[fi]];
        const str = val === null || val === undefined ? "" : String(val);
        const bytes = enc.encode(str.substring(0, f.length));
        buf.set(bytes, off);
        off += f.length;
      });
    });
    buf[off] = 0x1a; // EOF

    return buf;
  }

  // PRJ: WGS84
  const WGS84_PRJ =
    'GEOGCS["GCS_WGS_1984",' +
    'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
    'PRIMEM["Greenwich",0.0],' +
    'UNIT["Degree",0.0174532925199433]]';

  // ── GeoJSON builder ─────────────────────────────────────────────────────────

  function featureToGeoJSON(feature) {
    const geom = feature.geometry;
    let geojsonGeom = null;
    if (geom.type === "point") {
      geojsonGeom = { type: "Point", coordinates: [geom.longitude ?? geom.x, geom.latitude ?? geom.y] };
    } else if (geom.type === "polyline") {
      geojsonGeom = { type: "MultiLineString", coordinates: geom.paths };
    } else if (geom.type === "polygon") {
      geojsonGeom = { type: "MultiPolygon", coordinates: [geom.rings.map(r => r)] };
    }
    return {
      type: "Feature",
      geometry: geojsonGeom,
      properties: feature.attributes || {}
    };
  }

  function featuresToGeoJSON(features) {
    return JSON.stringify({
      type: "FeatureCollection",
      features: features.map(featureToGeoJSON)
    }, null, 2);
  }

  // ── Pagination helper ────────────────────────────────────────────────────────

  async function queryAllFeatures(layer, geometry) {
    const oidQuery = layer.createQuery();
    oidQuery.geometry = geometry;
    oidQuery.spatialRelationship = "intersects";
    oidQuery.where = "1=1";
    const oids = await layer.queryObjectIds(oidQuery);
    if (!oids.length) return [];

    const allFeatures = [];
    for (let i = 0; i < oids.length; i += 1000) {
      const q = layer.createQuery();
      q.objectIds = oids.slice(i, i + 1000);
      q.outFields = ["*"];
      q.returnGeometry = true;
      q.outSpatialReference = { wkid: 4326 };
      const result = await layer.queryFeatures(q);
      allFeatures.push(...result.features);
    }
    return allFeatures;
  }

  // ── Layer detection ──────────────────────────────────────────────────────────

  function getExportableLayers(map) {
    const results = [];
    function walk(layer) {
      if (!layer.visible) return;
      if (layer.type === "group") {
        if ((layer.title || "").toLowerCase().includes("boundaries")) return;
        layer.layers?.forEach(child => walk(child));
      } else if (layer.type === "feature") {
        results.push(layer);
      }
    }
    map.layers.forEach(l => walk(l));
    return results;
  }

  // Sanitize a string for use as a filename/folder component
  function safeName(str) {
    return (str || "layer").replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 40);
  }

  // ── Main app ─────────────────────────────────────────────────────────────────

  view.when(() => {
    view.ui.move("zoom", "top-right");

    const home = new Home({ view });

    // Toggle bar with home + panel toggles
    const toggleBar = document.createElement("div");
    toggleBar.id = "toggle-bar";

    const homeContainer = document.createElement("div");
    homeContainer.id = "home-container";
    home.container = homeContainer;
    toggleBar.appendChild(homeContainer);

    const legendToggle = document.createElement("button");
    legendToggle.id = "legend-toggle";
    legendToggle.className = "panel-toggle active";
    legendToggle.textContent = "Legend";
    toggleBar.appendChild(legendToggle);

    const layersToggle = document.createElement("button");
    layersToggle.id = "layers-toggle";
    layersToggle.className = "panel-toggle active";
    layersToggle.textContent = "Layers";
    toggleBar.appendChild(layersToggle);

    // ── City zoom multi-select dropdown ─────────────────────────────────────
    const cityDropdownWrapper = document.createElement("div");
    cityDropdownWrapper.id = "city-dropdown-wrapper";

    const cityDropdownBtn = document.createElement("button");
    cityDropdownBtn.id = "city-dropdown-btn";
    cityDropdownBtn.className = "panel-toggle";
    cityDropdownBtn.textContent = "Zoom to...";
    cityDropdownWrapper.appendChild(cityDropdownBtn);

    const cityDropdownList = document.createElement("div");
    cityDropdownList.id = "city-dropdown-list";
    cityDropdownList.classList.add("hidden");
    document.body.appendChild(cityDropdownList);

    const citySearchWrapper = document.createElement("div");
    citySearchWrapper.id = "city-search-wrapper";
    cityDropdownList.appendChild(citySearchWrapper);

    const citySearch = document.createElement("input");
    citySearch.id = "city-search";
    citySearch.type = "text";
    citySearch.placeholder = "Search cities...";
    citySearchWrapper.appendChild(citySearch);

    const citySearchClear = document.createElement("button");
    citySearchClear.id = "city-search-clear";
    citySearchClear.textContent = "×";
    citySearchClear.classList.add("hidden");
    citySearchWrapper.appendChild(citySearchClear);

    citySearchClear.addEventListener("click", e => {
      e.stopPropagation();
      citySearch.value = "";
      citySearch.dispatchEvent(new Event("input"));
      citySearch.focus();
    });

    citySearch.addEventListener("input", () => {
      const term = citySearch.value.toLowerCase().trim();
      citySearchClear.classList.toggle("hidden", !term);
      cityCheckboxScroll.querySelectorAll(".city-checkbox-item").forEach(item => {
        const label = item.querySelector("label");
        item.style.display = !term || (label && label.textContent.toLowerCase().includes(term)) ? "" : "none";
      });
    });

    const cityCheckboxScroll = document.createElement("div");
    cityCheckboxScroll.id = "city-checkbox-scroll";
    cityDropdownList.appendChild(cityCheckboxScroll);

    const cityActionRow = document.createElement("div");
    cityActionRow.id = "city-action-row";
    cityDropdownList.appendChild(cityActionRow);

    const cityZoomBtn = document.createElement("button");
    cityZoomBtn.id = "city-zoom-btn";
    cityZoomBtn.textContent = "Zoom";
    cityZoomBtn.disabled = true;
    cityActionRow.appendChild(cityZoomBtn);

    const cityClearBtn = document.createElement("button");
    cityClearBtn.id = "city-clear-btn";
    cityClearBtn.textContent = "Clear";
    cityActionRow.appendChild(cityClearBtn);

    toggleBar.appendChild(cityDropdownWrapper);

    // ── Clip & Zip button + dropdown ─────────────────────────────────────────
    const clipZipWrapper = document.createElement("div");
    clipZipWrapper.id = "clip-zip-wrapper";

    const clipZipBtn = document.createElement("button");
    clipZipBtn.id = "clip-zip-btn";
    clipZipBtn.className = "panel-toggle";
    clipZipBtn.textContent = "Clip & Zip";
    clipZipBtn.disabled = true;
    clipZipWrapper.appendChild(clipZipBtn);

    const clipZipDropdown = document.createElement("div");
    clipZipDropdown.id = "clip-zip-dropdown";
    clipZipDropdown.classList.add("hidden");
    document.body.appendChild(clipZipDropdown);

    // Format selector
    const clipFormatRow = document.createElement("div");
    clipFormatRow.id = "clip-format-row";
    clipZipDropdown.appendChild(clipFormatRow);

    const clipFormatLabel = document.createElement("span");
    clipFormatLabel.className = "clip-format-label";
    clipFormatLabel.textContent = "Format:";
    clipFormatRow.appendChild(clipFormatLabel);

    ["SHP", "GeoJSON"].forEach((fmt, i) => {
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "clip-format";
      radio.value = fmt;
      radio.id = `clip-fmt-${fmt}`;
      if (i === 0) radio.checked = true;

      const lbl = document.createElement("label");
      lbl.htmlFor = radio.id;
      lbl.textContent = fmt;

      clipFormatRow.appendChild(radio);
      clipFormatRow.appendChild(lbl);
    });

    // Filename input
    const clipFilenameRow = document.createElement("div");
    clipFilenameRow.id = "clip-filename-row";
    clipZipDropdown.appendChild(clipFilenameRow);

    const clipFilenameLabel = document.createElement("span");
    clipFilenameLabel.className = "clip-format-label";
    clipFilenameLabel.textContent = "File name:";
    clipFilenameRow.appendChild(clipFilenameLabel);

    const clipFilenameInput = document.createElement("input");
    clipFilenameInput.type = "text";
    clipFilenameInput.id = "clip-filename-input";
    clipFilenameInput.placeholder = "nrpc_tool_export";
    clipFilenameRow.appendChild(clipFilenameInput);

    // Status line
    const clipStatus = document.createElement("div");
    clipStatus.id = "clip-status";
    clipStatus.textContent = "Select cities above to export.";
    clipZipDropdown.appendChild(clipStatus);

    // Export button
    const clipExportBtn = document.createElement("button");
    clipExportBtn.id = "clip-export-btn";
    clipExportBtn.textContent = "Export";
    clipExportBtn.disabled = true;
    clipZipDropdown.appendChild(clipExportBtn);

    toggleBar.appendChild(clipZipWrapper);

    view.ui.add(toggleBar, { position: "top-left", index: 0 });

    // ── Panel stack container ─────────────────────────────────────────────────
    const panelsContainer = document.createElement("div");
    panelsContainer.id = "panels-container";
    document.body.appendChild(panelsContainer);

    // Legend panel (visible by default)
    const legendWrapper = document.createElement("div");
    legendWrapper.id = "legend-wrapper";
    legendWrapper.classList.add("panel");
    panelsContainer.appendChild(legendWrapper);

    const legendTitle = document.createElement("div");
    legendTitle.className = "panel-title";
    legendTitle.textContent = "Legend";
    legendWrapper.appendChild(legendTitle);

    const legendContainer = document.createElement("div");
    legendContainer.id = "legend-container";
    legendWrapper.appendChild(legendContainer);
    new Legend({ view, container: legendContainer });

    // Layer list panel (visible by default)
    const layerListWrapper = document.createElement("div");
    layerListWrapper.id = "layer-list-wrapper";
    layerListWrapper.classList.add("panel");
    panelsContainer.appendChild(layerListWrapper);

    const layersTitle = document.createElement("div");
    layersTitle.className = "panel-title";
    layersTitle.textContent = "Layers";
    layerListWrapper.appendChild(layersTitle);

    const layerSearchWrapper = document.createElement("div");
    layerSearchWrapper.id = "layer-search-wrapper";
    layerListWrapper.appendChild(layerSearchWrapper);

    const layerSearch = document.createElement("input");
    layerSearch.id = "layer-search";
    layerSearch.type = "text";
    layerSearch.placeholder = "Search layers...";
    layerSearchWrapper.appendChild(layerSearch);

    const layerSearchClear = document.createElement("button");
    layerSearchClear.id = "layer-search-clear";
    layerSearchClear.textContent = "×";
    layerSearchClear.classList.add("hidden");
    layerSearchWrapper.appendChild(layerSearchClear);

    layerSearchClear.addEventListener("click", () => {
      layerSearch.value = "";
      layerSearch.dispatchEvent(new Event("input"));
      layerSearch.focus();
    });

    const layerListContainer = document.createElement("div");
    layerListContainer.id = "layer-list-container";
    layerListWrapper.appendChild(layerListContainer);
    new LayerList({
      view,
      container: layerListContainer,
      listItemCreatedFunction: ({ item }) => {
        const layer = item.layer;
        if (!layer || layer.type === "graphics") return;

        const wrap = document.createElement("div");
        wrap.className = "opacity-inline-wrap";

        const labelEl = document.createElement("span");
        labelEl.className = "opacity-inline-label";
        labelEl.textContent = "Opacity";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.value = Math.round((layer.opacity ?? 1) * 100);
        slider.className = "opacity-inline-slider";

        const valueDisplay = document.createElement("span");
        valueDisplay.className = "opacity-inline-value";
        valueDisplay.textContent = `${slider.value}%`;

        slider.addEventListener("input", () => {
          layer.opacity = slider.value / 100;
          valueDisplay.textContent = `${slider.value}%`;
        });

        wrap.appendChild(labelEl);
        wrap.appendChild(slider);
        wrap.appendChild(valueDisplay);

        item.panel = {
          content: wrap,
          open: layer.visible,
          icon: "sliders-horizontal"
        };

        layer.watch("visible", visible => {
          item.panel.open = visible;
          if (visible) {
            let p = layer.parent;
            while (p && p.type === "group") {
              p.visible = true;
              p = p.parent;
            }
          }
        });
      }
    });

    layerSearch.addEventListener("input", () => {
      const term = layerSearch.value.toLowerCase().trim();
      layerSearchClear.classList.toggle("hidden", !term);

      // Try calcite-list-item (ArcGIS 4.29+)
      const calciteItems = layerListContainer.querySelectorAll("calcite-list-item");
      if (calciteItems.length > 0) {
        if (!term) {
          calciteItems.forEach(item => (item.style.display = ""));
          return;
        }

        // Hide everything first, then reveal matching leaves + their ancestor groups
        calciteItems.forEach(item => (item.style.display = "none"));

        calciteItems.forEach(item => {
          // Skip group items (they contain nested calcite-list-items)
          if (item.querySelectorAll("calcite-list-item").length > 0) return;

          const label = (item.label || item.getAttribute("label") || "").toLowerCase();
          if (!label.includes(term)) return;

          // Show this leaf and walk up to reveal its parent group(s)
          item.style.display = "";
          let el = item.parentElement;
          while (el && el !== layerListContainer) {
            if (el.tagName?.toLowerCase() === "calcite-list-item") {
              el.style.display = "";
            }
            el = el.parentElement;
          }
        });
        return;
      }

      // Fallback for older esri class-based structure
      layerListContainer.querySelectorAll(".esri-layer-list__item").forEach(item => {
        const title = item.querySelector(".esri-layer-list__item-title");
        if (title) {
          item.style.display = !term || title.textContent.toLowerCase().includes(term) ? "" : "none";
        }
      });
    });

    // ── Graphics layer for city outline highlight ─────────────────────────────
    const cityHighlightLayer = new GraphicsLayer({ listMode: "hide" });
    webmap.add(cityHighlightLayer);

    const cityHighlightSymbol = {
      type: "simple-fill",
      color: [0, 0, 0, 0],
      outline: { color: [0, 194, 255, 1], width: 2.5 }
    };

    // ── City checkbox dropdown ────────────────────────────────────────────────
    const citiesLayer = view.map.allLayers.find(l => l.title && l.title.toLowerCase().includes("cities"));

    // Track selected city geometry union for Clip & Zip
    let clipGeometry = null;

    function updateClipGeometry() {
      const checked = [...cityCheckboxScroll.querySelectorAll("input:checked")];
      if (!checked.length) {
        clipGeometry = null;
        clipZipBtn.disabled = true;
        clipExportBtn.disabled = true;
        clipStatus.textContent = "Select cities above to export.";
        return;
      }
      const inClause = checked.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
      const q = citiesLayer.createQuery();
      q.where = `CTU_NAME IN (${inClause})`;
      q.returnGeometry = true;
      q.outSpatialReference = { wkid: 4326 };
      citiesLayer.queryFeatures(q).then(result => {
        if (!result.features.length) { clipGeometry = null; return; }
        // Union all city geometries into a simple multi-ring polygon for spatial query
        // We pass the array of features to queryAllFeatures individually
        clipGeometry = result.features.map(f => f.geometry);
        clipZipBtn.disabled = false;
        clipExportBtn.disabled = false;
        const n = checked.length;
        clipStatus.textContent = `Ready to export ${n} ${n === 1 ? "city" : "cities"}.`;
      });
    }

    function updateHighlight() {
      cityHighlightLayer.removeAll();
      const checked = [...cityCheckboxScroll.querySelectorAll("input:checked")];
      if (!checked.length) return;
      const inClause = checked.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
      const q = citiesLayer.createQuery();
      q.where = `CTU_NAME IN (${inClause})`;
      q.returnGeometry = true;
      q.outSpatialReference = view.spatialReference;
      citiesLayer.queryFeatures(q).then(result => {
        result.features.forEach(f => {
          cityHighlightLayer.add(new Graphic({ geometry: f.geometry, symbol: cityHighlightSymbol }));
        });
      });
    }

    if (citiesLayer) {
      citiesLayer.load().then(() => {
        const q = citiesLayer.createQuery();
        q.outFields = ["CTU_NAME"];
        q.returnGeometry = false;
        q.orderByFields = ["CTU_NAME"];
        return citiesLayer.queryFeatures(q);
      }).then(result => {
        const names = [...new Set(
          result.features.map(f => f.attributes.CTU_NAME).filter(Boolean)
        )].sort();

        names.forEach(name => {
          const item = document.createElement("div");
          item.className = "city-checkbox-item";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = name;
          cb.id = `city-cb-${name.replace(/\s+/g, "-")}`;

          const lbl = document.createElement("label");
          lbl.htmlFor = cb.id;
          lbl.textContent = name;

          item.appendChild(cb);
          item.appendChild(lbl);
          cityCheckboxScroll.appendChild(item);

          cb.addEventListener("change", () => {
            const count = cityCheckboxScroll.querySelectorAll("input:checked").length;
            cityDropdownBtn.textContent = count === 0
              ? "Zoom to..."
              : `${count} ${count === 1 ? "city" : "cities"} selected`;
            cityZoomBtn.disabled = count === 0;
            updateHighlight();
            updateClipGeometry();
          });
        });
      });

      cityDropdownBtn.addEventListener("click", e => {
        e.stopPropagation();
        const isHidden = cityDropdownList.classList.toggle("hidden");
        cityDropdownBtn.classList.toggle("active", !isHidden);
        if (!isHidden) {
          const rect = cityDropdownBtn.getBoundingClientRect();
          cityDropdownList.style.top = `${rect.bottom + 4}px`;
          cityDropdownList.style.left = `${rect.left}px`;
        }
      });

      document.addEventListener("click", e => {
        if (!cityDropdownWrapper.contains(e.target) && !cityDropdownList.contains(e.target)) {
          cityDropdownList.classList.add("hidden");
          cityDropdownBtn.classList.remove("active");
        }
      });

      cityClearBtn.addEventListener("click", () => {
        cityCheckboxScroll.querySelectorAll("input:checked").forEach(cb => (cb.checked = false));
        cityDropdownBtn.textContent = "Zoom to...";
        cityZoomBtn.disabled = true;
        cityHighlightLayer.removeAll();
        clipGeometry = null;
        clipZipBtn.disabled = true;
        clipExportBtn.disabled = true;
        clipStatus.textContent = "Select cities above to export.";
      });

      cityZoomBtn.addEventListener("click", () => {
        const checked = [...cityDropdownList.querySelectorAll("input:checked")];
        if (!checked.length) return;

        const inClause = checked.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
        const q = citiesLayer.createQuery();
        q.where = `CTU_NAME IN (${inClause})`;
        q.returnGeometry = true;
        q.outSpatialReference = view.spatialReference;

        citiesLayer.queryFeatures(q).then(result => {
          if (!result.features.length) return;
          let extent = result.features[0].geometry.extent;
          for (let i = 1; i < result.features.length; i++) {
            extent = extent.union(result.features[i].geometry.extent);
          }
          view.goTo(extent.expand(1.5));
          cityDropdownList.classList.add("hidden");
          cityDropdownBtn.classList.remove("active");
        });
      });
    }

    // ── Clip & Zip dropdown toggle ────────────────────────────────────────────
    clipZipBtn.addEventListener("click", e => {
      e.stopPropagation();
      const isHidden = clipZipDropdown.classList.toggle("hidden");
      clipZipBtn.classList.toggle("active", !isHidden);
      if (!isHidden) {
        const rect = clipZipBtn.getBoundingClientRect();
        clipZipDropdown.style.top  = `${rect.bottom + 4}px`;
        clipZipDropdown.style.left = `${rect.left}px`;
      }
    });

    document.addEventListener("click", e => {
      if (!clipZipWrapper.contains(e.target) && !clipZipDropdown.contains(e.target)) {
        clipZipDropdown.classList.add("hidden");
        clipZipBtn.classList.remove("active");
      }
    });

    // ── Export handler ────────────────────────────────────────────────────────
    clipExportBtn.addEventListener("click", async () => {
      if (!clipGeometry || !clipGeometry.length) return;

      const format = document.querySelector("input[name='clip-format']:checked").value;

      clipExportBtn.disabled = true;
      clipZipBtn.disabled = true;
      clipStatus.textContent = "Detecting layers...";

      const layers = getExportableLayers(webmap);
      if (!layers.length) {
        clipStatus.textContent = "No visible exportable layers found.";
        clipExportBtn.disabled = false;
        clipZipBtn.disabled = false;
        return;
      }

      const zip = new JSZip();
      let exported = 0;
      let skipped = 0;

      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        clipStatus.textContent = `Querying layer ${li + 1}/${layers.length}: ${layer.title || "Untitled"}...`;

        try {
          // Collect features intersecting ANY selected city
          const allFeatures = [];
          for (const geom of clipGeometry) {
            const feats = await queryAllFeatures(layer, geom);
            // Deduplicate by OBJECTID
            feats.forEach(f => {
              const oid = f.attributes?.OBJECTID ?? f.attributes?.objectid;
              if (!allFeatures.some(e => {
                const eoid = e.attributes?.OBJECTID ?? e.attributes?.objectid;
                return oid !== undefined && eoid === oid;
              })) {
                allFeatures.push(f);
              }
            });
          }

          if (!allFeatures.length) { skipped++; continue; }

          const folderName = safeName(layer.title || `layer_${li + 1}`);

          if (format === "GeoJSON") {
            const geojson = featuresToGeoJSON(allFeatures);
            zip.file(`${folderName}.geojson`, geojson);
          } else {
            // SHP
            const { shp, shx } = buildSHP(allFeatures);
            const dbf = buildDBF(allFeatures);
            const prj = WGS84_PRJ;
            zip.file(`${folderName}/${folderName}.shp`, shp);
            zip.file(`${folderName}/${folderName}.shx`, shx);
            zip.file(`${folderName}/${folderName}.dbf`, dbf);
            zip.file(`${folderName}/${folderName}.prj`, prj);
          }
          exported++;
        } catch (err) {
          console.warn(`Clip & Zip: skipping layer "${layer.title}" — ${err.message}`);
          skipped++;
        }
      }

      if (!exported) {
        clipStatus.textContent = "No features found in selected area.";
        clipExportBtn.disabled = false;
        clipZipBtn.disabled = false;
        return;
      }

      clipStatus.textContent = `Zipping ${exported} layer${exported !== 1 ? "s" : ""}...`;

      const blob = await zip.generateAsync({ type: "blob" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      const zipName = (clipFilenameInput.value.trim() || clipFilenameInput.placeholder) + ".zip";
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const msg = skipped
        ? `Done! ${exported} layer${exported !== 1 ? "s" : ""} exported, ${skipped} skipped (empty or error).`
        : `Done! ${exported} layer${exported !== 1 ? "s" : ""} exported.`;
      clipStatus.textContent = msg;
      clipExportBtn.disabled = false;
      clipZipBtn.disabled = false;
    });

    // ── Toggle handlers ───────────────────────────────────────────────────────
    legendToggle.addEventListener("click", () => {
      legendWrapper.classList.toggle("hidden");
      legendToggle.classList.toggle("active");
    });
    layersToggle.addEventListener("click", () => {
      layerListWrapper.classList.toggle("hidden");
      layersToggle.classList.toggle("active");
    });
  });
});

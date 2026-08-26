require([
  "esri/WebMap",
  "esri/views/MapView",
  "esri/widgets/Home",
  "esri/widgets/LayerList",
  "esri/widgets/Legend",
  "esri/widgets/Editor",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/Basemap",
  "esri/geometry/geometryEngine",
  "esri/geometry/Point",
], (WebMap, MapView, Home, LayerList, Legend, Editor, GraphicsLayer, Graphic, Basemap, geometryEngine, Point) => {

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

  // ── Main app ─────────────────────────────────────────────────────────────────

  view.when(() => {
    view.ui.move("zoom", "top-right");

    const openTabBtn = document.createElement("div");
    openTabBtn.className = "esri-widget esri-widget--button esri-interactive";
    openTabBtn.title = "Open in new tab";
    openTabBtn.innerHTML = `<span class="esri-icon esri-icon-launch-link-external"></span>`;
    openTabBtn.addEventListener("click", () => window.open(window.location.href, "_blank"));
    view.ui.add(openTabBtn, { position: "top-right", index: 0 });

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
    legendToggle.className = "panel-toggle";
    legendToggle.textContent = "Legend";
    toggleBar.appendChild(legendToggle);

    const layersToggle = document.createElement("button");
    layersToggle.id = "layers-toggle";
    layersToggle.className = "panel-toggle active";
    layersToggle.textContent = "Layers";
    toggleBar.appendChild(layersToggle);

    const contributeToggle = document.createElement("button");
    contributeToggle.id = "contribute-toggle";
    contributeToggle.className = "panel-toggle";
    contributeToggle.textContent = "Contribute";
    toggleBar.appendChild(contributeToggle);

    const basemapWrapper = document.createElement("div");
    basemapWrapper.id = "basemap-wrapper";

    const basemapBtn = document.createElement("button");
    basemapBtn.id = "basemap-btn";
    basemapBtn.className = "panel-toggle";
    basemapBtn.textContent = "Basemap";
    basemapWrapper.appendChild(basemapBtn);

    const basemapDropdown = document.createElement("div");
    basemapDropdown.id = "basemap-dropdown";
    basemapDropdown.classList.add("hidden");
    document.body.appendChild(basemapDropdown);

    toggleBar.appendChild(basemapWrapper);

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
    citySearch.placeholder = "Search...";
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
      cityCheckboxScroll.querySelectorAll(".city-checkbox-item, .watershed-checkbox-item").forEach(item => {
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
    clipZipWrapper.appendChild(clipZipBtn);

    const clipZipDropdown = document.createElement("div");
    clipZipDropdown.id = "clip-zip-dropdown";
    clipZipDropdown.classList.add("hidden");
    document.body.appendChild(clipZipDropdown);

    // Warning shown when conditions not met
    const clipWarning = document.createElement("div");
    clipWarning.id = "clip-warning";
    clipWarning.textContent = "Clip & Zip requires at least one non-Boundaries layer to be visible and a city or county extent selected in Zoom to...";
    clipZipDropdown.appendChild(clipWarning);

    // Form contents shown when conditions are met
    const clipFormContents = document.createElement("div");
    clipFormContents.id = "clip-form-contents";
    clipFormContents.classList.add("hidden");
    clipZipDropdown.appendChild(clipFormContents);

    // Format selector
    const clipFormatRow = document.createElement("div");
    clipFormatRow.id = "clip-format-row";
    clipFormContents.appendChild(clipFormatRow);

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
    clipFormContents.appendChild(clipFilenameRow);

    const clipFilenameLabel = document.createElement("span");
    clipFilenameLabel.className = "clip-format-label";
    clipFilenameLabel.textContent = "File name:";
    clipFilenameRow.appendChild(clipFilenameLabel);

    const clipFilenameInput = document.createElement("input");
    clipFilenameInput.type = "text";
    clipFilenameInput.id = "clip-filename-input";
    clipFilenameInput.placeholder = "nrpc_tool_export";
    clipFilenameRow.appendChild(clipFilenameInput);

    // Status line + spinner
    const clipStatusRow = document.createElement("div");
    clipStatusRow.id = "clip-status-row";
    clipFormContents.appendChild(clipStatusRow);

    const clipSpinner = document.createElement("div");
    clipSpinner.id = "clip-spinner";
    clipSpinner.classList.add("hidden");
    clipStatusRow.appendChild(clipSpinner);

    const clipStatus = document.createElement("div");
    clipStatus.id = "clip-status";
    clipStatusRow.appendChild(clipStatus);

    // Export button
    const clipExportBtn = document.createElement("button");
    clipExportBtn.id = "clip-export-btn";
    clipExportBtn.textContent = "Export";
    clipExportBtn.disabled = true;
    clipFormContents.appendChild(clipExportBtn);

    toggleBar.appendChild(clipZipWrapper);

    view.ui.add(toggleBar, { position: "top-left", index: 0 });

    // ── Panel stack container ─────────────────────────────────────────────────
    const panelsContainer = document.createElement("div");
    panelsContainer.id = "panels-container";
    document.body.appendChild(panelsContainer);

    // Legend panel (hidden by default)
    const legendWrapper = document.createElement("div");
    legendWrapper.id = "legend-wrapper";
    legendWrapper.classList.add("panel", "hidden");
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
    // Tracks when group visibility is being set by parent propagation vs. direct user click
    let propagatingDepth = 0;
    // Set true during Contribute activation to suppress "turn on all children" for ancestor groups
    let skipChildCascade = false;

    new LayerList({
      view,
      container: layerListContainer,
      listItemCreatedFunction: ({ item }) => {
        const layer = item.layer;
        if (!layer || layer.type === "graphics") return;

        // Group layers: auto-expand when made visible + opacity panel
        if (layer.type === "group") {
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
            open: false,
            icon: "sliders-horizontal"
          };

          layer.watch("visible", visible => {
            if (visible) {
              item.open = true;
              if (propagatingDepth === 0 && !skipChildCascade) {
                layer.layers.forEach(child => { child.visible = true; });
              }
              propagatingDepth++;
              let p = layer.parent;
              while (p && p.type === "group") {
                p.visible = true;
                p = p.parent;
              }
              propagatingDepth--;
            } else {
              item.open = false;
            }
          });
          return;
        }

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
          open: false,
          icon: "sliders-horizontal"
        };

        layer.watch("visible", visible => {
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

    // Find the Hennepin County boundary layer (inside Boundaries group, exact title match)
    const countyLayer = view.map.allLayers.find(l =>
      l.title === "Hennepin County" &&
      l.parent && l.parent.title && l.parent.title.toLowerCase().includes("boundaries")
    );

    const watershedsLayer = view.map.allLayers.find(l => l.title === "Watershed Districts");

    let clipGeometry = null;
    let fullCountySelected = false;
    let countyGeometryCache = null;

    // Update the Clip & Zip panel state based on whether extent + visible layers are both present
    function updateClipZipPanel() {
      const hasExtent = clipGeometry !== null;
      const hasLayers = getExportableLayers(webmap).length > 0;
      const ready = hasExtent && hasLayers;
      clipWarning.classList.toggle("hidden", ready);
      clipFormContents.classList.toggle("hidden", !ready);
      clipExportBtn.disabled = !ready;
      if (ready && !clipStatus.textContent) {
        clipStatus.textContent = fullCountySelected
          ? "Ready to export full county."
          : (() => {
              const n = cityCheckboxScroll.querySelectorAll("input:checked").length;
              return `Ready to export ${n} ${n === 1 ? "city" : "cities"}.`;
            })();
      }
    }

    function updateClipGeometry() {
      if (fullCountySelected) {
        updateClipZipPanel();
        return;
      }
      const checkedCities = [...cityCheckboxScroll.querySelectorAll("input[data-type='city']:checked")];
      const checkedWatersheds = [...cityCheckboxScroll.querySelectorAll("input[data-type='watershed']:checked")];
      if (!checkedCities.length && !checkedWatersheds.length) {
        clipGeometry = null;
        updateClipZipPanel();
        return;
      }
      const promises = [];
      if (checkedCities.length && citiesLayer) {
        const inClause = checkedCities.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
        const q = citiesLayer.createQuery();
        q.where = `CTU_NAME IN (${inClause})`;
        q.returnGeometry = true;
        q.outSpatialReference = { wkid: 4326 };
        promises.push(citiesLayer.queryFeatures(q).then(r => r.features));
      }
      if (checkedWatersheds.length && watershedsLayer) {
        const inClause = checkedWatersheds.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
        const q = watershedsLayer.createQuery();
        q.where = `BWSR_NAME IN (${inClause})`;
        q.returnGeometry = true;
        q.outSpatialReference = { wkid: 4326 };
        promises.push(watershedsLayer.queryFeatures(q).then(r => r.features));
      }
      Promise.all(promises).then(results => {
        const features = results.flat();
        if (!features.length) { clipGeometry = null; updateClipZipPanel(); return; }
        clipGeometry = features.map(f => f.geometry);
        const n = checkedCities.length + checkedWatersheds.length;
        clipStatus.textContent = `Ready to export ${n} ${n === 1 ? "area" : "areas"}.`;
        updateClipZipPanel();
      });
    }

    function updateHighlight() {
      cityHighlightLayer.removeAll();
      if (fullCountySelected && countyGeometryCache) {
        cityHighlightLayer.add(new Graphic({ geometry: countyGeometryCache, symbol: cityHighlightSymbol }));
        return;
      }
      const checkedCities = [...cityCheckboxScroll.querySelectorAll("input[data-type='city']:checked")];
      const checkedWatersheds = [...cityCheckboxScroll.querySelectorAll("input[data-type='watershed']:checked")];
      const promises = [];
      if (checkedCities.length && citiesLayer) {
        const inClause = checkedCities.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
        const q = citiesLayer.createQuery();
        q.where = `CTU_NAME IN (${inClause})`;
        q.returnGeometry = true;
        q.outSpatialReference = view.spatialReference;
        promises.push(citiesLayer.queryFeatures(q).then(r => r.features));
      }
      if (checkedWatersheds.length && watershedsLayer) {
        const inClause = checkedWatersheds.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
        const q = watershedsLayer.createQuery();
        q.where = `BWSR_NAME IN (${inClause})`;
        q.returnGeometry = true;
        q.outSpatialReference = view.spatialReference;
        promises.push(watershedsLayer.queryFeatures(q).then(r => r.features));
      }
      Promise.all(promises).then(results => {
        results.flat().forEach(f => {
          cityHighlightLayer.add(new Graphic({ geometry: f.geometry, symbol: cityHighlightSymbol }));
        });
      });
    }

    function selectFullCounty() {
      fullCountySelected = true;
      // Uncheck all individual cities (not the Full County checkbox itself)
      cityCheckboxScroll.querySelectorAll("input[type=checkbox]:not(#city-cb-full-county)").forEach(cb => (cb.checked = false));
      cityDropdownBtn.textContent = "Full county selected";
      cityZoomBtn.disabled = false;

      const applyCounty = geom => {
        countyGeometryCache = geom;
        clipGeometry = [geom];
        updateHighlight();
        clipStatus.textContent = "Ready to export full county.";
        updateClipZipPanel();
      };

      if (countyGeometryCache) {
        applyCounty(countyGeometryCache);
      } else if (countyLayer) {
        countyLayer.load().then(() => {
          const q = countyLayer.createQuery();
          q.returnGeometry = true;
          q.outSpatialReference = { wkid: 4326 };
          return countyLayer.queryFeatures(q);
        }).then(result => {
          if (result.features.length) applyCounty(result.features[0].geometry);
        });
      }
    }

    // Full County checkbox item at top of list
    const fullCountyItem = document.createElement("div");
    fullCountyItem.className = "city-checkbox-item city-checkbox-county";

    const fullCountyCb = document.createElement("input");
    fullCountyCb.type = "checkbox";
    fullCountyCb.id = "city-cb-full-county";

    const fullCountyLbl = document.createElement("label");
    fullCountyLbl.htmlFor = "city-cb-full-county";
    fullCountyLbl.textContent = "Full County";

    fullCountyItem.appendChild(fullCountyCb);
    fullCountyItem.appendChild(fullCountyLbl);
    cityCheckboxScroll.appendChild(fullCountyItem);

    const fullCountySep = document.createElement("div");
    fullCountySep.className = "city-county-separator";
    cityCheckboxScroll.appendChild(fullCountySep);

    const cityContainer = document.createElement("div");
    cityContainer.id = "city-container";
    cityCheckboxScroll.appendChild(cityContainer);

    const watershedContainer = document.createElement("div");
    watershedContainer.id = "watershed-container";
    cityCheckboxScroll.appendChild(watershedContainer);

    fullCountyCb.addEventListener("change", () => {
      if (fullCountyCb.checked) {
        selectFullCounty();
      } else {
        fullCountySelected = false;
        clipGeometry = null;
        cityHighlightLayer.removeAll();
        cityDropdownBtn.textContent = "Zoom to...";
        cityZoomBtn.disabled = true;
        updateClipZipPanel();
      }
    });

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

        if (watershedsLayer) {
          const cHeader = document.createElement("div");
          cHeader.className = "city-section-header";
          cHeader.textContent = "Cities";
          cityContainer.appendChild(cHeader);
        }

        names.forEach(name => {
          const item = document.createElement("div");
          item.className = "city-checkbox-item";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = name;
          cb.dataset.type = "city";
          cb.id = `city-cb-${name.replace(/\s+/g, "-")}`;

          const lbl = document.createElement("label");
          lbl.htmlFor = cb.id;
          lbl.textContent = name;

          item.appendChild(cb);
          item.appendChild(lbl);
          cityContainer.appendChild(item);

          cb.addEventListener("change", () => {
            if (cb.checked && fullCountySelected) {
              fullCountyCb.checked = false;
              fullCountySelected = false;
              cityHighlightLayer.removeAll();
            }
            const total = cityCheckboxScroll.querySelectorAll("input[data-type]:checked").length;
            cityDropdownBtn.textContent = total === 0
              ? "Zoom to..."
              : `${total} ${total === 1 ? "area" : "areas"} selected`;
            cityZoomBtn.disabled = total === 0;
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
        cityCheckboxScroll.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.checked = false));
        fullCountySelected = false;
        clipGeometry = null;
        cityHighlightLayer.removeAll();
        cityDropdownBtn.textContent = "Zoom to...";
        cityZoomBtn.disabled = true;
        updateClipZipPanel();
      });

      cityZoomBtn.addEventListener("click", () => {
        if (fullCountySelected && countyGeometryCache) {
          view.goTo(countyGeometryCache.extent.expand(1.1));
          cityDropdownList.classList.add("hidden");
          cityDropdownBtn.classList.remove("active");
          return;
        }
        const checkedCities = [...cityDropdownList.querySelectorAll("input[data-type='city']:checked")];
        const checkedWatersheds = [...cityDropdownList.querySelectorAll("input[data-type='watershed']:checked")];
        const promises = [];
        if (checkedCities.length && citiesLayer) {
          const inClause = checkedCities.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
          const q = citiesLayer.createQuery();
          q.where = `CTU_NAME IN (${inClause})`;
          q.returnGeometry = true;
          q.outSpatialReference = view.spatialReference;
          promises.push(citiesLayer.queryFeatures(q).then(r => r.features));
        }
        if (checkedWatersheds.length && watershedsLayer) {
          const inClause = checkedWatersheds.map(cb => `'${cb.value.replace(/'/g, "''")}'`).join(",");
          const q = watershedsLayer.createQuery();
          q.where = `BWSR_NAME IN (${inClause})`;
          q.returnGeometry = true;
          q.outSpatialReference = view.spatialReference;
          promises.push(watershedsLayer.queryFeatures(q).then(r => r.features));
        }
        if (!promises.length) return;
        Promise.all(promises).then(results => {
          const features = results.flat();
          if (!features.length) return;
          let extent = features[0].geometry.extent;
          for (let i = 1; i < features.length; i++) {
            extent = extent.union(features[i].geometry.extent);
          }
          view.goTo(extent.expand(1.5));
          cityDropdownList.classList.add("hidden");
          cityDropdownBtn.classList.remove("active");
        });
      });
    }

    // ── Watershed Districts dropdown population ───────────────────────────────
    const toProperCase = str => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

    if (watershedsLayer) {
      const wHeader = document.createElement("div");
      wHeader.className = "city-section-header";
      wHeader.textContent = "Watershed Districts";
      watershedContainer.appendChild(wHeader);

      watershedsLayer.load().then(() => {
        const q = watershedsLayer.createQuery();
        q.outFields = ["BWSR_NAME"];
        q.returnGeometry = false;
        q.orderByFields = ["BWSR_NAME"];
        return watershedsLayer.queryFeatures(q);
      }).then(result => {
        const names = [...new Set(
          result.features.map(f => f.attributes.BWSR_NAME).filter(Boolean)
        )].sort();

        names.forEach(name => {
          const item = document.createElement("div");
          item.className = "watershed-checkbox-item";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = name;
          cb.dataset.type = "watershed";
          cb.id = `watershed-cb-${name.replace(/\s+/g, "-")}`;

          const lbl = document.createElement("label");
          lbl.htmlFor = cb.id;
          lbl.textContent = toProperCase(name);

          item.appendChild(cb);
          item.appendChild(lbl);
          watershedContainer.appendChild(item);

          cb.addEventListener("change", () => {
            if (cb.checked && fullCountySelected) {
              fullCountyCb.checked = false;
              fullCountySelected = false;
              cityHighlightLayer.removeAll();
            }
            const total = cityCheckboxScroll.querySelectorAll("input[data-type]:checked").length;
            cityDropdownBtn.textContent = total === 0
              ? "Zoom to..."
              : `${total} ${total === 1 ? "area" : "areas"} selected`;
            cityZoomBtn.disabled = total === 0;
            updateHighlight();
            updateClipGeometry();
          });
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
        updateClipZipPanel();
      }
    });

    // Keep panel state in sync when layer visibility changes while dropdown is open
    view.map.allLayers.forEach(l => {
      if (l.type === "feature" || l.type === "group") {
        l.watch("visible", () => {
          if (!clipZipDropdown.classList.contains("hidden")) updateClipZipPanel();
        });
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
      clipSpinner.classList.remove("hidden");
      clipStatus.textContent = "Detecting layers...";

      const layers = getExportableLayers(webmap);
      if (!layers.length) {
        clipStatus.textContent = "No visible exportable layers found.";
        clipSpinner.classList.add("hidden");
        clipExportBtn.disabled = false;
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
          let allFeatures = [];
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

          // Clip each feature's geometry to the exact selected boundary
          const clipUnion = clipGeometry.length === 1
            ? clipGeometry[0]
            : geometryEngine.union(clipGeometry);
          allFeatures = allFeatures.map(f => {
            if (!f.geometry) return f;
            const clipped = geometryEngine.intersect(f.geometry, clipUnion);
            return clipped ? { geometry: clipped, attributes: f.attributes } : null;
          }).filter(Boolean);

          if (!allFeatures.length) { skipped++; continue; }

          const folderName = safeName(layer.title || `layer_${li + 1}`);

          if (format === "GeoJSON") {
            const geojson = featuresToGeoJSON(allFeatures);
            allFeatures = null;
            zip.file(`${folderName}.geojson`, geojson);
          } else {
            // SHP
            const { shp, shx } = buildSHP(allFeatures);
            const dbf = buildDBF(allFeatures);
            allFeatures = null;
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
        clipSpinner.classList.add("hidden");
        clipExportBtn.disabled = false;
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
      clipSpinner.classList.add("hidden");
      clipExportBtn.disabled = false;
    });

    // ── Basemap dropdown ──────────────────────────────────────────────────────
    const BASEMAP_OPTIONS = [
      { label: "Light Gray Canvas", id: null },
      { label: "Imagery",           id: "satellite" },
      { label: "Navigation",        id: "streets-navigation-vector" },
    ];

    const loadedBasemaps = { "Light Gray Canvas": webmap.basemap };
    const basemapOpacity = {};
    BASEMAP_OPTIONS.forEach(opt => { basemapOpacity[opt.label] = 1.0; });

    BASEMAP_OPTIONS.slice(1).forEach(opt => {
      try {
        const bm = Basemap.fromId(opt.id);
        bm.load()
          .then(() => { loadedBasemaps[opt.label] = bm; })
          .catch(err => console.warn(`Basemap "${opt.label}" failed to load:`, err));
      } catch (err) {
        console.warn(`Basemap "${opt.label}" could not be created:`, err);
      }
    });

    let activeBasemapLabel = "Light Gray Canvas";

    function applyBasemapOpacity(label, opacity) {
      const bm = loadedBasemaps[label];
      if (bm) bm.baseLayers.forEach(l => { l.opacity = opacity; });
    }

    // Dropdown: radio options
    const basemapOptionsDiv = document.createElement("div");
    basemapOptionsDiv.id = "basemap-options";
    basemapDropdown.appendChild(basemapOptionsDiv);

    BASEMAP_OPTIONS.forEach((opt, i) => {
      const row = document.createElement("div");
      row.className = "basemap-option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "basemap-select";
      radio.value = opt.label;
      radio.id = `basemap-opt-${i}`;
      radio.checked = i === 0;

      const lbl = document.createElement("label");
      lbl.htmlFor = radio.id;
      lbl.textContent = opt.label;

      row.appendChild(radio);
      row.appendChild(lbl);
      basemapOptionsDiv.appendChild(row);

      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        const bm = loadedBasemaps[opt.label];
        if (!bm) return;
        activeBasemapLabel = opt.label;
        view.map.basemap = bm;
        const savedOpacity = basemapOpacity[opt.label];
        bmSlider.value = Math.round(savedOpacity * 100);
        bmValue.textContent = `${bmSlider.value}%`;
        applyBasemapOpacity(opt.label, savedOpacity);
      });
    });

    // Dropdown: opacity slider
    const bmOpacityRow = document.createElement("div");
    bmOpacityRow.className = "opacity-inline-wrap";
    bmOpacityRow.id = "basemap-opacity-row";
    basemapDropdown.appendChild(bmOpacityRow);

    const bmLabel = document.createElement("span");
    bmLabel.className = "opacity-inline-label";
    bmLabel.textContent = "Opacity";
    bmOpacityRow.appendChild(bmLabel);

    const bmSlider = document.createElement("input");
    bmSlider.type = "range";
    bmSlider.min = "0";
    bmSlider.max = "100";
    bmSlider.value = "100";
    bmSlider.className = "opacity-inline-slider";
    bmOpacityRow.appendChild(bmSlider);

    const bmValue = document.createElement("span");
    bmValue.className = "opacity-inline-value";
    bmValue.textContent = "100%";
    bmOpacityRow.appendChild(bmValue);

    bmSlider.addEventListener("input", () => {
      const opacity = bmSlider.value / 100;
      bmValue.textContent = `${bmSlider.value}%`;
      basemapOpacity[activeBasemapLabel] = opacity;
      applyBasemapOpacity(activeBasemapLabel, opacity);
    });

    basemapBtn.addEventListener("click", e => {
      e.stopPropagation();
      const isHidden = basemapDropdown.classList.toggle("hidden");
      basemapBtn.classList.toggle("active", !isHidden);
      if (!isHidden) {
        const rect = basemapBtn.getBoundingClientRect();
        basemapDropdown.style.top  = `${rect.bottom + 4}px`;
        basemapDropdown.style.left = `${rect.left}px`;
      }
    });

    document.addEventListener("click", e => {
      if (!basemapWrapper.contains(e.target) && !basemapDropdown.contains(e.target)) {
        basemapDropdown.classList.add("hidden");
        basemapBtn.classList.remove("active");
      }
    });

    // Contribute panel
    const contributeWrapper = document.createElement("div");
    contributeWrapper.id = "contribute-wrapper";
    contributeWrapper.classList.add("panel", "hidden");
    view.ui.add(contributeWrapper, { position: "top-right", index: 0 });

    const contributeTitle = document.createElement("div");
    contributeTitle.className = "panel-title";
    contributeTitle.textContent = "Contribute";
    contributeWrapper.appendChild(contributeTitle);

    const contributeContainer = document.createElement("div");
    contributeContainer.id = "contribute-container";
    contributeWrapper.appendChild(contributeContainer);

    new Editor({ view, container: contributeContainer });

    // ── Toggle handlers ───────────────────────────────────────────────────────
    legendToggle.addEventListener("click", () => {
      legendWrapper.classList.toggle("hidden");
      legendToggle.classList.toggle("active");
    });
    layersToggle.addEventListener("click", () => {
      layerListWrapper.classList.toggle("hidden");
      layersToggle.classList.toggle("active");
    });
    const opportunityGroup = view.map.allLayers.find(l =>
      l.type === "group" && l.title === "NRPC Opportunity Layers"
    );

    contributeToggle.addEventListener("click", () => {
      const opening = contributeWrapper.classList.toggle("hidden") === false;
      contributeToggle.classList.toggle("active");
      if (opening && opportunityGroup && !opportunityGroup.visible) {
        // Suppress the "turn on all children" cascade while we make ancestor groups visible.
        // Without this, making "NRPC Data" (the parent) visible would also turn on every
        // sibling group alongside "NRPC Opportunity Layers".
        skipChildCascade = true;

        // Make ancestor group(s) visible first — their watchers fire but cascade is suppressed.
        let p = opportunityGroup.parent;
        while (p && p.type === "group") {
          if (!p.visible) p.visible = true;
          p = p.parent;
        }

        // Now make the opportunity group itself visible.
        // Its watcher also has cascade suppressed, so manually turn on its children.
        opportunityGroup.visible = true;
        opportunityGroup.layers.forEach(child => { child.visible = true; });

        // Reset after all async watchers have fired.
        Promise.resolve().then(() => { skipChildCascade = false; });
      }
    });

    // Auto-show legend the first time any non-Boundaries group layer becomes visible
    let legendAutoShown = false;
    const autoLegendHandles = [];
    view.map.allLayers
      .filter(l => l.type === "group" && l.title && !l.title.toLowerCase().includes("boundaries"))
      .forEach(layer => {
        const handle = layer.watch("visible", visible => {
          if (visible && !legendAutoShown) {
            legendAutoShown = true;
            legendWrapper.classList.remove("hidden");
            legendToggle.classList.add("active");
            autoLegendHandles.forEach(h => h.remove());
          }
        });
        autoLegendHandles.push(handle);
      });

    // ── Street View Panel ─────────────────────────────────────────────────
    //
    // A real panorama, not a photo. `google.maps.StreetViewPanorama` from the
    // Maps JavaScript API gives us, for free, everything Bryan asked for:
    // the chevron arrows along the road (`linksControl`), click-to-move to the
    // next scene (`clickToGo`), drag to look around, and keyboard arrows once
    // the panorama has focus. The old static `<img>` + heading slider was an
    // imitation of all of that; it is gone, and so is the ArcGIS aerial
    // fallback — the map underneath already has an aerial basemap.
    //
    // API key: the user's, not the repo's — the same deal the Parcel Report
    // makes for its Anthropic key. It is typed into the panel, kept in
    // localStorage on that one browser, and sent only to maps.googleapis.com.
    // It is never committed and never logged.
    //
    // Resolution order, first hit wins:
    //   1. localStorage — what the user typed here.
    //   2. window.STREET_VIEW_API_KEY from js/config.js — still how the
    //      deployed site gets its key (GitHub Actions writes config.js at
    //      deploy time from the GOOGLE_STREET_VIEW_API_KEY secret; locally
    //      `cp js/config.example.js js/config.js`). Any deployed key MUST be
    //      HTTP-referrer-restricted in the Google Cloud console — it ships to
    //      the browser in a public site.
    //   3. Ask, once, in the panel.
    //
    // The key now needs BOTH "Maps JavaScript API" (the panorama) and
    // "Street View Static API" (the free metadata pre-check) enabled on it.

    const SV_STORAGE_KEY = "nrpc-street-view.apiKey";

    function svStoredKey() {
      try {
        return (localStorage.getItem(SV_STORAGE_KEY) || "").trim();
      } catch (_) {
        // Private mode / blocked storage — behave as if nothing is stored.
        return "";
      }
    }

    function svConfigKey() {
      return typeof STREET_VIEW_API_KEY === "string" &&
        STREET_VIEW_API_KEY.trim() &&
        !STREET_VIEW_API_KEY.startsWith("YOUR_")
        ? STREET_VIEW_API_KEY.trim()
        : "";
    }

    // The live key and where it came from. Recomputed whenever the user saves
    // or clears, so clearing a typed key falls back to config.js rather than
    // to nothing.
    let svKey = null;
    let svKeySource = "none"; // "stored" | "config" | "none"

    function svResolveKey() {
      const stored = svStoredKey();
      if (stored) {
        svKey = stored;
        svKeySource = "stored";
        return;
      }
      const cfg = svConfigKey();
      if (cfg) {
        svKey = cfg;
        svKeySource = "config";
        return;
      }
      svKey = null;
      svKeySource = "none";
    }

    svResolveKey();

    // Asked once per page load, and once declined it stays declined for the
    // session — clicking the map keeps working, the panel just says so.
    let svKeyAsked = false;
    let svKeyDeclined = false;

    const svPanel = document.createElement("div");
    svPanel.id = "street-view-panel";

    const svHeader = document.createElement("div");
    svHeader.id = "street-view-header";
    const svTitle = document.createElement("span");
    svTitle.id = "street-view-title";
    svTitle.textContent = "Street View";
    const svClose = document.createElement("button");
    svClose.id = "street-view-close";
    svClose.textContent = "×";
    svClose.title = "Close";
    svHeader.append(svTitle, svClose);

    const svLocation = document.createElement("div");
    svLocation.id = "street-view-location";

    // The stage: the panorama fills it, and everything else (date badge,
    // messages, placeholder) is an overlay on top of it.
    const svStage = document.createElement("div");
    svStage.id = "street-view-stage";

    // Google mounts the panorama into this div and owns its contents.
    const svPanoDiv = document.createElement("div");
    svPanoDiv.id = "street-view-pano";

    // "Imagery: May 2024", centred at the bottom of the picture. Only ever
    // shows a date Google actually gave us — never a placeholder.
    const svDateBadge = document.createElement("div");
    svDateBadge.id = "sv-date-badge";
    svDateBadge.style.display = "none";

    const svNoImg = document.createElement("div");
    svNoImg.id = "street-view-no-img";
    const svNoImgText = document.createElement("span");
    svNoImgText.id = "sv-no-img-text";
    svNoImgText.textContent = "No Street View imagery available near this location.";
    // Only shown when the message is about the key rather than the imagery.
    const svNoImgKeyBtn = document.createElement("button");
    svNoImgKeyBtn.type = "button";
    svNoImgKeyBtn.id = "sv-no-img-key";
    svNoImgKeyBtn.className = "sv-link hidden";
    svNoImgKeyBtn.textContent = "Change key";
    svNoImg.append(svNoImgText, svNoImgKeyBtn);

    const svPlaceholder = document.createElement("div");
    svPlaceholder.id = "sv-placeholder";

    svStage.append(svPanoDiv, svDateBadge, svNoImg, svPlaceholder);

    // -- timeline row: chips for other capture dates, when Google gives any --
    const svTimelineRow = document.createElement("div");
    svTimelineRow.id = "sv-timeline-row";
    svTimelineRow.style.display = "none";
    const svTimelineLabel = document.createElement("span");
    svTimelineLabel.id = "sv-timeline-label";
    svTimelineLabel.textContent = "Other dates";
    const svTimelineChips = document.createElement("div");
    svTimelineChips.id = "sv-timeline-chips";
    const svTimelineNote = document.createElement("span");
    svTimelineNote.id = "sv-timeline-note";
    // "See more dates" is a Google Maps end-user feature with no API surface,
    // so when we cannot offer a timeline we hand the exact panorama over to
    // the one place that can. Documented Maps URL: map_action=pano&pano=<id>.
    const svMapsLink = document.createElement("a");
    svMapsLink.id = "sv-maps-link";
    svMapsLink.target = "_blank";
    svMapsLink.rel = "noopener noreferrer";
    svMapsLink.textContent = "See more dates in Google Maps ↗";
    svMapsLink.style.display = "none";
    svTimelineRow.append(svTimelineLabel, svTimelineChips, svTimelineNote, svMapsLink);

    // -- key form: an in-panel input, never a window.prompt --
    const svKeyForm = document.createElement("form");
    svKeyForm.id = "sv-key-form";
    svKeyForm.className = "hidden";
    const svKeyLabel = document.createElement("div");
    svKeyLabel.className = "sv-key-label";
    svKeyLabel.textContent = "Google Maps API key";
    const svKeyInput = document.createElement("input");
    svKeyInput.type = "password";
    svKeyInput.id = "sv-key-input";
    svKeyInput.placeholder = "AIza…";
    svKeyInput.autocomplete = "off";
    svKeyInput.spellcheck = false;
    const svKeyButtons = document.createElement("div");
    svKeyButtons.id = "sv-key-buttons";
    const svKeySave = document.createElement("button");
    svKeySave.type = "submit";
    svKeySave.id = "sv-key-save";
    svKeySave.textContent = "Save key";
    const svKeySkip = document.createElement("button");
    svKeySkip.type = "button";
    svKeySkip.id = "sv-key-skip";
    svKeySkip.className = "sv-link";
    svKeySkip.textContent = "Not now";
    svKeyButtons.append(svKeySave, svKeySkip);
    const svKeyNote = document.createElement("div");
    svKeyNote.className = "sv-key-note";
    svKeyNote.textContent =
      "Needs Maps JavaScript API + Street View Static API enabled. Kept in " +
      "this browser's localStorage only. Never committed, never sent anywhere " +
      "but maps.googleapis.com. Use a referrer-restricted key.";
    svKeyForm.append(svKeyLabel, svKeyInput, svKeyButtons, svKeyNote);

    // -- footer: the one line that says what the key situation is --
    const svFooter = document.createElement("div");
    svFooter.id = "street-view-footer";
    const svKeyStatus = document.createElement("span");
    svKeyStatus.id = "sv-key-status";
    const svKeyActions = document.createElement("span");
    svKeyActions.id = "sv-key-actions";
    const svKeySetBtn = document.createElement("button");
    svKeySetBtn.type = "button";
    svKeySetBtn.id = "sv-key-set";
    svKeySetBtn.className = "sv-link";
    const svKeyClearBtn = document.createElement("button");
    svKeyClearBtn.type = "button";
    svKeyClearBtn.id = "sv-key-clear";
    svKeyClearBtn.className = "sv-link";
    svKeyClearBtn.textContent = "Clear key";
    svKeyActions.append(svKeySetBtn, svKeyClearBtn);
    svFooter.append(svKeyStatus, svKeyActions);

    const svTab = document.createElement("button");
    svTab.id = "sv-tab";
    svTab.textContent = "◀";
    svTab.title = "Toggle Street View";

    svPanel.append(svHeader, svLocation, svStage, svTimelineRow, svKeyForm, svFooter);
    svPanel.appendChild(svTab);
    document.body.appendChild(svPanel);

    let svLat = null;
    let svLng = null;
    // Which of the stage's mutually exclusive states is up. The date badge and
    // the dates row belong to the picture, so they only ever show over "pano";
    // a late service callback must not paint them over an error message.
    let svStageState = "placeholder"; // "placeholder" | "checking" | "message" | "pano"

    function svPromptText() {
      return svKey
        ? "Click anywhere on the map to load Street View."
        : "Click anywhere on the map to load Street View.\n" +
          "Add a Google Maps API key below to enable it.";
    }

    // ── Panel states ─────────────────────────────────────────────────────
    //
    // Exactly one of these three is visible on the stage at a time: the
    // panorama, a message, or the "click the map" placeholder.

    function svShowPlaceholder() {
      svStageState = "placeholder";
      svPlaceholder.textContent = svPromptText();
      svPlaceholder.style.display = "flex";
      svNoImg.style.display = "none";
      svPanoDiv.style.visibility = "hidden";
      svDateBadge.style.display = "none";
      svTimelineRow.style.display = "none";
      if (svPano) svPano.setVisible(false);
      svClearMapLink();
    }

    function svShowMessage(text, offerKey) {
      svStageState = "message";
      svNoImgText.textContent = text;
      svNoImgKeyBtn.classList.toggle("hidden", !offerKey);
      svNoImg.style.display = "flex";
      svPlaceholder.style.display = "none";
      svPanoDiv.style.visibility = "hidden";
      svDateBadge.style.display = "none";
      svTimelineRow.style.display = "none";
      if (svPano) svPano.setVisible(false);
      svClearMapLink();
    }

    function svShowChecking() {
      svStageState = "checking";
      svPlaceholder.textContent = "Checking Street View…";
      svPlaceholder.style.display = "flex";
      svNoImg.style.display = "none";
      svPanoDiv.style.visibility = "hidden";
      svDateBadge.style.display = "none";
      svTimelineRow.style.display = "none";
    }

    function svShowPano() {
      svStageState = "pano";
      svPlaceholder.style.display = "none";
      svNoImg.style.display = "none";
      svPanoDiv.style.visibility = "visible";
      if (svPano) {
        svPano.setVisible(true);
        // The panel slides in, so the div had no size when Google measured it.
        requestAnimationFrame(() => google.maps.event.trigger(svPano, "resize"));
      }
    }

    // Everything that has to change when the key comes or goes.
    function svRefreshKeyUi() {
      if (svKey) {
        svKeyStatus.textContent =
          svKeySource === "config"
            ? "Maps API key from config.js."
            : "Maps API key saved in this browser.";
        svKeySetBtn.textContent = "Change key";
        svKeyClearBtn.classList.toggle("hidden", svKeySource !== "stored");
      } else {
        svKeyStatus.textContent = "No API key — Street View is unavailable.";
        svKeySetBtn.textContent = "Add key";
        svKeyClearBtn.classList.add("hidden");
      }
    }

    function svShowKeyForm() {
      svKeyAsked = true;
      svKeyForm.classList.remove("hidden");
      svKeyInput.focus();
    }

    function svHideKeyForm() {
      svKeyForm.classList.add("hidden");
      svKeyInput.value = "";
    }

    // ── Map ↔ panorama link ──────────────────────────────────────────────
    //
    // A pulsing dot where the camera is, and a wedge showing which way it is
    // facing. Both follow the panorama as the user walks down the road, and
    // the map keeps the dot centred, so the map is always a legend for the
    // picture. Both appear when the panel opens and go when it closes.
    //
    // The dot is an HTML element rather than a Graphic: ArcGIS symbols cannot
    // animate, and a CSS keyframe pulse is the repo's plainest way to get one.
    // It is positioned from view.toScreen() on every extent change, which
    // includes each frame of the recentre animation. The cone stays a Graphic
    // because it is a real geographic wedge and should scale with the zoom.

    const SV_CONE_SYMBOL = {
      type: "simple-fill",
      color: [26, 115, 232, 0.28],
      outline: { color: [26, 115, 232, 0.55], width: 1 }
    };

    const svPulse = document.createElement("div");
    svPulse.id = "sv-pulse";
    svPulse.style.display = "none";
    const svPulseRing = document.createElement("span");
    svPulseRing.className = "sv-pulse-ring";
    const svPulseDot = document.createElement("span");
    svPulseDot.className = "sv-pulse-dot";
    svPulse.append(svPulseRing, svPulseDot);
    view.container.appendChild(svPulse);

    let svConeGraphic = null;
    let svConePending = false;
    // The map point the dot is pinned to, in the view's own spatial reference.
    let svPinPoint = null;

    // Never fight the user: while a drag or a wheel-zoom is in flight the
    // panorama moves the dot but leaves the map where they put it.
    let svUserInteracting = false;
    let svInteractionTimer = null;
    // The panel takes 0.3s to slide. Measuring how much map it covers while it
    // is still moving gives the wrong answer, and a recentre fired on that
    // measurement then races the corrected one — the dot ends up somewhere
    // between the two. Only recentre once the panel has settled.
    let svPanelSliding = false;
    let svPanelSlideTimer = null;
    // One recentre animation at a time, for the same reason: a second goTo
    // launched mid-flight measures a position that is still moving.
    let svRecenterInFlight = false;
    let svRecenterWanted = false;

    function svPanelSlideDone() {
      if (svPanelSlideTimer) clearTimeout(svPanelSlideTimer);
      svPanelSlideTimer = null;
      svPanelSliding = false;
    }

    function svPanelSlideStart() {
      svPanelSliding = true;
      if (svPanelSlideTimer) clearTimeout(svPanelSlideTimer);
      // transitionend does not fire if the transition is disabled (reduced
      // motion, or a browser that skips it), so never wait on it forever.
      svPanelSlideTimer = setTimeout(() => {
        svPanelSlideDone();
        svPositionPulse();
        svRecenter();
      }, 500);
    }

    function svMarkInteraction(active) {
      if (svInteractionTimer) clearTimeout(svInteractionTimer);
      svUserInteracting = active;
      // The timer runs in both directions on purpose. Coming out of a drag it
      // is a grace period, so the inertia of a flick does not get yanked back.
      // Going in, it is a watchdog: a "drag" that starts and never ends would
      // otherwise leave the flag stuck and kill recentring for the session.
      svInteractionTimer = setTimeout(() => {
        svUserInteracting = false;
        svInteractionTimer = null;
      }, active ? 4000 : 600);
    }

    // Only a drag that actually moves counts. A plain map click still emits
    // "start" and "end", and treating "start" as interaction made every first
    // click skip its own recentre — the dot landed under the panel edge.
    view.on("drag", e => {
      if (e.action === "end") svMarkInteraction(false);
      else if (e.action === "update") svMarkInteraction(true);
    });
    view.on("mouse-wheel", () => {
      svMarkInteraction(true);
      svMarkInteraction(false);
    });

    // Keep the dot glued to its map point through pan, zoom and animation.
    // view.toScreen() declines to project while the view is still settling —
    // right after the panel opens, which is exactly when the dot is first
    // placed — so a refusal is retried on the next frame instead of leaving
    // the dot hidden until something else happens to move the map.
    let svPulseRetries = 0;
    function svPositionPulse() {
      if (!svPinPoint || !svPanel.classList.contains("open")) {
        svPulse.style.display = "none";
        svPulseRetries = 0;
        return;
      }
      let sp = null;
      try {
        sp = view.toScreen(svPinPoint);
      } catch (_) {
        sp = null;
      }
      if (!sp || typeof sp.x !== "number" || !isFinite(sp.x)) {
        svPulse.style.display = "none";
        if (svPulseRetries < 60) {
          svPulseRetries++;
          requestAnimationFrame(svPositionPulse);
        }
        return;
      }
      svPulseRetries = 0;
      svPulse.style.left = `${sp.x}px`;
      svPulse.style.top = `${sp.y}px`;
      svPulse.style.display = "block";
    }

    view.watch("extent", svPositionPulse);
    view.watch("rotation", svPositionPulse);

    // Centre the dot in the map the user can actually see — the panel covers
    // the right half of the window, so the true container centre would park
    // the dot underneath it.
    function svRecenter() {
      if (!svPinPoint || svUserInteracting || !svPanel.classList.contains("open")) return;
      if (svPanelSliding) return;
      if (svRecenterInFlight) {
        // Let the one in flight land, then correct from where it actually got.
        svRecenterWanted = true;
        return;
      }
      const rect = view.container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const panelRect = svPanel.getBoundingClientRect();
      const covered = Math.max(0, rect.right - panelRect.left);
      const desiredX = Math.max(40, (rect.width - covered) / 2);
      const desiredY = rect.height / 2;
      const sp = view.toScreen(svPinPoint);
      if (!sp) return;
      // Whatever map point sits this far from the dot must become the centre
      // for the dot to land on (desiredX, desiredY). Zoom is left alone —
      // recentring already brings an off-screen dot into view.
      const dx = rect.width / 2 - desiredX;
      const dy = rect.height / 2 - desiredY;
      const newCenter = view.toMap({ x: sp.x + dx, y: sp.y + dy });
      if (!newCenter) return;
      svRecenterInFlight = true;
      view.goTo({ center: newCenter }, { duration: 350, easing: "ease-out" }).then(
        () => {
          svRecenterInFlight = false;
          svPositionPulse();
          if (svRecenterWanted) {
            svRecenterWanted = false;
            svRecenter();
          }
        },
        () => {
          // goTo rejects when the user interrupts the animation. That is the
          // user winning, so drop the follow-up rather than yanking the map
          // back out from under them.
          svRecenterInFlight = false;
          svRecenterWanted = false;
        }
      );
    }

    // A wedge of `halfAngle` either side of `heading`, `radiusM` long, built
    // in plain lat/lng. Good enough at these radii; no projection needed.
    function svConeRing(lat, lng, heading, radiusM = 45, halfAngle = 26) {
      const mPerDegLat = 110540;
      const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180) || 1;
      const ring = [[lng, lat]];
      for (let a = -halfAngle; a <= halfAngle; a += 4) {
        const th = ((heading + a) * Math.PI) / 180;
        ring.push([
          lng + (Math.sin(th) * radiusM) / mPerDegLng,
          lat + (Math.cos(th) * radiusM) / mPerDegLat
        ]);
      }
      ring.push([lng, lat]);
      return ring;
    }

    function svClearMapLink() {
      svPinPoint = null;
      svPulse.style.display = "none";
      if (svConeGraphic) {
        view.graphics.remove(svConeGraphic);
        svConeGraphic = null;
      }
    }

    // `recenter` is true only when the panorama moved to a new place —
    // turning the camera should not drag the map around under it.
    function svDrawMapLink(lat, lng, heading, recenter) {
      // A real Point, not an autocast literal: Graphic will autocast its
      // geometry but view.toScreen() will not, and it fails the projection
      // with "mapview:projection-not-possible" rather than telling you why.
      svPinPoint = new Point({
        longitude: lng,
        latitude: lat,
        spatialReference: { wkid: 4326 }
      });
      const cone = {
        type: "polygon",
        rings: [svConeRing(lat, lng, heading)],
        spatialReference: { wkid: 4326 }
      };
      if (svConeGraphic) {
        svConeGraphic.geometry = cone;
      } else {
        svConeGraphic = new Graphic({ geometry: cone, symbol: SV_CONE_SYMBOL });
        view.graphics.add(svConeGraphic);
      }
      svPositionPulse();
      if (recenter) svRecenter();
    }

    // pov_changed fires on every frame of a drag; redraw at most once a frame.
    let svPendingRecenter = false;
    function svScheduleMapLink(recenter) {
      if (recenter) svPendingRecenter = true;
      if (svConePending || svLat === null || !svPano) return;
      svConePending = true;
      requestAnimationFrame(() => {
        svConePending = false;
        const wantRecenter = svPendingRecenter;
        svPendingRecenter = false;
        if (svLat === null || !svPano) return;
        const pov = svPano.getPov() || { heading: 0 };
        svDrawMapLink(svLat, svLng, pov.heading || 0, wantRecenter);
      });
    }

    // ── Loading the Maps JavaScript API ──────────────────────────────────
    //
    // Loaded on demand — no key, no request, and nothing from Google on a
    // page nobody opened the panel on. The API can only be bootstrapped once
    // per page load with one key, so changing the key needs a reload; the
    // footer says so rather than failing silently.

    let svApiPromise = null;
    let svApiLoadedKey = null;
    let svAuthFailed = false;

    // Google calls this global on any authentication failure — bad key, key
    // not authorised for this referrer, JS API not enabled, billing off. It
    // is the only signal the JS API gives; there is no per-call error.
    window.gm_authFailure = () => {
      svAuthFailed = true;
      svShowMessage(
        "Google rejected this API key for Street View. Check that the key has " +
        "the Maps JavaScript API enabled and that this site is in the key's " +
        "HTTP referrer allow-list.",
        true
      );
      svKeyStatus.textContent = "Maps API key was refused by Google.";
      // The Static metadata endpoint reports the same class of problem in
      // words, and for a referrer-restricted key it names the referer it saw
      // — the one fact that fixes it. Best effort, clearly attributed.
      svExplainAuthFailure();
    };

    function svLoadMapsApi(key) {
      if (svApiPromise) return svApiPromise;
      svApiLoadedKey = key;
      svApiPromise = new Promise((resolve, reject) => {
        if (window.google && window.google.maps && google.maps.StreetViewPanorama) {
          resolve();
          return;
        }
        const cb = "__nrpcMapsApiReady";
        window[cb] = () => {
          try { delete window[cb]; } catch (_) { window[cb] = undefined; }
          resolve();
        };
        const s = document.createElement("script");
        s.async = true;
        s.src =
          "https://maps.googleapis.com/maps/api/js?key=" +
          encodeURIComponent(key) +
          "&v=weekly&loading=async&callback=" + cb;
        s.onerror = () => {
          try { delete window[cb]; } catch (_) { window[cb] = undefined; }
          svApiPromise = null;
          svApiLoadedKey = null;
          reject(new Error("maps-js-load-failed"));
        };
        document.head.appendChild(s);
      });
      return svApiPromise;
    }

    // ── The panorama itself ──────────────────────────────────────────────

    let svPano = null;
    let svService = null;
    let svPanoToken = 0;

    function svEnsurePano() {
      if (svPano) return;
      svService = new google.maps.StreetViewService();
      svPano = new google.maps.StreetViewPanorama(svPanoDiv, {
        visible: false,
        // The two controls Bryan asked for by name.
        linksControl: true,   // the chevron arrows along the road
        clickToGo: true,      // click the road to walk to the next scene
        panControl: true,
        zoomControl: true,
        scrollwheel: true,
        showRoadLabels: true,
        // Chrome we do not want: the panel has its own header and close, the
        // date gets its own centred badge, and motion tracking is meaningless
        // on a desktop planning map.
        addressControl: false,
        fullscreenControl: false,
        enableCloseButton: false,
        imageDateControl: false,
        motionTracking: false,
        motionTrackingControl: false
      });

      // Walking to a new scene moves the dot and re-reads the date.
      svPano.addListener("position_changed", () => {
        const pos = svPano.getPosition();
        if (!pos) return;
        svLat = pos.lat();
        svLng = pos.lng();
        svLocation.textContent = `${svLat.toFixed(6)}, ${svLng.toFixed(6)}`;
        svScheduleMapLink(true);
      });

      // Turning the camera redraws the cone but must not move the map.
      svPano.addListener("pov_changed", () => svScheduleMapLink(false));

      svPano.addListener("pano_changed", () => {
        const id = svPano.getPano();
        if (id) svUpdateDateFor(id);
      });
    }

    // ── The imagery date, and the honest answer on a timeline ────────────
    //
    // `StreetViewPanoramaData.imageDate` is documented and gives "YYYY-MM".
    // It is not on the panorama object, so it comes from a StreetViewService
    // lookup of the pano id we are currently showing.
    //
    // A list of *other* capture dates is a different matter — see
    // docs/dev-notes.md. Google's own Maps UI has "See more dates"; no
    // documented developer API exposes it. Some builds of the JS API return
    // an undocumented `time` array on StreetViewPanoramaData; we feature-
    // detect it and render chips when it is there, and say plainly that
    // there are no other dates available when it is not. Nothing here breaks
    // if Google removes the field, and nothing here invents a date.

    function svFormatImageDate(raw) {
      // Documented as "YYYY-MM", but Google warns the granularity varies and
      // some panoramas come back as a bare "YYYY" — so parse defensively and
      // show whatever precision we were actually given.
      const t = String(raw || "").trim();
      const m = /^(\d{4})(?:-(\d{2}))?/.exec(t);
      if (!m) return t;
      if (!m[2]) return m[1];
      const months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      const mi = Number(m[2]) - 1;
      return months[mi] ? `${months[mi]} ${m[1]}` : m[1];
    }

    function svSetDateBadge(raw) {
      const text = svStageState === "pano" && raw ? svFormatImageDate(raw) : "";
      if (!text) {
        // Never a placeholder date. No date, no badge.
        svDateBadge.style.display = "none";
        svDateBadge.textContent = "";
        return;
      }
      svDateBadge.textContent = `Imagery: ${text}`;
      svDateBadge.style.display = "block";
    }

    // Undocumented, feature-detected. Returns [{pano, label}] or [].
    function svOtherDates(data) {
      const times = data && data.time;
      if (!Array.isArray(times) || !times.length) return [];
      const out = [];
      for (const t of times) {
        if (!t || typeof t !== "object") continue;
        // The id key and the date key have both been renamed by Google's
        // minifier over the years, so go looking rather than assuming.
        let pano = t.pano || t.panoId || null;
        let when = null;
        for (const [k, v] of Object.entries(t)) {
          if (!pano && typeof v === "string" && /^[A-Za-z0-9_-]{20,}$/.test(v)) pano = v;
          if (!when && v instanceof Date) when = v;
          if (!when && typeof v === "string" && /^\d{4}-\d{2}/.test(v)) when = v;
        }
        if (!pano) continue;
        const label = when instanceof Date
          ? svFormatImageDate(
              `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}`
            )
          : when ? svFormatImageDate(when) : "";
        out.push({ pano, label });
      }
      return out.filter(d => d.label);
    }

    function svRenderTimeline(data, currentPano) {
      const dates = svOtherDates(data);
      svTimelineChips.textContent = "";
      if (svStageState !== "pano") {
        // A service callback that outran an error or a close. The row belongs
        // to a picture that is not on screen.
        svTimelineRow.style.display = "none";
        return;
      }
      if (currentPano) {
        svMapsLink.href =
          "https://www.google.com/maps/@?api=1&map_action=pano&pano=" +
          encodeURIComponent(currentPano);
        svMapsLink.style.display = "inline";
      } else {
        svMapsLink.style.display = "none";
      }
      if (!dates.length) {
        // Say why there is nothing here, once, quietly.
        svTimelineNote.textContent = "not published by the Maps API —";
        svTimelineRow.title =
          "No Google API lists a location's other capture dates: " +
          "StreetViewPanoramaData carries one imageDate, and its links are " +
          "the adjacent panoramas of the same survey, not earlier ones. " +
          "\"See more dates\" is a Google Maps end-user feature with no " +
          "developer equivalent, so this panel shows the date of the imagery " +
          "you are looking at and hands the rest to Google Maps.";
        svTimelineRow.classList.add("sv-timeline-empty");
        svTimelineRow.style.display = "flex";
        return;
      }
      svTimelineNote.textContent = "";
      svTimelineRow.title = "";
      svTimelineRow.classList.remove("sv-timeline-empty");
      for (const d of dates) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "sv-date-chip";
        chip.textContent = d.label;
        if (d.pano === currentPano) chip.classList.add("current");
        chip.addEventListener("click", () => {
          if (svPano) svPano.setPano(d.pano);
        });
        svTimelineChips.appendChild(chip);
      }
      svTimelineRow.style.display = "flex";
    }

    function svUpdateDateFor(panoId) {
      if (!svService) return;
      svService.getPanorama({ pano: panoId }, (data, status) => {
        if (status !== google.maps.StreetViewStatus.OK || !data) {
          svSetDateBadge(null);
          svRenderTimeline(null, panoId);
          return;
        }
        svSetDateBadge(data.imageDate);
        svRenderTimeline(data, panoId);
      });
    }

    // ── Is there a photo here, or is the key the problem? ────────────────
    //
    // The free, CORS-enabled Street View Static metadata endpoint is kept for
    // one job only: turning an auth failure into words. The JS API's
    // gm_authFailure tells us *that* the key was refused but never *why*;
    // this endpoint answers in Google's own sentence, and on a referrer-
    // restricted key it names the referer it actually saw.
    const SV_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";

    async function svExplainAuthFailure() {
      if (!svKey || svLat === null) return;
      try {
        const url =
          `${SV_META_URL}?location=${svLat},${svLng}&radius=1000&source=outdoor` +
          `&key=${encodeURIComponent(svKey)}`;
        const res = await fetch(url);
        const meta = await res.json();
        const detail = String((meta && meta.error_message) || "").trim();
        if (!detail) return;
        svNoImgText.textContent =
          svNoImgText.textContent + "\n\nGoogle says: " + detail;
      } catch (_) {
        // Offline or blocked. The generic message already told the story.
      }
    }

    // ── Opening a location ───────────────────────────────────────────────

    async function svGoTo(lat, lng) {
      const token = ++svPanoToken;
      svShowChecking();

      try {
        await svLoadMapsApi(svKey);
      } catch (_) {
        if (token !== svPanoToken) return;
        svShowMessage(
          "Could not load the Google Maps JavaScript API — check the network " +
          "connection and that the key's project has that API enabled.",
          true
        );
        return;
      }
      if (token !== svPanoToken) return;
      if (svAuthFailed) return; // gm_authFailure has put its own message up.

      svEnsurePano();

      svService.getPanorama(
        {
          location: { lat, lng },
          radius: 1000,
          source: google.maps.StreetViewSource.OUTDOOR,
          preference: google.maps.StreetViewPreference.NEAREST
        },
        (data, status) => {
          if (token !== svPanoToken) return;
          if (status === google.maps.StreetViewStatus.OK && data && data.location) {
            svPano.setPano(data.location.pano);
            svPano.setPov({ heading: svHeadingTowards(data.location.latLng, lat, lng), pitch: 0 });
            svShowPano();
            svSetDateBadge(data.imageDate);
            svRenderTimeline(data, data.location.pano);
            const p = data.location.latLng;
            svLat = p.lat();
            svLng = p.lng();
            svLocation.textContent = `${svLat.toFixed(6)}, ${svLng.toFixed(6)}`;
            svScheduleMapLink(true);
            return;
          }
          if (status === google.maps.StreetViewStatus.ZERO_RESULTS) {
            svShowMessage("No Street View imagery available near this location.", false);
            return;
          }
          // UNKNOWN_ERROR — a server-side problem, not a coverage gap.
          svShowMessage(
            "Street View could not be loaded (Google returned " + status + ").",
            false
          );
        }
      );
    }

    // Face the camera at the spot the user actually clicked, rather than at
    // whatever bearing the last panorama happened to be left on.
    function svHeadingTowards(fromLatLng, toLat, toLng) {
      const lat1 = (fromLatLng.lat() * Math.PI) / 180;
      const lat2 = (toLat * Math.PI) / 180;
      const dLng = ((toLng - fromLatLng.lng()) * Math.PI) / 180;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      const brng = (Math.atan2(y, x) * 180) / Math.PI;
      return (brng + 360) % 360;
    }

    // The panel slides in over 0.3s. Anything that measures it — the panorama
    // sizing itself, and the recentre working out how much map the panel is
    // covering — has to wait for the slide to finish or it measures a panel
    // that is still off-screen and puts the dot underneath it.
    svPanel.addEventListener("transitionend", e => {
      if (e.propertyName !== "transform" || e.target !== svPanel) return;
      svPanelSlideDone();
      if (svPano && svPanel.classList.contains("open")) {
        google.maps.event.trigger(svPano, "resize");
      }
      svPositionPulse();
      svRecenter();
    });

    function openPanel() {
      const wasOpen = svPanel.classList.contains("open");
      svPanel.classList.add("open");
      svTab.textContent = "▶";
      // Only a real state change slides; re-opening an open panel must not
      // arm a transition that will never end.
      if (!wasOpen) svPanelSlideStart();
      if (svPano) {
        requestAnimationFrame(() => google.maps.event.trigger(svPano, "resize"));
      }
    }

    function closePanel() {
      if (svPanel.classList.contains("open")) svPanelSlideStart();
      svPanel.classList.remove("open");
      svTab.textContent = "◀";
      // The dot belongs to the open panel; it goes when the panel goes.
      svClearMapLink();
    }

    function openStreetView(lat, lng) {
      svLat = lat;
      svLng = lng;
      svLocation.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      if (svKey) {
        svGoTo(lat, lng);
      } else {
        svShowMessage(
          "Street View needs a Google Maps API key. The map's aerial basemap " +
          "is available underneath without one.",
          false
        );
        // The one ask: first Street View request of the session with no key.
        if (!svKeyAsked && !svKeyDeclined) svShowKeyForm();
      }
      openPanel();
    }

    // Re-render whatever is on screen under the key we now have.
    function svRerender() {
      svRefreshKeyUi();
      if (!svKey) {
        svClearMapLink();
        if (svLat === null) svShowPlaceholder();
        else svShowMessage("Street View needs a Google Maps API key.", false);
        return;
      }
      // The Maps JS API bootstraps once per page load and keeps the key it
      // was given; a different key cannot be swapped in underneath it.
      if (svApiLoadedKey && svApiLoadedKey !== svKey) {
        svShowMessage(
          "Key saved. Reload the page to use it — the Google Maps API can only " +
          "be loaded once per page.",
          false
        );
        svKeyStatus.textContent = "New key saved — reload the page to use it.";
        return;
      }
      svAuthFailed = false;
      if (svLat === null) svShowPlaceholder();
      else svGoTo(svLat, svLng);
    }

    svKeyForm.addEventListener("submit", e => {
      e.preventDefault();
      const k = svKeyInput.value.trim();
      if (!k) return;
      try {
        localStorage.setItem(SV_STORAGE_KEY, k);
      } catch (_) {
        // Private mode — the key just won't outlive the page.
      }
      svKey = k;
      svKeySource = "stored";
      svKeyDeclined = false;
      svHideKeyForm();
      svRerender();
    });

    svKeySkip.addEventListener("click", () => {
      svKeyDeclined = true;
      svHideKeyForm();
      svRerender();
    });

    svNoImgKeyBtn.addEventListener("click", () => svShowKeyForm());

    svKeySetBtn.addEventListener("click", () => {
      if (svKeyForm.classList.contains("hidden")) svShowKeyForm();
      else svHideKeyForm();
    });

    svKeyClearBtn.addEventListener("click", () => {
      try {
        localStorage.removeItem(SV_STORAGE_KEY);
      } catch (_) {}
      svResolveKey();
      svHideKeyForm();
      svRerender();
      if (!svKey) svKeyStatus.textContent = "Key cleared — Street View is unavailable.";
    });

    svClose.addEventListener("click", closePanel);

    svTab.addEventListener("click", () => {
      if (svPanel.classList.contains("open")) {
        closePanel();
      } else {
        if (svLat === null) svShowPlaceholder();
        openPanel();
      }
    });

    svRefreshKeyUi();
    svShowPlaceholder();

    view.on("click", async (event) => {
      const response = await view.hitTest(event);
      const pointResult = response.results.find(
        r => r.type === "graphic" && r.graphic.geometry && r.graphic.geometry.type === "point"
      );
      // Prefer a clicked point feature; fall back to the raw map point so the
      // panel is reachable even when no point layer is switched on.
      const pt = pointResult ? pointResult.graphic.geometry : event.mapPoint;
      if (pt && typeof pt.latitude === "number" && typeof pt.longitude === "number") {
        openStreetView(pt.latitude, pt.longitude);
      }
    });

  });
});

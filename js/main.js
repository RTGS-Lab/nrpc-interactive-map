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
], (WebMap, MapView, Home, LayerList, Legend, Editor, GraphicsLayer, Graphic, Basemap) => {

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
  });
});

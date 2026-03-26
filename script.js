require([
  "esri/WebMap",
  "esri/views/MapView",
  "esri/widgets/Home",
  "esri/widgets/LayerList",
  "esri/widgets/Legend",
], (WebMap, MapView, Home, LayerList, Legend) => {

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

    // City zoom dropdown
    const citySelect = document.createElement("select");
    citySelect.id = "city-select";
    citySelect.innerHTML = '<option value="">Zoom to city...</option>';
    toggleBar.appendChild(citySelect);

    view.ui.add(toggleBar, { position: "top-left", index: 0 });

    // Panel stack container
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
    new LayerList({ view, container: layerListContainer });

    layerSearch.addEventListener("input", () => {
      const term = layerSearch.value.toLowerCase();
      layerSearchClear.classList.toggle("hidden", !term);

      // Try calcite-list-item (ArcGIS 4.29+)
      const calciteItems = layerListContainer.querySelectorAll("calcite-list-item");
      if (calciteItems.length > 0) {
        calciteItems.forEach(item => {
          // label may be a JS property, an attribute, or in text content
          const label = (item.label || item.getAttribute("label") || item.textContent || "").toLowerCase();
          item.style.display = !term || label.includes(term) ? "" : "none";
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

    // Populate city dropdown and handle zoom
    const citiesLayer = view.map.allLayers.find(l => l.title && l.title.toLowerCase().includes("cities"));
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
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          citySelect.appendChild(opt);
        });
      });

      citySelect.addEventListener("change", () => {
        const selected = citySelect.value;
        if (!selected) return;

        const q = citiesLayer.createQuery();
        q.where = `CTU_NAME = '${selected.replace(/'/g, "''")}'`;
        q.returnGeometry = true;
        q.outSpatialReference = view.spatialReference;

        citiesLayer.queryFeatures(q).then(result => {
          if (!result.features.length) return;
          let extent = result.features[0].geometry.extent;
          for (let i = 1; i < result.features.length; i++) {
            extent = extent.union(result.features[i].geometry.extent);
          }
          view.goTo(extent.expand(1.5));
        });
      });
    }

    // Toggle handlers
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

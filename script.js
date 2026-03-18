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
    legendToggle.className = "panel-toggle";
    legendToggle.textContent = "Legend";
    toggleBar.appendChild(legendToggle);

    const layersToggle = document.createElement("button");
    layersToggle.id = "layers-toggle";
    layersToggle.className = "panel-toggle";
    layersToggle.textContent = "Layers";
    toggleBar.appendChild(layersToggle);

    view.ui.add(toggleBar, { position: "top-left", index: 0 });

    // Panel stack container
    const panelsContainer = document.createElement("div");
    panelsContainer.id = "panels-container";
    document.body.appendChild(panelsContainer);

    // Legend panel (hidden by default)
    const legendContainer = document.createElement("div");
    legendContainer.id = "legend-container";
    legendContainer.classList.add("panel", "hidden");
    panelsContainer.appendChild(legendContainer);
    new Legend({ view, container: legendContainer });

    // Layer list panel (hidden by default)
    const layerListWrapper = document.createElement("div");
    layerListWrapper.id = "layer-list-wrapper";
    layerListWrapper.classList.add("panel", "hidden");
    panelsContainer.appendChild(layerListWrapper);

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

    // Toggle handlers
    legendToggle.addEventListener("click", () => {
      legendContainer.classList.toggle("hidden");
    });
    layersToggle.addEventListener("click", () => {
      layerListWrapper.classList.toggle("hidden");
    });
  });
});

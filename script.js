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
    // Legend
    const legendContainer = document.createElement("div");
    legendContainer.id = "legend-container";
    document.body.appendChild(legendContainer);

    const legend = new Legend({
      view: view,
      container: legendContainer
    });

    view.ui.add(legendContainer, {
      position: "top-left",
      index: 1
    });

    // Layer List (provides layer toggling)
    const layerList = new LayerList({
      view: view
    });

    view.ui.add(layerList, {
      position: "bottom-left"
    });
  });

  // Home button
  const home = new Home({
    view: view
  });

  const homeContainer = document.createElement("div");
  homeContainer.className = "home-container";
  document.body.appendChild(homeContainer);

  home.container = homeContainer;
  view.ui.add(homeContainer, "manual");
});

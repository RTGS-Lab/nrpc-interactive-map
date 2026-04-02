// ── GeoJSON builder + export utilities ──────────────────────────────────────
// Pure JS — no ArcGIS dependency. Exposed as globals for use in main.js.

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

function safeName(str) {
  return (str || "layer").replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 40);
}

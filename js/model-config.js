// Which Parcel Prioritization Model results the parcel report and its maps read.
//
// One place to change, so the V2 swap is one edit instead of two hard-coded
// URLs (js/parcel-report.js MODEL_PARCEL and js/report-maps.js MODEL_PARCEL,
// both v1 FeatureServer/97 until 2026-11-04). Loaded before both files.
//
// V2 is NOT published yet (2026-11-04: the UMN org lists only the two v1
// services). When it is, set `version`, `label`, `parcelUrl` and `serviceName`
// below. Check first that the V2 layer keeps the v1 field names the report
// reads -- PID (the join) and SCORE_FIELDS in js/parcel-report.js: Overall_Va,
// Spatial_Co, Habitat_Qu, Size, Wildlife_P, Risk_of_Co, Water_Res -- and that it
// publishes a classBreaks renderer on Overall_Va: report-maps.js copies those
// breaks for the report plates.
window.NRPC_MODEL = {
  version: "v1",
  label: "Hennepin County Parcel Prioritization Model results (parcel detail), v1",
  // County-wide view: the web map's "County Wide View" layer (not read by the report).
  countyUrl:
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Hennepin_Suitability_Model_Results_PublicView/FeatureServer/96",
  // Parcel view: what the report joins on PID for the scores and the rank.
  parcelUrl:
    "https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Hennepin_Suitability_Model_Results_parcel_detail/FeatureServer/97",
  // Printed in the exported report's sources line.
  serviceName: "Hennepin_Suitability_Model_Results_parcel_detail/97",
};

#!/usr/bin/env bash
# Builds the map data from Census 2020 ZCTA cartographic boundaries:
#   data/zcta.pmtiles    vector tiles (layers: "zcta" polygons, "zcta_pt" label points, "states" outlines)
#   data/zcta-index.json [zip, lon, lat, state] for every ZCTA (lookup, lasso, zoom-to)
# Requires: curl, unzip, tippecanoe (brew install tippecanoe), node deps (npm install)
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=raw
TMP=raw/tmp
mkdir -p "$RAW" "$TMP" data
MS=node_modules/.bin/mapshaper

fetch() {
  local name=$1
  if [ ! -f "$RAW/$name.shp" ]; then
    curl -fSL -o "$RAW/$name.zip" "https://www2.census.gov/geo/tiger/GENZ2020/shp/$name.zip"
    (cd "$RAW" && unzip -o -q "$name.zip")
  fi
}
fetch cb_2020_us_zcta520_500k
fetch cb_2020_us_state_20m
fetch cb_2020_us_state_500k

echo "-> polygons"
$MS -i "$RAW/cb_2020_us_zcta520_500k.shp" \
  -rename-fields z=ZCTA5CE20 -filter-fields z \
  -proj wgs84 \
  -o format=geojson ndjson precision=0.00001 "$TMP/zcta.geojsonl" force

echo "-> state outlines"
$MS -i "$RAW/cb_2020_us_state_500k.shp" -filter-fields STUSPS -rename-fields s=STUSPS \
  -proj wgs84 -o format=geojson ndjson precision=0.00001 "$TMP/states.geojsonl" force

echo "-> label points + state"
$MS -i "$RAW/cb_2020_us_zcta520_500k.shp" \
  -rename-fields z=ZCTA5CE20 -filter-fields z \
  -points inner \
  -proj wgs84 \
  -join "$RAW/cb_2020_us_state_20m.shp" fields=STUSPS \
  -rename-fields s=STUSPS \
  -o format=geojson ndjson precision=0.0001 "$TMP/zcta_pt.geojsonl" force

echo "-> index json"
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => {
  const f = JSON.parse(l), [x, y] = f.geometry.coordinates;
  return [f.properties.z, +x.toFixed(4), +y.toFixed(4), f.properties.s || ""];
}).sort((a, b) => a[0].localeCompare(b[0]));
fs.writeFileSync(process.argv[2], JSON.stringify(rows));
console.log(rows.length, "ZCTAs,", rows.filter(r => !r[3]).length, "without state");
' "$TMP/zcta_pt.geojsonl" data/zcta-index.json

echo "-> tiles"
tippecanoe -q -o data/zcta.pmtiles --force \
  -Z3 -z10 \
  --detect-shared-borders \
  --simplification=6 \
  --no-feature-limit --no-tile-size-limit \
  --no-tiny-polygon-reduction-at-maximum-zoom \
  -L zcta:"$TMP/zcta.geojsonl" \
  -L zcta_pt:"$TMP/zcta_pt.geojsonl" \
  -L states:"$TMP/states.geojsonl"

ls -lh data

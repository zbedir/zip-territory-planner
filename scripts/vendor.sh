#!/usr/bin/env bash
# Copies browser builds of the JS libraries into vendor/ so the app has no CDN dependency.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor
cp node_modules/maplibre-gl/dist/maplibre-gl.js node_modules/maplibre-gl/dist/maplibre-gl.css vendor/
cp node_modules/pmtiles/dist/pmtiles.js vendor/
cp node_modules/jspdf/dist/jspdf.umd.min.js vendor/
cp node_modules/papaparse/papaparse.min.js vendor/
ls -lh vendor

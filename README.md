# ZIP Territory Planner

A lightweight, static web app for planning marketing territories by ZIP code and exporting presentation-ready PDF maps.

**Live app:** https://zbedir.github.io/zip-territory-planner/

## Run

```bash
npm install          # first time only
npm start            # http://localhost:8080
```

`npm start` uses `serve`, which supports HTTP range requests. The map tiles need them, so `python -m http.server` will **not** work.

## Use

- **Territories:** add, rename, recolor, delete. Click a row to make it the *active* territory.
- **Click tool (C):** click a ZIP to add it to the active territory; click again to remove it.
- **Lasso tool (L):** drag around an area. ZIPs whose center falls inside are added.
- **Erase (E or hold Alt):** click or lasso removes ZIPs instead. **Undo:** ⌘Z / Ctrl+Z.
- **Paste box:** `10001 10002`, ranges `10001-10099`, prefixes `100*`, ZIP+4 and Excel-stripped zeros (`2134` → `02134`).
- **CSV import:** a `zip` column plus optional `territory` and `color` columns. Header names are flexible (zip code, postal code, region, rep…), and so is the delimiter. Headerless files are detected.
- **CSV export:** `zip,territory,color,state,on_map`. Re-import it to restore a plan.
- **Export PDF:** open the panel and frame the map inside the dashed box.
  - **Territories:** *All on one map*, *Active territory only*, or *Each territory on its own page* (each page auto-zooms to its territory; all pages share one layout). Other territories are hidden on single-territory maps unless you tick *Show other territories*.
  - **Legend shows:** *Territory names* (with counts) or *ZIP codes* (each territory's ZIPs listed under its color). The ZIP legend widens to fit. If a list is still too long, it ends with "+N more" and a full ZIP list page is added.
  - Type `{territory}` in the title or subtitle to insert the territory name.
  - Also: page size, orientation, legend position (right, bottom, or none), quality, and optional ZIP-list pages.
- Your work autosaves in the browser (localStorage). Export CSV to keep a durable copy or share it.

## Data

- ZIP polygons are U.S. Census Bureau **2020 ZCTA5** cartographic boundaries (1:500k), all ~33.8k areas.
- ZCTAs approximate USPS ZIP areas. PO Box-only and single-business ZIPs have no polygon. They are kept in your data, marked `*` in the app and PDF, and `on_map=no` in CSV.
- Basemap: OpenFreeMap (OpenStreetMap data), no API key needed. Choose "None" in Map display for a clean states-only background.

Rebuild the data (requires `brew install tippecanoe`):

```bash
npm run build-data   # downloads Census files to raw/, writes data/zcta.pmtiles + data/zcta-index.json
npm run vendor       # refreshes vendor/ JS libraries from node_modules
```

## Files

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | the app (no build step) |
| `data/zcta.pmtiles` | vector tiles: `zcta` polygons, `zcta_pt` label points, `states` outlines (z3–z10) |
| `data/zcta-index.json` | `[zip, lon, lat, state]` for lookup, lasso, and zoom |
| `vendor/` | MapLibre GL, PMTiles, PapaParse, jsPDF |
| `sample/territories-sample.csv` | NYC-area example |

## Hosting

Everything is static. Copy `index.html`, `style.css`, `app.js`, `data/`, `vendor/`, and `sample/` to any static host with range-request support (GitHub Pages, Cloudflare Pages, Netlify, S3). At ~37 MB, `zcta.pmtiles` is under GitHub's 100 MB file limit.

'use strict';

(() => {
  // ---------------------------------------------------------------- config
  const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#59a14f', '#b07aa1', '#edc948', '#76b7b2',
    '#ff9da7', '#9c755f', '#1f77b4', '#d62728', '#17becf', '#bcbd22', '#8c564b', '#7f7f7f'];
  const STORE_KEY = 'zip-territory-planner:v1';
  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const BASEMAPS = {
    light: 'https://tiles.openfreemap.org/styles/positron',
    streets: 'https://tiles.openfreemap.org/styles/liberty',
    blank: {
      version: 8,
      glyphs: GLYPHS,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f6f6f3' } }],
    },
  };
  const TILES_URL = new URL('data/zcta.pmtiles', location.href).href;
  const SRC = 'zcta';
  const SRC_LAYER = 'zcta';
  const ATTRIBUTION = 'ZIP areas: U.S. Census Bureau 2020 ZCTA';

  const PAGE_SIZES = { letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], a4: [595.28, 841.89], a3: [841.89, 1190.55] };

  // ---------------------------------------------------------------- state
  const state = {
    territories: [],          // [{ id, name, color }]
    assign: new Map(),        // zip -> territory id
    activeId: null,
    mode: 'click',            // view | click | lasso
    erase: false,
  };
  const index = new Map();    // zip -> [lon, lat, state]
  const undoStack = [];
  let map;
  let hoverId = null;
  let paintFilter = null;     // Set of territory ids to draw (PDF preview/export), or null for all

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => n.toLocaleString('en-US');

  // ---------------------------------------------------------------- helpers
  function normZip(value) {
    let s = String(value ?? '').trim().replace(/^="?|"$/g, '').replace(/\.0+$/, '').replace(/-\d{4}$/, '');
    if (!/^\d+$/.test(s)) return null;
    if (s.length === 9) s = s.slice(0, 5);
    if (s.length === 3 || s.length === 4) s = s.padStart(5, '0');
    return s.length === 5 ? s : null;
  }

  function parseZipText(text) {
    const zips = new Set();
    const invalid = [];
    for (let tok of text.split(/[\s,;|]+/)) {
      tok = tok.replace(/^["']|["']$/g, '');
      if (!tok) continue;
      let m;
      if ((m = tok.match(/^(\d{1,5})\*$/))) {
        let n = 0;
        for (const z of index.keys()) if (z.startsWith(m[1])) { zips.add(z); n++; }
        if (!n) invalid.push(tok);
      } else if ((m = tok.match(/^(\d{5})-(\d{5})$/))) {
        const [a, b] = m[1] < m[2] ? [m[1], m[2]] : [m[2], m[1]];
        let n = 0;
        for (const z of index.keys()) if (z >= a && z <= b) { zips.add(z); n++; }
        if (!n) invalid.push(tok);
      } else {
        const z = normZip(tok);
        z ? zips.add(z) : invalid.push(tok);
      }
    }
    return { zips: [...zips], invalid };
  }

  const uid = () => Math.random().toString(36).slice(2, 9);
  const territory = (id) => state.territories.find((t) => t.id === id);

  function nextColor() {
    const used = new Set(state.territories.map((t) => t.color.toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) ?? PALETTE[state.territories.length % PALETTE.length];
  }

  function addTerritory(name, color) {
    const t = {
      id: uid(),
      name: name || `Territory ${state.territories.length + 1}`,
      color: /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : nextColor(),
    };
    state.territories.push(t);
    return t;
  }

  function activeTerritory() {
    let t = territory(state.activeId);
    if (!t) {
      t = state.territories[0] ?? addTerritory();
      state.activeId = t.id;
      renderAll();
    }
    return t;
  }

  function counts() {
    const c = new Map(state.territories.map((t) => [t.id, { all: 0, unmapped: 0 }]));
    for (const [zip, tid] of state.assign) {
      const e = c.get(tid);
      if (!e) continue;
      e.all++;
      if (!index.has(zip)) e.unmapped++;
    }
    return c;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  let toastTimer;
  function toast(text, ms = 2600) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- persistence
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          territories: state.territories,
          assign: [...state.assign],
          activeId: state.activeId,
        }));
      } catch { /* storage unavailable: work continues in memory */ }
    }, 250);
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved?.territories) {
        state.territories = saved.territories;
        state.assign = new Map(saved.assign);
        state.activeId = saved.activeId;
      }
    } catch { /* ignore */ }
    if (!state.territories.length) state.activeId = addTerritory().id;
  }

  // ---------------------------------------------------------------- assignments
  function paint(zip) {
    if (!map?.getSource(SRC) || !index.has(zip)) return;
    const tid = state.assign.get(zip);
    const t = paintFilter && !paintFilter.has(tid) ? null : territory(tid);
    const target = { source: SRC, sourceLayer: SRC_LAYER, id: zip };
    if (t) map.setFeatureState(target, { c: t.color });
    else map.removeFeatureState(target, 'c');
  }

  function repaintAll() {
    if (!map?.getSource(SRC)) return;
    map.removeFeatureState({ source: SRC, sourceLayer: SRC_LAYER });
    for (const zip of state.assign.keys()) paint(zip);
  }

  /** Apply [zip, territoryId|null] changes as one undoable step. Returns number changed. */
  function applyChanges(changes, { record = true } = {}) {
    const undo = [];
    for (const [zip, tid] of changes) {
      const prev = state.assign.get(zip) ?? null;
      if (prev === tid) continue;
      undo.push([zip, prev]);
      if (tid) state.assign.set(zip, tid);
      else state.assign.delete(zip);
      paint(zip);
    }
    if (record && undo.length) {
      undoStack.push(undo);
      if (undoStack.length > 100) undoStack.shift();
    }
    if (undo.length) { renderAll(); save(); }
    return undo.length;
  }

  function undo() {
    const step = undoStack.pop();
    if (!step) return;
    applyChanges(step.reverse(), { record: false });
    toast(`Undid ${fmt(step.length)} ZIP change${step.length === 1 ? '' : 's'}`);
    renderAll();
  }

  /** Changes to put `zips` into territory `tid`, honouring the "protect" option. */
  function assignChanges(zips, tid) {
    const protect = $('#protect').checked;
    return zips
      .filter((z) => !(protect && state.assign.has(z) && state.assign.get(z) !== tid))
      .map((z) => [z, tid]);
  }

  // ---------------------------------------------------------------- UI rendering
  function renderAll() {
    renderTerritories();
    renderLegend();
    renderStats();
    $('#undo').disabled = !undoStack.length;
    document.querySelectorAll('.active-name').forEach((n) => {
      n.textContent = territory(state.activeId)?.name ?? 'territory';
    });
    if (!$('#frame').hidden) updateFrame();
  }

  function renderStats() {
    const used = new Set(state.assign.values()).size;
    $('#stats').textContent = `${fmt(state.assign.size)} ZIPs · ${used} of ${state.territories.length} territories in use`;
  }

  function renderTerritories() {
    const list = $('#terr-list');
    const c = counts();
    const focused = document.activeElement?.closest?.('.terr')?.dataset.id;
    list.replaceChildren(...state.territories.map((t) => {
      const row = document.createElement('div');
      row.className = 'terr' + (t.id === state.activeId ? ' active' : '');
      row.dataset.id = t.id;
      const n = c.get(t.id);
      row.innerHTML = `
        <input type="color" aria-label="Color">
        <input class="name" type="text" aria-label="Territory name">
        <span class="count" title="${n.unmapped ? `${n.unmapped} without map area` : ''}">${fmt(n.all)}${n.unmapped ? '*' : ''}</span>
        <button type="button" class="zoom" title="Zoom to territory">⤢</button>
        <button type="button" class="del" title="Delete territory">✕</button>`;
      row.querySelector('input[type=color]').value = t.color;
      row.querySelector('.name').value = t.name;
      return row;
    }));
    if (focused) list.querySelector(`[data-id="${focused}"] .name`)?.focus();
  }

  function renderLegend() {
    const box = $('#legend');
    const c = counts();
    const items = state.territories.filter((t) => c.get(t.id).all);
    // Hidden while framing a PDF: the PDF draws its own legend.
    box.hidden = !$('#show-legend').checked || !items.length || !$('#frame').hidden;
    box.replaceChildren(...items.map((t) => {
      const li = document.createElement('div');
      li.className = 'li';
      li.innerHTML = '<span class="sw"></span><span class="nm"></span><span class="n"></span>';
      li.querySelector('.sw').style.background = t.color;
      li.querySelector('.nm').textContent = t.name;
      li.querySelector('.n').textContent = fmt(c.get(t.id).all);
      return li;
    }));
  }

  /** Switch the active territory without rebuilding the list (keeps color pickers open). */
  function setActive(id) {
    state.activeId = id;
    document.querySelectorAll('.terr').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
    document.querySelectorAll('.active-name').forEach((n) => { n.textContent = territory(id)?.name ?? 'territory'; });
    if (!$('#frame').hidden) updateFrame();
    save();
  }

  const MODE_HINTS = {
    view: 'Pan and hover only. Nothing changes when you click.',
    click: 'Click a ZIP to add it to the active territory. Click it again to remove it. Hold Alt to erase.',
    lasso: 'Drag around ZIPs to add them. A ZIP is picked when its center is inside. Scroll to zoom.',
  };

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('#mode-hint').textContent = MODE_HINTS[mode];
    $('#map-wrap').classList.toggle('mode-lasso', mode === 'lasso');
    if (!map) return;
    if (mode === 'lasso') { map.dragPan.disable(); map.boxZoom.disable(); }
    else { map.dragPan.enable(); map.boxZoom.enable(); }
  }

  // ---------------------------------------------------------------- map
  function firstLayer(ids) {
    return ids.find((id) => map.getLayer(id));
  }

  function fillOpacity() {
    const o = +$('#opacity').value;
    return ['case',
      ['all', ['to-boolean', ['feature-state', 'c']], ['boolean', ['feature-state', 'h'], false]], Math.min(1, o + 0.15),
      ['to-boolean', ['feature-state', 'c']], o,
      ['boolean', ['feature-state', 'h'], false], 0.15,
      0];
  }

  function addLayers() {
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: 'vector', url: `pmtiles://${TILES_URL}`, promoteId: { [SRC_LAYER]: 'z' }, attribution: ATTRIBUTION });

    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const beforeFill = firstLayer(['boundary_3', 'boundary_2']) ?? firstSymbol;
    const beforeLines = firstLayer(['boundary_3', 'boundary_2']) ?? firstSymbol;
    const blank = $('#basemap').value === 'blank';

    map.addLayer({
      id: 'zcta-fill', type: 'fill', source: SRC, 'source-layer': SRC_LAYER,
      paint: { 'fill-color': ['coalesce', ['feature-state', 'c'], '#5b6475'], 'fill-opacity': fillOpacity() },
    }, beforeFill);
    map.addLayer({
      id: 'zcta-line', type: 'line', source: SRC, 'source-layer': SRC_LAYER, minzoom: 5,
      layout: { visibility: $('#show-borders').checked ? 'visible' : 'none' },
      paint: {
        'line-color': '#4a4a46',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.1, 8, 0.3, 11, 0.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.2, 10, 0.7, 14, 1.2],
      },
    }, beforeLines);
    map.addLayer({
      id: 'zcta-assigned-line', type: 'line', source: SRC, 'source-layer': SRC_LAYER,
      paint: {
        'line-color': ['coalesce', ['feature-state', 'c'], '#000'],
        'line-opacity': ['case', ['to-boolean', ['feature-state', 'c']], 0.95, 0],
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.2, 8, 0.6, 12, 1.4],
      },
    }, beforeLines);
    map.addLayer({
      id: 'states-line', type: 'line', source: SRC, 'source-layer': 'states',
      layout: { visibility: blank ? 'visible' : 'none' },
      paint: { 'line-color': '#55554f', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.4] },
    }, beforeLines);
    map.addLayer({
      id: 'zcta-hover', type: 'line', source: SRC, 'source-layer': SRC_LAYER,
      paint: {
        'line-color': '#111',
        'line-width': 2,
        'line-opacity': ['case', ['boolean', ['feature-state', 'h'], false], 1, 0],
      },
    });
    map.addLayer({
      id: 'zcta-label', type: 'symbol', source: SRC, 'source-layer': 'zcta_pt', minzoom: 9,
      layout: {
        visibility: $('#show-labels').checked ? 'visible' : 'none',
        'text-field': ['get', 'z'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 13],
        'text-padding': 3,
      },
      paint: { 'text-color': '#2b2b28', 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.3 },
    });
  }

  function setHover(id) {
    if (hoverId === id) return;
    const t = (zip) => ({ source: SRC, sourceLayer: SRC_LAYER, id: zip });
    if (hoverId != null && map.getSource(SRC)) map.setFeatureState(t(hoverId), { h: false });
    hoverId = id;
    if (id != null && map.getSource(SRC)) map.setFeatureState(t(id), { h: true });
  }

  function showTip(point, zip) {
    const tip = $('#tip');
    const t = territory(state.assign.get(zip));
    const st = index.get(zip)?.[2];
    tip.innerHTML = `<b>${zip}</b>${st ? ` · ${st}` : ''}<br>`;
    tip.append(t ? t.name : 'Unassigned');
    tip.hidden = false;
    const wrap = $('#map-wrap');
    const x = Math.min(point.x + 14, wrap.clientWidth - tip.offsetWidth - 6);
    const y = Math.min(point.y + 14, wrap.clientHeight - tip.offsetHeight - 6);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function hideTip() { $('#tip').hidden = true; }

  /** Bounds of the ZIPs' center points, or null when none are on the map. */
  function zipBounds(zips) {
    let w = 180, s = 90, e = -180, n = -90, any = false;
    for (const z of zips) {
      const p = index.get(z);
      if (!p) continue;
      any = true;
      w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]);
    }
    return any ? [[w, s], [e, n]] : null;
  }

  /** Map padding that keeps fitted content inside the PDF frame. */
  function framePadding(r) {
    const wrap = $('#map-wrap');
    return { top: r.y + 45, left: r.x + 45, right: wrap.clientWidth - r.x - r.w + 45, bottom: wrap.clientHeight - r.y - r.h + 45 };
  }

  /** Fit map to the given zips, inside the PDF frame when it is showing. */
  function fitZips(zips) {
    const b = zipBounds(zips);
    if (!b) { toast('No mapped ZIPs to zoom to'); return; }
    const padding = $('#frame').hidden ? 60 : framePadding(frameRect());
    map.fitBounds(b, { padding, maxZoom: 11, duration: 600 });
  }

  // ---------------------------------------------------------------- lasso
  let lasso = null;

  function drawLasso() {
    const svg = $('#lasso');
    svg.classList.toggle('erase', !!lasso?.erase);
    svg.querySelector('path').setAttribute('d', lasso ? 'M' + lasso.pts.map((p) => p.join(',')).join('L') + 'Z' : '');
  }

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function lassoStart(e) {
    if (state.mode !== 'lasso') return;
    e.preventDefault();
    hideTip();
    setHover(null);
    lasso = { pts: [[e.point.x, e.point.y]], erase: state.erase || !!e.originalEvent.altKey };
    drawLasso();
  }

  function lassoMove(e) {
    if (!lasso) return;
    const [lx, ly] = lasso.pts[lasso.pts.length - 1];
    if (Math.hypot(e.point.x - lx, e.point.y - ly) < 3) return;
    lasso.pts.push([e.point.x, e.point.y]);
    drawLasso();
  }

  function lassoEnd() {
    if (!lasso) return;
    const { pts, erase } = lasso;
    lasso = null;
    drawLasso();
    if (pts.length < 3) return;

    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const sw = map.unproject([Math.min(...xs), Math.max(...ys)]);
    const ne = map.unproject([Math.max(...xs), Math.min(...ys)]);
    const hits = [];
    for (const [zip, [lon, lat]] of index) {
      if (lon < sw.lng || lon > ne.lng || lat < sw.lat || lat > ne.lat) continue;
      const p = map.project([lon, lat]);
      if (pointInPolygon(p.x, p.y, pts)) hits.push(zip);
    }
    if (erase) {
      const n = applyChanges(hits.filter((z) => state.assign.has(z)).map((z) => [z, null]));
      toast(`Removed ${fmt(n)} ZIPs`);
    } else {
      const t = activeTerritory();
      const n = applyChanges(assignChanges(hits, t.id));
      toast(`Added ${fmt(n)} ZIPs to ${t.name}`);
    }
  }

  // ---------------------------------------------------------------- CSV
  const ZIP_HEADER = /^(zip|zips|zipcode|zip ?code|zip_code|zip5|postal ?code|postal_code|postcode|zcta|zcta5)$/;
  const TERR_HEADER = /^(territory|territory ?name|territory_name|region|area|rep|sales ?rep|owner|group|zone|market|team|segment|name)$/;
  const COLOR_HEADER = /^(color|colour|hex|fill)$/;

  function importRows(rows, { replace = false } = {}) {
    rows = rows.filter((r) => r.some((c) => String(c).trim()));
    if (!rows.length) return 'The file is empty.';

    const head = rows[0].map((h) => String(h).trim().toLowerCase());
    let zi = head.findIndex((h) => ZIP_HEADER.test(h));
    let ti = head.findIndex((h) => TERR_HEADER.test(h));
    let ci = head.findIndex((h) => COLOR_HEADER.test(h));
    let body = rows.slice(1);
    if (zi < 0) {
      // No recognisable header: pick the column that looks most like ZIPs.
      body = rows;
      const width = Math.max(...rows.map((r) => r.length));
      let best = -1;
      for (let c = 0; c < width; c++) {
        const hits = rows.slice(0, 200).filter((r) => normZip(r[c])).length;
        if (hits > best) { best = hits; zi = c; }
      }
      if (best <= 0) return 'Couldn’t find a ZIP column. Add a header named “zip”.';
      ti = rows[0].length > 1 ? [...rows[0].keys()].find((c) => c !== zi && !normZip(rows[0][c])) ?? -1 : -1;
      ci = -1;
      if (normZip(rows[0][zi]) === null) body = rows.slice(1);
    }

    if (replace) {
      state.territories = [];
      state.assign.clear();
      undoStack.length = 0;
      repaintAll();
    }

    const byName = new Map(state.territories.map((t) => [t.name.trim().toLowerCase(), t]));
    const fallback = ti < 0 ? activeTerritory() : null;
    const changes = [];
    let bad = 0;
    for (const r of body) {
      const zip = normZip(r[zi]);
      if (!zip) { bad++; continue; }
      let t = fallback;
      if (!t) {
        const name = String(r[ti] ?? '').trim() || 'Unnamed';
        const key = name.toLowerCase();
        t = byName.get(key);
        const color = ci >= 0 ? String(r[ci] ?? '').trim() : '';
        if (!t) { t = addTerritory(name, color); byName.set(key, t); }
        else if (/^#[0-9a-f]{6}$/i.test(color)) t.color = color.toLowerCase();
      }
      changes.push([zip, t.id]);
    }
    if (!state.territories.length) addTerritory();
    if (!territory(state.activeId)) state.activeId = state.territories[0].id;

    const zips = changes.map((c) => c[0]);
    const unmapped = new Set(zips.filter((z) => !index.has(z)));
    const used = new Set(changes.map((c) => c[1]));
    const n = applyChanges(changes);
    repaintAll();
    renderAll();
    save();
    if (n) fitZips(zips);

    let msg = `<b>${fmt(changes.length)} ZIPs</b> imported into <b>${used.size}</b> territor${used.size === 1 ? 'y' : 'ies'}.`;
    if (unmapped.size) msg += ` ${fmt(unmapped.size)} have no map area (PO Box or single-business ZIPs): ${[...unmapped].slice(0, 15).join(', ')}${unmapped.size > 15 ? '…' : ''}.`;
    if (bad) msg += ` ${fmt(bad)} rows skipped (no valid ZIP).`;
    return msg;
  }

  function exportCsv() {
    const order = new Map(state.territories.map((t, i) => [t.id, i]));
    const rows = [...state.assign]
      .sort((a, b) => order.get(a[1]) - order.get(b[1]) || a[0].localeCompare(b[0]))
      .map(([zip, tid]) => {
        const t = territory(tid);
        const name = /[",\n]/.test(t.name) ? `"${t.name.replace(/"/g, '""')}"` : t.name;
        return [zip, name, t.color, index.get(zip)?.[2] ?? '', index.has(zip) ? 'yes' : 'no'].join(',');
      });
    const csv = ['zip,territory,color,state,on_map', ...rows].join('\n') + '\n';
    download(`territories-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([csv], { type: 'text/csv' }));
  }

  // ---------------------------------------------------------------- PDF
  const ZIP_W = 31;      // pt per ZIP in a legend row
  const ZIP_LINE = 11;   // pt per legend ZIP row
  const ZIP_HEAD = 17;   // pt for a territory heading in the ZIP legend
  const ZIP_GAP = 6;     // pt between territories in the ZIP legend

  function pdfOptions() {
    return {
      title: $('#pdf-title').value.trim(),
      subtitle: $('#pdf-subtitle').value.trim(),
      size: $('#pdf-size').value,
      orient: $('#pdf-orient').value,
      scope: $('#pdf-scope').value,              // all | active | each
      content: $('#pdf-legend-content').value,   // names | zips
      showOthers: $('#pdf-others').checked,
      legend: $('#pdf-legend').value,
      dpi: +$('#pdf-dpi').value,
      counts: $('#pdf-counts').checked,
      list: $('#pdf-list').checked,
    };
  }

  /** Territories that have ZIPs, in list order, each with its sorted ZIPs. */
  function legendItems() {
    const byT = new Map();
    for (const [zip, tid] of state.assign) {
      if (!byT.has(tid)) byT.set(tid, []);
      byT.get(tid).push(zip);
    }
    return state.territories
      .filter((t) => byT.has(t.id))
      .map((t) => {
        const zips = byT.get(t.id).sort();
        return { ...t, zips, n: zips.length };
      });
  }

  /** Pages to export: which territories each page shows, and whether it auto-zooms. */
  function pdfPages(o) {
    const items = legendItems();
    if (o.scope === 'all') return items.length ? [{ items, focus: false }] : [];
    if (o.scope === 'active') {
      const t = items.find((i) => i.id === state.activeId);
      return t ? [{ items: [t], focus: false }] : [];
    }
    return items.map((t) => ({ items: [t], focus: true }));
  }

  function zipLegendHeight(items, width) {
    const perRow = Math.max(1, Math.floor(width / ZIP_W));
    return items.reduce((h, t) => h + ZIP_HEAD + Math.ceil(t.n / perRow) * ZIP_LINE + ZIP_GAP, 0);
  }

  /**
   * Page geometry. `sizing` is the legend content the layout must fit; with one
   * page per territory it is the largest territory, so every page shares one layout.
   */
  function pdfLayout(o, sizing) {
    let [w, h] = PAGE_SIZES[o.size];
    if (o.orient === 'landscape') [w, h] = [h, w];
    const M = 32;
    let y = M;
    const header = {};
    if (o.title) { header.titleY = y + 16; y += 24; }
    if (o.subtitle) { header.subY = y + 10; y += 16; }
    if (o.title || o.subtitle) y += 10;
    const footerH = 16;
    const mapBox = { x: M, y, w: w - 2 * M, h: h - y - M - footerH };
    const n = sizing.length;
    let legend = null;

    if (o.legend === 'right' && n) {
      let lw = Math.min(190, mapBox.w * 0.3);
      if (o.content === 'zips') {
        // Widen in whole-ZIP steps until the list fits, up to 42% of the page.
        lw = 6 * ZIP_W;
        const maxW = mapBox.w * 0.42;
        while (lw + ZIP_W <= maxW && zipLegendHeight(sizing, lw) > mapBox.h - 20) lw += ZIP_W;
      }
      mapBox.w -= lw + 14;
      legend = { x: mapBox.x + mapBox.w + 14, y: mapBox.y, w: lw, h: mapBox.h, cols: 1 };
    } else if (o.legend === 'bottom' && n) {
      let lh, cols = 1;
      if (o.content === 'zips') {
        lh = Math.min(20 + zipLegendHeight(sizing, mapBox.w), mapBox.h * 0.4);
      } else {
        cols = Math.max(1, Math.floor(mapBox.w / 180));
        lh = 22 + Math.ceil(n / cols) * 16;
      }
      mapBox.h -= lh + 10;
      legend = { x: mapBox.x, y: mapBox.y + mapBox.h + 10, w: mapBox.w, h: lh, cols };
    }
    return { w, h, M, header, map: mapBox, legend, footerY: h - M + 6 };
  }

  function pdfPlan(o = pdfOptions()) {
    const pages = pdfPages(o);
    let sizing = pages[0]?.items ?? [];
    if (o.scope === 'each') sizing = [pages.reduce((a, p) => (p.items[0].n > (a?.n ?? -1) ? p.items[0] : a), null)].filter(Boolean);
    return { o, pages, L: pdfLayout(o, sizing) };
  }

  /** Largest rectangle with the PDF map's aspect ratio that fits in the map view. */
  function frameRect(L = pdfPlan().L) {
    const aspect = L.map.w / L.map.h;
    const wrap = $('#map-wrap');
    const inset = 36;
    const aw = wrap.clientWidth - 2 * inset, ah = wrap.clientHeight - 2 * inset - 20;
    let w = aw, h = aw / aspect;
    if (h > ah) { h = ah; w = ah * aspect; }
    return { x: Math.round((wrap.clientWidth - w) / 2), y: Math.round((wrap.clientHeight - h) / 2 + 10), w: Math.round(w), h: Math.round(h) };
  }

  function updateFrame() {
    const f = $('#frame');
    const r = frameRect();
    Object.assign(f.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    updatePreviewFilter();
  }

  /** While framing a single-territory PDF, show only the active territory on the map. */
  function updatePreviewFilter() {
    const o = pdfOptions();
    const on = !$('#frame').hidden && o.scope !== 'all' && !o.showOthers;
    const next = on ? new Set([state.activeId]) : null;
    if (String([...(paintFilter ?? [])]) === String([...(next ?? [])])) return;
    paintFilter = next;
    repaintAll();
  }

  function waitFor(event, ms = 15000) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      map.once(event, () => { clearTimeout(t); resolve(); });
    });
  }

  /** Copy the frame area of the map canvas once everything has loaded. */
  async function grabFrame(rect) {
    const canvas = map.getCanvas();
    const idle = waitFor('idle');
    map.triggerRepaint();
    await idle;
    const out = document.createElement('canvas');
    await new Promise((resolve) => {
      map.once('render', () => {
        const s = canvas.width / canvas.clientWidth;
        out.width = Math.round(rect.w * s);
        out.height = Math.round(rect.h * s);
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, rect.x * s, rect.y * s, rect.w * s, rect.h * s, 0, 0, out.width, out.height);
        resolve();
      });
      map.triggerRepaint();
    });
    return out;
  }

  function fitText(doc, text, maxW) {
    if (doc.getTextWidth(text) <= maxW) return text;
    while (text.length > 1 && doc.getTextWidth(text + '...') > maxW) text = text.slice(0, -1);
    return text + '...';
  }

  const withTerritory = (text, items, scope) =>
    text.replace(/\{territory\}/gi, scope === 'all' ? 'All territories' : items.map((t) => t.name).join(', '));

  async function exportPdf() {
    const { o, pages, L } = pdfPlan();
    if (!pages.length) {
      toast(o.scope === 'active' ? 'The active territory has no ZIPs yet' : 'No ZIPs to export yet');
      return;
    }
    const btn = $('#pdf-export');
    btn.disabled = true;
    const rect = frameRect(L);
    const view = { center: map.getCenter(), zoom: map.getZoom() };
    const prevRatio = map.getPixelRatio();
    const prevFilter = paintFilter;
    setHover(null);
    hideTip();
    try {
      const canvas = map.getCanvas();
      const targetPx = (L.map.w / 72) * o.dpi;
      map.setPixelRatio(Math.max(prevRatio, Math.min(4, targetPx / rect.w, 8192 / Math.max(canvas.clientWidth, canvas.clientHeight))));

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: o.orient, unit: 'pt', format: [L.w, L.h], compress: true });
      let needList = o.list;

      for (const [i, page] of pages.entries()) {
        toast(pages.length > 1 ? `Rendering page ${i + 1} of ${pages.length}…` : 'Rendering PDF…', 0);
        if (i) doc.addPage([L.w, L.h], o.orient);

        paintFilter = o.scope !== 'all' && !o.showOthers ? new Set(page.items.map((t) => t.id)) : null;
        repaintAll();
        if (page.focus) {
          const b = zipBounds(page.items[0].zips);
          if (b) map.jumpTo(map.cameraForBounds(b, { padding: framePadding(rect), maxZoom: 11 }));
        }
        const img = await grabFrame(rect);

        doc.setTextColor(28, 28, 26);
        if (o.title) {
          doc.setFont('helvetica', 'bold').setFontSize(20);
          doc.text(fitText(doc, withTerritory(o.title, page.items, o.scope), L.w - 2 * L.M), L.M, L.header.titleY);
        }
        if (o.subtitle) {
          doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(100, 100, 95);
          doc.text(fitText(doc, withTerritory(o.subtitle, page.items, o.scope), L.w - 2 * L.M), L.M, L.header.subY);
        }

        doc.addImage(img.toDataURL('image/jpeg', 0.92), 'JPEG', L.map.x, L.map.y, L.map.w, L.map.h, undefined, 'FAST');
        doc.setDrawColor(190, 190, 185).setLineWidth(0.6);
        doc.rect(L.map.x, L.map.y, L.map.w, L.map.h);

        if (L.legend) {
          const overflow = o.content === 'zips'
            ? drawZipLegend(doc, L.legend, page.items)
            : drawNameLegend(doc, L.legend, page.items, o);
          needList ||= overflow;
        }

        const total = page.items.reduce((s, t) => s + t.n, 0);
        const terr = page.items.length === 1 ? page.items[0].name : `${page.items.length} territories`;
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(120, 120, 115);
        doc.text(
          `${fmt(total)} ZIP codes in ${terr}  ·  ZIP areas: U.S. Census Bureau 2020 ZCTAs  ·  Basemap © OpenMapTiles © OpenStreetMap contributors  ·  ${new Date().toLocaleDateString('en-US')}`,
          L.M, L.footerY,
        );
      }

      if (needList) drawZipList(doc, L, pages.flatMap((p) => p.items));

      const base = pages.length === 1
        ? withTerritory(o.title || 'territories', pages[0].items, o.scope)
        : (o.title || '').replace(/\{territory\}/gi, '').trim() || 'territories';
      const name = base.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'territories';
      doc.save(`${name}.pdf`);
      toast(`PDF saved (${pages.length} map page${pages.length === 1 ? '' : 's'})`);
    } catch (err) {
      console.error(err);
      toast(`PDF export failed: ${err.message}`, 6000);
    } finally {
      map.setPixelRatio(prevRatio);
      paintFilter = prevFilter;
      repaintAll();
      if (o.scope === 'each') map.jumpTo(view);
      btn.disabled = false;
    }
  }

  function drawSwatch(doc, color, x, y) {
    doc.setFillColor(...hexToRgb(color)).setDrawColor(90, 90, 85).setLineWidth(0.4);
    doc.roundedRect(x, y, 11, 11, 1.5, 1.5, 'FD');
  }

  function drawNameLegend(doc, box, items, o) {
    const colW = box.w / box.cols;
    const rowH = 16;
    doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(28, 28, 26);
    doc.text('Legend', box.x, box.y + 10);
    const top = box.y + 20;
    const maxRows = box.cols === 1 ? Math.floor((box.h - 20) / rowH) : Math.ceil(items.length / box.cols);
    items.forEach((t, i) => {
      const col = box.cols === 1 ? 0 : Math.floor(i / maxRows);
      const row = box.cols === 1 ? i : i % maxRows;
      if (box.cols === 1 && i >= maxRows) return;
      const x = box.x + col * colW, y = top + row * rowH;
      drawSwatch(doc, t.color, x, y);
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(28, 28, 26);
      const countW = o.counts ? 34 : 0;
      doc.text(fitText(doc, t.name, colW - 18 - countW - 8), x + 17, y + 8.8);
      if (o.counts) {
        doc.setTextColor(110, 110, 105);
        doc.text(fmt(t.n), x + colW - 8, y + 8.8, { align: 'right' });
      }
    });
    if (box.cols === 1 && items.length > maxRows) {
      doc.setFontSize(8.5).setTextColor(110, 110, 105);
      doc.text(`+ ${items.length - maxRows} more`, box.x, top + maxRows * rowH + 6);
      return true;
    }
    return false;
  }

  /** Legend listing each territory's ZIPs under its color. Returns true if it had to truncate. */
  function drawZipLegend(doc, box, items) {
    const perRow = Math.max(1, Math.floor(box.w / ZIP_W));
    const bottom = box.y + box.h;
    let y = box.y + 10;
    doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(28, 28, 26);
    doc.text(items.length === 1 ? 'ZIP codes' : 'Legend', box.x, y);
    y += 10;
    let unmapped = false;
    for (const [ti, t] of items.entries()) {
      if (y + ZIP_HEAD + ZIP_LINE > bottom) {
        doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110, 110, 105);
        doc.text(`+ ${items.length - ti} more territories (see ZIP list)`, box.x, y + 8);
        return true;
      }
      drawSwatch(doc, t.color, box.x, y);
      doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(28, 28, 26);
      const count = `${fmt(t.n)} ZIPs`;
      doc.text(fitText(doc, t.name, box.w - 17 - doc.getTextWidth(count) - 8), box.x + 17, y + 8.8);
      doc.setFont('helvetica', 'normal').setTextColor(110, 110, 105);
      doc.text(count, box.x + box.w, y + 8.8, { align: 'right' });
      y += ZIP_HEAD;

      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(40, 40, 38);
      for (let i = 0; i < t.zips.length; i += perRow) {
        const lastLine = y + 2 * ZIP_LINE > bottom;
        if (lastLine && i + perRow < t.zips.length) {
          doc.setTextColor(110, 110, 105);
          doc.text(`+ ${fmt(t.zips.length - i)} more ZIPs (see ZIP list)`, box.x, y + 7);
          return true;
        }
        t.zips.slice(i, i + perRow).forEach((z, j) => {
          const off = !index.has(z);
          unmapped ||= off;
          doc.text(off ? `${z}*` : z, box.x + j * ZIP_W, y + 7);
        });
        y += ZIP_LINE;
      }
      y += ZIP_GAP;
    }
    if (unmapped && y + 10 <= bottom) {
      doc.setFontSize(7).setTextColor(110, 110, 105);
      doc.text('* no map area (PO Box / unique ZIP)', box.x, y + 4);
    }
    return false;
  }

  function drawZipList(doc, L, items) {
    const lineH = 12;
    const colW = 40;
    const cols = Math.floor((L.w - 2 * L.M) / colW);
    let y;
    const newPage = () => {
      doc.addPage([L.w, L.h], L.w > L.h ? 'landscape' : 'portrait');
      y = L.M + 10;
    };
    newPage();
    doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(28, 28, 26);
    doc.text('ZIP codes by territory', L.M, y);
    y += 22;
    let anyUnmapped = false;
    for (const t of items) {
      if (y + 40 > L.h - L.M) newPage();
      drawSwatch(doc, t.color, L.M, y - 9);
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(28, 28, 26);
      doc.text(`${t.name}  (${fmt(t.n)})`, L.M + 17, y);
      y += 16;
      doc.setFont('courier', 'normal').setFontSize(9);
      for (let i = 0; i < t.zips.length; i += cols) {
        if (y > L.h - L.M) newPage();
        t.zips.slice(i, i + cols).forEach((z, j) => {
          const off = !index.has(z);
          anyUnmapped ||= off;
          doc.text(off ? `${z}*` : z, L.M + j * colW, y);
        });
        y += lineH;
      }
      y += 12;
    }
    if (anyUnmapped) {
      if (y > L.h - L.M) newPage();
      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110, 110, 105);
      doc.text('* No map area (PO Box or single-business ZIP)', L.M, y);
    }
  }

  // ---------------------------------------------------------------- events
  function syncPdfControls() {
    const scope = $('#pdf-scope').value;
    $('#pdf-others-row').hidden = scope === 'all';
    $('#pdf-counts-row').hidden = $('#pdf-legend-content').value === 'zips';
    $('#pdf-fit').textContent = scope === 'all' ? 'Fit territories in frame' : 'Fit active territory in frame';
    $('#pdf-scope-hint').textContent = {
      all: '',
      active: 'Exports the highlighted territory in the list.',
      each: 'One page per territory, each zoomed to fit. The frame shows the page shape.',
    }[scope];
  }

  function bindUi() {
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('#erase').addEventListener('change', (e) => { state.erase = e.target.checked; });
    $('#undo').addEventListener('click', undo);

    // territory list (delegated)
    const list = $('#terr-list');
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.terr');
      if (!row) return;
      const t = territory(row.dataset.id);
      if (e.target.closest('.del')) {
        const n = counts().get(t.id).all;
        if (n && !confirm(`Delete “${t.name}” and unassign its ${fmt(n)} ZIPs?`)) return;
        const zips = [...state.assign].filter(([, tid]) => tid === t.id).map(([z]) => z);
        state.territories = state.territories.filter((x) => x !== t);
        zips.forEach((z) => { state.assign.delete(z); paint(z); });
        undoStack.length = 0;
        if (state.activeId === t.id) state.activeId = state.territories[0]?.id ?? null;
        renderAll();
        save();
        return;
      }
      if (e.target.closest('.zoom')) {
        fitZips([...state.assign].filter(([, tid]) => tid === t.id).map(([z]) => z));
      }
      if (state.activeId !== t.id) setActive(t.id);
    });
    list.addEventListener('input', (e) => {
      const row = e.target.closest('.terr');
      const t = territory(row?.dataset.id);
      if (!t) return;
      if (e.target.type === 'color') {
        t.color = e.target.value;
        for (const [z, tid] of state.assign) if (tid === t.id) paint(z);
      } else if (e.target.classList.contains('name')) {
        t.name = e.target.value;
        document.querySelectorAll('.active-name').forEach((n) => { n.textContent = territory(state.activeId)?.name ?? ''; });
      }
      renderLegend();
      save();
    });
    list.addEventListener('change', (e) => {
      if (e.target.classList.contains('name') && !e.target.value.trim()) {
        const t = territory(e.target.closest('.terr').dataset.id);
        t.name = 'Untitled';
        renderAll();
        save();
      }
    });

    $('#add-terr').addEventListener('click', () => {
      const t = addTerritory();
      state.activeId = t.id;
      renderAll();
      save();
      $('#terr-list .terr:last-child .name').select();
    });
    $('#fit-all').addEventListener('click', () => fitZips(state.assign.keys()));

    // paste box
    const zipMsg = $('#zip-msg');
    $('#zip-add').addEventListener('click', () => {
      const { zips, invalid } = parseZipText($('#zip-input').value);
      if (!zips.length) { zipMsg.textContent = invalid.length ? `Not ZIPs: ${invalid.slice(0, 10).join(', ')}` : 'Paste some ZIPs first.'; return; }
      const t = activeTerritory();
      const n = applyChanges(assignChanges(zips, t.id));
      const unmapped = zips.filter((z) => !index.has(z));
      let msg = `<b>${fmt(n)}</b> ZIPs added to <b></b>.`;
      if (zips.length - n) msg += ` ${fmt(zips.length - n)} already there or protected.`;
      if (unmapped.length) msg += ` ${fmt(unmapped.length)} have no map area: ${unmapped.slice(0, 12).join(', ')}${unmapped.length > 12 ? '…' : ''}.`;
      if (invalid.length) msg += ` Skipped: ${invalid.slice(0, 10).join(', ')}.`;
      zipMsg.innerHTML = msg;
      zipMsg.querySelector('b:nth-of-type(2)').textContent = t.name;
      if (n) fitZips(zips);
    });
    $('#zip-remove').addEventListener('click', () => {
      const { zips } = parseZipText($('#zip-input').value);
      const n = applyChanges(zips.filter((z) => state.assign.has(z)).map((z) => [z, null]));
      zipMsg.innerHTML = `<b>${fmt(n)}</b> ZIPs removed.`;
    });

    // csv
    const csvMsg = $('#csv-msg');
    $('#csv-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      Papa.parse(file, {
        skipEmptyLines: true,
        complete: (res) => { csvMsg.innerHTML = importRows(res.data, { replace: $('#csv-replace').checked }); },
        error: (err) => { csvMsg.textContent = `Couldn’t read file: ${err.message}`; },
      });
      e.target.value = '';
    });
    $('#csv-export').addEventListener('click', () => {
      if (!state.assign.size) { toast('Nothing to export yet'); return; }
      exportCsv();
    });
    $('#sample').addEventListener('click', async () => {
      if (state.assign.size && !confirm('Replace your current territories with the sample?')) return;
      const text = await (await fetch('sample/territories-sample.csv')).text();
      csvMsg.innerHTML = importRows(Papa.parse(text, { skipEmptyLines: true }).data, { replace: true });
    });
    $('#clear-all').addEventListener('click', () => {
      if (!confirm('Remove all territories and ZIPs?')) return;
      state.territories = [];
      state.assign.clear();
      undoStack.length = 0;
      state.activeId = addTerritory().id;
      repaintAll();
      renderAll();
      save();
      csvMsg.textContent = '';
    });

    // display
    $('#basemap').addEventListener('change', (e) => {
      hoverId = null;
      map.setStyle(BASEMAPS[e.target.value], { diff: false });
    });
    $('#opacity').addEventListener('input', () => map.getLayer('zcta-fill') && map.setPaintProperty('zcta-fill', 'fill-opacity', fillOpacity()));
    $('#show-borders').addEventListener('change', (e) => map.getLayer('zcta-line') && map.setLayoutProperty('zcta-line', 'visibility', e.target.checked ? 'visible' : 'none'));
    $('#show-labels').addEventListener('change', (e) => map.getLayer('zcta-label') && map.setLayoutProperty('zcta-label', 'visibility', e.target.checked ? 'visible' : 'none'));
    $('#show-legend').addEventListener('change', renderLegend);

    // go to zip
    $('#goto').addEventListener('submit', (e) => {
      e.preventDefault();
      const zip = normZip($('#goto-zip').value);
      const p = zip && index.get(zip);
      if (!p) { toast(zip ? `${zip} has no map area` : 'Enter a 5-digit ZIP'); return; }
      map.flyTo({ center: [p[0], p[1]], zoom: Math.max(map.getZoom(), 11), duration: 900 });
      map.once('moveend', () => { setHover(zip); setTimeout(() => hoverId === zip && setHover(null), 2500); });
    });

    // pdf
    const pdfSec = $('#sec-pdf');
    pdfSec.addEventListener('toggle', () => {
      $('#frame').hidden = !pdfSec.open;
      if (pdfSec.open) updateFrame();
      else updatePreviewFilter();
      renderLegend();
    });
    ['#pdf-title', '#pdf-subtitle', '#pdf-size', '#pdf-orient', '#pdf-legend', '#pdf-legend-content', '#pdf-others']
      .forEach((s) => $(s).addEventListener('input', () => { syncPdfControls(); if (!$('#frame').hidden) updateFrame(); }));
    $('#pdf-scope').addEventListener('input', (e) => {
      // Sensible defaults per scope; both stay editable afterwards.
      const single = e.target.value !== 'all';
      $('#pdf-legend-content').value = single ? 'zips' : 'names';
      const title = $('#pdf-title');
      if (single && title.value === 'Marketing Territories') title.value = '{territory}';
      if (!single && title.value === '{territory}') title.value = 'Marketing Territories';
      syncPdfControls();
      if (!$('#frame').hidden) updateFrame();
    });
    syncPdfControls();
    $('#pdf-subtitle').value = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    $('#pdf-fit').addEventListener('click', () => fitZips(
      $('#pdf-scope').value === 'all' ? state.assign.keys() : [...state.assign].filter(([, t]) => t === state.activeId).map(([z]) => z),
    ));
    $('#pdf-export').addEventListener('click', exportPdf);
    window.addEventListener('resize', () => !$('#frame').hidden && updateFrame());

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setMode('view');
      else if (k === 'c') setMode('click');
      else if (k === 'l') setMode('lasso');
      else if (k === 'e') { state.erase = !state.erase; $('#erase').checked = state.erase; }
      else if (k === 'escape' && lasso) { lasso = null; drawLasso(); }
    });
  }

  function bindMap() {
    map.on('style.load', () => {
      addLayers();
      repaintAll();
    });

    map.on('mousemove', 'zcta-fill', (e) => {
      if (lasso) return;
      const f = e.features?.[0];
      if (!f) return;
      setHover(f.id);
      showTip(e.point, String(f.id));
      map.getCanvas().style.cursor = state.mode === 'click' ? 'pointer' : '';
    });
    map.on('mouseleave', 'zcta-fill', () => {
      setHover(null);
      hideTip();
      map.getCanvas().style.cursor = '';
    });

    map.on('click', 'zcta-fill', (e) => {
      if (state.mode !== 'click') return;
      const zip = String(e.features[0].id);
      const erase = state.erase || e.originalEvent.altKey;
      const cur = state.assign.get(zip);
      const t = activeTerritory();
      if (erase || cur === t.id) applyChanges([[zip, null]]);
      else applyChanges(assignChanges([zip], t.id)) || toast(`${zip} belongs to ${territory(cur)?.name} (protected)`);
      showTip(e.point, zip);
    });

    map.on('mousedown', lassoStart);
    map.on('touchstart', lassoStart);
    map.on('mousemove', lassoMove);
    map.on('touchmove', lassoMove);
    window.addEventListener('mouseup', lassoEnd);
    window.addEventListener('touchend', lassoEnd);
  }

  // ---------------------------------------------------------------- boot
  async function init() {
    load();
    bindUi();

    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    map = new maplibregl.Map({
      container: 'map',
      style: BASEMAPS.light,
      center: [-96.5, 38.5],
      zoom: 3.7,
      minZoom: 2,
      maxZoom: 15,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
    bindMap();
    setMode(state.mode);
    renderAll();

    try {
      const rows = await (await fetch('data/zcta-index.json')).json();
      for (const [z, x, y, s] of rows) index.set(z, [x, y, s]);
    } catch (err) {
      toast('Couldn’t load ZIP index. Run “npm run build-data” first.', 0);
      throw err;
    }
    repaintAll();
    renderAll();
  }

  init();
})();

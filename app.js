// ─────────────────────────────────────────────────────────────
//  APP — SPA router + pages (Overview, Records)
//  Pull: merged Recruit + Sheet data. Push: edit → write back.
// ─────────────────────────────────────────────────────────────
const App = (() => {

  let _records = null;   // cached merged data
  let _lastUpdated = null;   // ms timestamp of the data currently shown
  let _charts  = [];      // live Chart.js instances (destroyed on re-render)
  let _search  = '';

  // ── Helpers ────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const tc = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    tc.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function badge(text) {
    if (!text || text === '—') return `<span class="badge badge-gray">—</span>`;
    const t = String(text).toLowerCase();
    if (/active|approved|hired|placed|done|complete|contacted/.test(t)) return `<span class="badge badge-green">${esc(text)}</span>`;
    if (/pending|progress|processing|follow|review/.test(t))            return `<span class="badge badge-yellow">${esc(text)}</span>`;
    if (/reject|cancel|denied|inactive|drop|lost/.test(t))             return `<span class="badge badge-red">${esc(text)}</span>`;
    return `<span class="badge badge-gray">${esc(text)}</span>`;
  }

  // Parse a date from Zoho. Recruit fields come as ISO / MM-DD-YYYY
  // (native-parseable); Zoho Sheet cells come as DD/MM/YYYY (Indonesian
  // locale) which native Date can't handle — fall back to that.
  function parseDate(v) {
    if (v == null || v === '' || v === '—') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v).trim();
    const d = new Date(s);
    if (!isNaN(d)) return d;
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/); // DD/MM/YYYY
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, (+m[2]) - 1, +m[1]); }
    return null;
  }

  function formatDate(str) {
    const d = parseDate(str);
    if (d) return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    return (str && str !== '—') ? String(str) : '—';
  }

  // Zoho SHEET dates are DD/MM/YYYY (Indonesian). Unlike module dates,
  // day comes first — parse day-first for slash/dash dates, else native
  // (handles ISO / datetime strings). Use this for any Sheet-sourced date.
  function parseSheetDate(v) {
    if (v == null || v === '' || v === '—') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = new Date(y, (+m[2]) - 1, +m[1]); return isNaN(d) ? null : d; }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function formatSheetDate(v) {
    const d = parseSheetDate(v);
    if (d) return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    return (v && v !== '—') ? String(v) : '—';
  }

  function destroyCharts() { _charts.forEach(c => c.destroy()); _charts = []; }

  function updateStatus() {
    const el = document.getElementById('zohoStatus');
    if (!el) return;
    el.className = 'zoho-status connected';
    el.innerHTML = `<span class="dot"></span> Live Data`;
    el.title = 'Click to refresh';
    el.onclick = () => refresh();

    const stamp = document.getElementById('lastRefresh');
    if (stamp && _lastUpdated) {
      const t = new Date(_lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      stamp.textContent = `🔄 Updated ${t}`;
      stamp.title = `Data last refreshed at ${new Date(_lastUpdated).toLocaleString()}`;
    }
  }

  function skeletonHTML() {
    return `
      <div class="skeleton">
        <div class="skeleton-stat-grid">
          ${[1,2,3,4].map(() => `<div class="skeleton-stat"></div>`).join('')}
        </div>
        <div class="skeleton-block" style="height:260px"></div>
      </div>`;
  }

  function errorHTML() {
    return `
      <div class="connect-prompt">
        <div class="connect-icon">⚠️</div>
        <h2>Unable to load data</h2>
        <p>Could not fetch data from Zoho. Check the worker URL and your connection, then retry.</p>
        <button class="btn-connect" onclick="App.refresh()">Retry</button>
      </div>`;
  }

  // ── Data load (stale-while-revalidate via IndexedDB) ────────
  // On refresh the SPA reboots and _records is null. Re-fetching
  // everything is slow (~6.5k records + 10k sheet rows), so we render
  // instantly from an IndexedDB cache (handles the ~10MB dataset that
  // would overflow localStorage) and revalidate only when it's stale.
  const CACHE_TTL   = 30 * 60 * 1000;  // ignore cache older than 30 min
  // Bump when the record-mapping logic changes so old snapshots are discarded
  // (otherwise a stale snapshot mapped by the previous code is shown first).
  const CACHE_VERSION = 3;
  const DB_NAME = 'cti_indo', STORE = 'cache', CACHE_KEY = 'records';

  function idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { return null; }
  }
  async function idbSet(key, val) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      });
    } catch { /* ignore cache write failures */ }
  }

  async function readCache() {
    const c = await idbGet(CACHE_KEY);
    if (!c || c.v !== CACHE_VERSION || !Array.isArray(c.records) || (Date.now() - c.ts) > CACHE_TTL) return null;
    return c;
  }

  async function fetchFresh() {
    _records = await Zoho.getAllRecords();
    _lastUpdated = Date.now();
    idbSet(CACHE_KEY, { ts: _lastUpdated, v: CACHE_VERSION, records: _records });  // fire and forget
    return _records;
  }

  function revalidate() {
    fetchFresh().then(() => renderCurrentPage()).catch(() => {});
  }

  async function loadData(force = false) {
    if (_records && !force) return _records;
    if (!force) {
      const c = await readCache();
      if (c) {
        _records = c.records;
        _lastUpdated = c.ts;
        // Always pull fresh in the background so a page reload reflects
        // the latest Zoho edits. The cache only avoids a blank-screen wait;
        // it is never the final word within a session.
        revalidate();
        return _records;
      }
    }
    try { return await fetchFresh(); }
    catch (err) { toast(`Failed to load: ${err.message}`, 'error'); return null; }
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: OVERVIEW
  // ═══════════════════════════════════════════════════════════
  async function renderOverview() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();

    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    const data = allData.filter(includeRecord);

    // Deployment sheet rows drive the historical deployment chart.
    let deployRows = [];
    try { deployRows = await Zoho.getSheetRows('cruise'); } catch { deployRows = []; }

    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');

    destroyCharts();
    mc.innerHTML = `
      <div class="page-header"><h1>Overview</h1></div>
      <div class="filter-bar">
        ${msHTML('ovOffice', 'All CTI Offices', offices, _ovFilters.office)}
        ${msHTML('ovLine', 'All Cruise Lines', cruiseLines, _ovFilters.cruiseLine)}
      </div>
      <div class="stat-grid" id="ovStats"></div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">Deployments — last 12 months <span class="hint">(sign-on, deployment history)</span></div>
          <canvas id="chartDeploy" height="240"></canvas>
        </div>
        <div class="card chart-card">
          <div class="card-title">Upcoming Assignments — next 6 months <span class="hint">(by sign-on date)</span></div>
          <canvas id="chartAssign" height="240"></canvas>
        </div>
      </div>`;

    const paint = () => paintOverview(data, deployRows);
    wireMS(mc, 'ovOffice', sel => { _ovFilters.office = sel;     paint(); });
    wireMS(mc, 'ovLine',   sel => { _ovFilters.cruiseLine = sel; paint(); });

    paint();
    updateStatus();
  }

  function paintOverview(data, deployRows) {
    const f = _ovFilters;
    const inSet = (arr, v) => !arr.length || arr.includes(v);
    const monthKey = d => d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    const base = new Date(); base.setDate(1); base.setHours(0, 0, 0, 0);   // 1st of current month

    // Filtered module records.
    const recs = data.filter(r => inSet(f.office, r.ctiOffice) && inSet(f.cruiseLine, r.cruiseLine));

    // Stat cards (from the module, respecting the filter).
    const isNewHire  = r => /new\s*hire|re\s*hire/i.test(String(r.employmentStatus || ''));
    const isRepeater = r => /repeat/i.test(String(r.employmentStatus || ''));
    const hasSignOn  = r => r.signOnDate && r.signOnDate !== '—';
    const newHired = recs.filter(isNewHire).length;
    const repeater = recs.filter(isRepeater).length;
    const assigned = recs.filter(hasSignOn).length;
    const noAssignRows = recs.filter(r => !hasSignOn(r));
    const noAssign = noAssignRows.length;
    const stats = document.getElementById('ovStats');
    if (stats) stats.innerHTML =
      statCard('Total Seafarers', recs.length.toLocaleString()) +
      statCard('New Hired', newHired.toLocaleString()) +
      statCard('Repeater', repeater.toLocaleString()) +
      statCard('Assigned', assigned.toLocaleString()) +
      statCard('No Assignment', noAssign.toLocaleString(), { id: 'statNoAssign', clickable: noAssign > 0 });

    // No Assignment tile → drill down to those seafarers.
    const naCard = document.getElementById('statNoAssign');
    if (naCard && noAssign) {
      const naCols = [
        { label: 'ID Number',         render: r => esc(r.crewIdNumber),     sort: r => txtSort(r.crewIdNumber), w: 100 },
        { label: 'Name',              render: r => esc(r.name),             sort: r => txtSort(r.name),         w: 200, wrap: true },
        { label: 'Email',             render: r => esc(r.email),            sort: r => txtSort(r.email),        w: 250, wrap: true },
        { label: 'Position Hired',    render: r => esc(r.position),         sort: r => txtSort(r.position),     w: 210, wrap: true },
        { label: 'Cruise Line',       render: r => esc(r.cruiseLine),       sort: r => txtSort(r.cruiseLine),   w: 130 },
        { label: 'Hired Date',        render: r => formatDate(r.hiredDate), sort: r => dateSort(parseDate(r.hiredDate)), num: true, w: 110 },
        { label: 'Onboarding Status', render: r => esc(r.onboardingStatus), sort: r => txtSort(r.onboardingStatus), w: 160 },
      ];
      const naTabs = [
        { label: 'New Hire', rows: noAssignRows.filter(isNewHire) },
        { label: 'Repeater', rows: noAssignRows.filter(isRepeater) },
      ];
      naCard.onclick = () => openDetailModal(null, naCols, 'No Assignment', naTabs);
    }

    destroyCharts();

    // Chart 1 — deployments (sheet), last 12 months (current + 11 back).
    const back = {};
    for (let i = 11; i >= 0; i--) { const d = new Date(base); d.setMonth(d.getMonth() - i); back[monthKey(d)] = 0; }
    const minBack = new Date(base); minBack.setMonth(minBack.getMonth() - 11);
    const maxCur  = new Date(base); maxCur.setMonth(maxCur.getMonth() + 1);
    deployRows.forEach(row => {
      if (!inSet(f.office, row['CTI Office']) || !inSet(f.cruiseLine, row['Cruise Line'])) return;
      const d = parseSheetDate(row['Sign On Date']);
      if (!d || d < minBack || d >= maxCur) return;
      const k = monthKey(new Date(d.getFullYear(), d.getMonth(), 1));
      if (k in back) back[k]++;
    });
    drawBar('chartDeploy', back);

    // Chart 2 — upcoming assignments (module sign-on), current + 6 months ahead.
    const fwd = {};
    for (let i = 0; i <= 6; i++) { const d = new Date(base); d.setMonth(d.getMonth() + i); fwd[monthKey(d)] = 0; }
    const maxFwd = new Date(base); maxFwd.setMonth(maxFwd.getMonth() + 7);
    recs.forEach(r => {
      const d = parseDate(r.signOnDate);
      if (!d || d < base || d >= maxFwd) return;
      const k = monthKey(new Date(d.getFullYear(), d.getMonth(), 1));
      if (k in fwd) fwd[k]++;
    });
    drawBar('chartAssign', fwd);
  }

  function statCard(label, value, opts = {}) {
    const cls = 'card stat-card' + (opts.clickable ? ' stat-card--clickable' : '');
    const idAttr = opts.id ? ` id="${opts.id}"` : '';
    const titleAttr = opts.clickable ? ' title="Click to view"' : '';
    return `
      <div class="${cls}"${idAttr}${titleAttr}>
        <div class="stat-value">${value}</div>
        <div class="stat-label">${label}</div>
      </div>`;
  }

  function topN(obj, n) {
    return Object.fromEntries(
      Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  }

  // Draws each bar's value just above the bar, so the count is visible
  // without hovering.
  const barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      if (!meta || meta.hidden) return;
      const color = (getComputedStyle(document.documentElement)
        .getPropertyValue('--text') || '#e5e7eb').trim();
      ctx.save();
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      meta.data.forEach((bar, i) => {
        const v = chart.data.datasets[0].data[i];
        if (v == null) return;
        ctx.fillText(Number(v).toLocaleString(), bar.x, bar.y - 4);
      });
      ctx.restore();
    },
  };

  function drawBar(canvasId, obj, onClick) {
    const el = document.getElementById(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    const accent = CONFIG.ACCENT_COLOR || '#B01A18';
    const c = new Chart(el, {
      type: 'bar',
      data: {
        labels: Object.keys(obj),
        datasets: [{ data: Object.values(obj), backgroundColor: accent, borderRadius: 4 }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grace: '8%', ticks: { precision: 0 } } },
        responsive: true, maintainAspectRatio: false,
        onClick: onClick ? (evt, els) => { if (els.length) onClick(c.data.labels[els[0].index]); } : undefined,
        onHover: onClick ? (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; } : undefined,
      },
      plugins: [barValueLabels],
    });
    _charts.push(c);
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: VISA  (sub-tabs per visa type, chart-driven)
  //  Data merged: Candidates module per-visa fields + Visa Log sheet.
  // ═══════════════════════════════════════════════════════════
  const VISA_TABS = [
    // General documents (module-only — no sheet fallback).
    { key: 'passport', label: 'Passport',
      statusKey: 'passportStatus',    numberKey: 'passportNumber',    apptKey: null,
      expiryKey: 'passportExpiry',    expiryMonths: 18 },
    { key: 'bst',      label: 'BST',
      statusKey: 'bstStatus',         numberKey: 'bstNumber',         apptKey: null,
      expiryKey: 'bstExpiry' },
    { key: 'seaman',   label: "Seaman's Book",
      statusKey: 'seamanBookStatus',  numberKey: 'seamanBookNumber',  apptKey: null,
      expiryKey: 'seamanBookExpiry' },
    { key: 'medical',  label: 'Medical',
      statusKey: 'medicalStatus',     numberKey: null,                apptKey: null,
      expiryKey: 'medicalExpiry' },
    // Visas.
    { key: 'c1d',      label: 'C1/D',
      statusKey: 'c1dVisaStatus',   numberKey: 'c1dVisaNumber',   apptKey: 'c1dVisaAppointment',
      expiryKey: 'c1dVisaExpiry',   sheetType: /c1\s*\/?\s*d/i },
    { key: 'schengen', label: 'Schengen',
      statusKey: 'otherVisaStatus', numberKey: 'otherVisaNumber', apptKey: 'otherVisaAppointment',
      expiryKey: 'otherVisaExpiry', sheetType: /schengen/i,
      nameKey: 'otherVisaName',     nameMatch: /schengen/i,
      moduleOnly: true },   // Recruit module only — no Visa Log sheet fallback (excludes payment statuses)
    { key: 'mcv',      label: 'MCV',
      statusKey: 'mcvStatus',       numberKey: 'mcvNumber',       apptKey: null,
      expiryKey: 'mcvExpiry',       sheetType: /mcv/i },
    { key: 'oktb',     label: 'OKTB',
      statusKey: 'oktbStatus',      numberKey: null,              apptKey: null,
      expiryKey: null,              sheetType: /oktb/i },
  ];
  let _visaTab = 'passport';
  const DEFAULT_OFFICE = 'CTI Indonesia';
  // Onboarding statuses hidden from the whole dashboard (VISA + Records).
  const EXCLUDED_ONBOARDING = ['resigned', 'process by mss philippines'];
  const includeRecord = r => !EXCLUDED_ONBOARDING.includes(String(r.onboardingStatus).trim().toLowerCase());
  // office / cruiseLine / onboarding are arrays (multi-select). Empty = "all".
  // Office defaults to CTI Indonesia.
  const emptyFilters = () => ({ office: [DEFAULT_OFFICE], cruiseLine: [], onboarding: [], from: '', to: '' });
  let _visaFilters = emptyFilters();
  let _recFilters  = emptyFilters();
  let _recSort = { i: -1, dir: 1 };   // Records table sort (col index, direction)
  let _ovFilters = { office: [DEFAULT_OFFICE], cruiseLine: [] };   // Overview charts

  // Sort comparables shared by all sortable tables.
  const txtSort  = v => (v == null || v === '' || v === '—') ? '' : String(v).toLowerCase();
  const dateSort = d => d ? d.getTime() : null;   // null = missing, sorted last

  // Distinct non-empty values of a field, sorted (for filter dropdowns).
  function distinctVals(data, key) {
    return [...new Set(data.map(r => r[key]).filter(v => v && v !== '—'))]
      .sort((a, b) => String(a).localeCompare(String(b)));
  }

  // Apply the shared deployment filters (CTI office / cruise line / onboarding
  // status / sign-on date range) to the dataset. Fields are module-sourced.
  // office/cruiseLine/onboarding are arrays; an empty array means no filter.
  function applyDeployFilters(data, f) {
    const from = f.from ? new Date(f.from) : null;
    const to   = f.to   ? new Date(f.to)   : null;
    if (to) to.setHours(23, 59, 59, 999);
    const inSet = (arr, v) => !arr.length || arr.includes(v);
    return data.filter(r => {
      if (!inSet(f.office,     r.ctiOffice))       return false;
      if (!inSet(f.cruiseLine, r.cruiseLine))      return false;
      if (!inSet(f.onboarding, r.onboardingStatus)) return false;
      if (from || to) {
        const d = parseDate(r.signOnDate);
        if (!d) return false;
        if (from && d < from) return false;
        if (to   && d > to)   return false;
      }
      return true;
    });
  }

  function applyVisaFilters(data) {
    return applyDeployFilters(data, _visaFilters);
  }

  // ── Multi-select dropdown (button + checkbox panel) ────────────
  function msSummary(allLabel, sel) {
    return !sel.length ? allLabel : (sel.length === 1 ? sel[0] : `${sel.length} selected`);
  }
  function msHTML(id, allLabel, options, selected) {
    const sel = selected || [];
    return `<div class="ms" id="${id}" data-all="${esc(allLabel)}">
      <button type="button" class="ms-btn"><span class="ms-label">${esc(msSummary(allLabel, sel))}</span><span class="ms-caret">▾</span></button>
      <div class="ms-panel" hidden>
        ${options.map(o => `<label class="ms-opt"><input type="checkbox" value="${esc(o)}"${sel.includes(o) ? ' checked' : ''}><span>${esc(o)}</span></label>`).join('') || '<div class="ms-empty">No options</div>'}
      </div>
    </div>`;
  }
  function wireMS(root, id, onChange) {
    const el = root.querySelector('#' + id);
    if (!el) return;
    const btn = el.querySelector('.ms-btn');
    const panel = el.querySelector('.ms-panel');
    const label = el.querySelector('.ms-label');
    const allLabel = el.dataset.all;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = panel.hidden;
      document.querySelectorAll('.ms-panel').forEach(p => p.hidden = true);
      panel.hidden = !willOpen;
    });
    panel.addEventListener('click', e => e.stopPropagation());
    panel.querySelectorAll('input[type=checkbox]').forEach(cb =>
      cb.addEventListener('change', () => {
        const sel = [...panel.querySelectorAll('input:checked')].map(x => x.value);
        label.textContent = msSummary(allLabel, sel);
        onChange(sel);
      }));
  }

  // Effective status for a record under a visa tab: the module field
  // first, falling back to the Visa Log sheet when the module is blank.
  // Returns null when the seafarer has no record of that visa.
  function visaStatusOf(rec, tab) {
    let s = rec[tab.statusKey];
    // Schengen only counts when the "Other Visa" is actually Schengen.
    if (tab.nameMatch && !tab.nameMatch.test(String(rec[tab.nameKey] || ''))) s = '—';
    if (!tab.moduleOnly && (!s || s === '—') && tab.sheetType && tab.sheetType.test(String(rec.visaType || '')))
      s = rec.visaStatus;
    return (s && s !== '—') ? String(s) : null;
  }

  async function renderVisa() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();
    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    // Hide excluded onboarding statuses (Resigned, Process by MSS Philippines).
    const data = allData.filter(includeRecord);

    destroyCharts();
    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');
    const onboardings = distinctVals(data, 'onboardingStatus');

    mc.innerHTML = `
      <div class="page-header"><h1>Documents</h1></div>
      <div class="filter-bar">
        ${msHTML('fOffice', 'All CTI Offices', offices, _visaFilters.office)}
        ${msHTML('fLine', 'All Cruise Lines', cruiseLines, _visaFilters.cruiseLine)}
        ${msHTML('fOnboard', 'All Onboarding Status', onboardings, _visaFilters.onboarding)}
        <label class="filter-date">Sign On <input type="date" id="fFrom" value="${esc(_visaFilters.from)}"></label>
        <label class="filter-date">to <input type="date" id="fTo" value="${esc(_visaFilters.to)}"></label>
        <button class="btn-sm" id="fClear">Clear</button>
      </div>
      <div class="subtabs">
        ${VISA_TABS.map(t => `<button class="subtab ${t.key === _visaTab ? 'active' : ''}" data-visatab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div id="visaPanel"></div>`;

    const repaint = () => { destroyCharts(); paintVisaPanel(applyVisaFilters(data)); };

    mc.querySelectorAll('[data-visatab]').forEach(b =>
      b.addEventListener('click', () => {
        _visaTab = b.dataset.visatab;
        mc.querySelectorAll('[data-visatab]').forEach(x =>
          x.classList.toggle('active', x.dataset.visatab === _visaTab));
        repaint();
      }));

    wireMS(mc, 'fOffice',  sel => { _visaFilters.office = sel;     repaint(); });
    wireMS(mc, 'fLine',    sel => { _visaFilters.cruiseLine = sel; repaint(); });
    wireMS(mc, 'fOnboard', sel => { _visaFilters.onboarding = sel; repaint(); });
    const wire = (id, prop) => {
      const el = mc.querySelector('#' + id);
      el.addEventListener('change', () => { _visaFilters[prop] = el.value; repaint(); });
    };
    wire('fFrom', 'from'); wire('fTo', 'to');
    mc.querySelector('#fClear').addEventListener('click', () => {
      _visaFilters = emptyFilters();
      renderVisa();
    });

    repaint();
    updateStatus();
  }

  function paintVisaPanel(data) {
    const tab = VISA_TABS.find(t => t.key === _visaTab);
    const panel = document.getElementById('visaPanel');

    const holders = data.map(r => ({ r, s: visaStatusOf(r, tab) })).filter(x => x.s);
    const total = holders.length;
    // Status vocabulary in the module: Valid / Not Required / Need to
    // Process / In Process / Pending / Rejected / Approved.
    const isValid    = s => /valid|approv|issued|granted|complete|pass|board|ok to/i.test(s);
    const isProgress = s => /need|process|pending|progress|applied|appointment|schedul|await/i.test(s);
    const totalRows    = holders.map(x => x.r);
    const validRows    = holders.filter(x => isValid(x.s)).map(x => x.r);
    const progressRows = holders.filter(x => isProgress(x.s)).map(x => x.r);
    const valid = validRows.length, inProgress = progressRows.length;
    // Seafarers with no status set for this visa (empty field, dropped by visaStatusOf).
    const noStatusRows = data.filter(r => !visaStatusOf(r, tab));
    const noStatus = noStatusRows.length;

    const expiryMonths = tab.expiryMonths || 9;
    let expiringRows = [];
    if (tab.expiryKey) {
      const now = Date.now();
      const soonDate = new Date(); soonDate.setMonth(soonDate.getMonth() + expiryMonths);
      const soon = soonDate.getTime();
      // Only currently-Valid documents count as "expiring" — in-process /
      // need-to-process ones are already being worked on.
      expiringRows = holders
        .filter(x => isValid(x.s))
        .map(x => ({ r: x.r, t: (parseDate(x.r[tab.expiryKey]) || {}).getTime?.() }))
        .filter(x => x.t && x.t >= now && x.t <= soon)
        .sort((a, b) => a.t - b.t)   // soonest expiry first
        .map(x => x.r);
    }
    const expiring = expiringRows.length;

    // MCV only: passport-number mismatch (MCV passport no. vs passport no.).
    let unmatchedRows = [];
    if (tab.key === 'mcv') {
      const norm = v => String(v ?? '').trim().toUpperCase();
      const blank = s => s === '' || s === '—';
      unmatchedRows = holders
        .filter(x => isValid(x.s))   // only Valid MCV documents
        .map(x => x.r)
        .filter(r => {
          const a = norm(r.mcvPassportNumber), b = norm(r.passportNumber);
          if (blank(a) || blank(b)) return false;   // need both present to compare
          return a !== b;
        });
    }
    const unmatched = unmatchedRows.length;

    const byStatus = {};
    holders.forEach(x => { byStatus[x.s] = (byStatus[x.s] || 0) + 1; });

    panel.innerHTML = `
      <div class="stat-grid">
        ${statCard(`Total ${tab.label}`, total, { id: 'statTotal', clickable: total > 0 })}
        ${statCard('Valid', valid, { id: 'statValid', clickable: valid > 0 })}
        ${statCard('In Progress', inProgress, { id: 'statProgress', clickable: inProgress > 0 })}
        ${tab.expiryKey ? statCard(`Expiring < ${expiryMonths} months`, expiring, { id: 'statExpiring', clickable: expiring > 0 }) : statCard('No Status', noStatus, { id: 'statNoStatus', clickable: noStatus > 0 })}
        ${tab.key === 'mcv' ? statCard('Unmatched Passport', unmatched, { id: 'statUnmatched', clickable: unmatched > 0 }) : ''}
      </div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">${tab.label} — By Status ${total ? '<span class="hint">(click a bar to list those seafarers)</span>' : ''}</div>
          ${total ? `<canvas id="visaChart" height="240"></canvas>` : `<p class="empty-row">No ${tab.label} records found.</p>`}
        </div>
      </div>`;

    if (total) drawBar('visaChart', topN(byStatus, 8), status => showVisaDetail(holders, tab, status));

    // Stat tiles → drill down to the seafarers behind each count.
    const wireStat = (id, rows, title) => {
      const el = document.getElementById(id);
      if (el && rows.length) el.onclick = () => renderVisaDetail(rows, tab, title);
    };
    wireStat('statTotal',    totalRows,    `${tab.label} — All`);
    wireStat('statValid',    validRows,    `${tab.label} — Valid`);
    wireStat('statProgress', progressRows, `${tab.label} — In Progress`);
    wireStat('statExpiring', expiringRows, `${tab.label} — Expiring < ${expiryMonths} months`);
    wireStat('statNoStatus', noStatusRows, `${tab.label} — No Status`);

    // MCV: unmatched passport-number drill-down.
    const uCard = document.getElementById('statUnmatched');
    if (uCard && unmatched) {
      const uCols = [
        { label: 'ID Number',           render: r => esc(r.crewIdNumber),      sort: r => txtSort(r.crewIdNumber), w: 100 },
        { label: 'Name',                render: r => esc(r.name),              sort: r => txtSort(r.name),         w: 200, wrap: true },
        { label: 'MCV Passport Number', render: r => esc(r.mcvPassportNumber), sort: r => txtSort(r.mcvPassportNumber), w: 180 },
        { label: 'Passport Number',     render: r => esc(r.passportNumber),    sort: r => txtSort(r.passportNumber),    w: 160 },
        { label: 'MCV Status',          render: r => esc(r.mcvStatus),         sort: r => txtSort(r.mcvStatus),    w: 130 },
        { label: 'MCV Expiry',          render: r => formatDate(r.mcvExpiry),  sort: r => dateSort(parseDate(r.mcvExpiry)), num: true, w: 120 },
        { label: 'Sign On Date',        render: r => formatDate(r.signOnDate), sort: r => dateSort(parseDate(r.signOnDate)), num: true, w: 120 },
        { label: 'Sign Off Date',       render: r => formatDate(r.signOffDate),sort: r => dateSort(parseDate(r.signOffDate)), num: true, w: 120 },
        { label: 'Ship',                render: r => esc(r.joiningShip),       sort: r => txtSort(r.joiningShip),  w: 150 },
        { label: 'Joining Port',        render: r => esc(r.signOnPort),        sort: r => txtSort(r.signOnPort),   w: 140 },
      ];
      uCard.onclick = () => openDetailModal(unmatchedRows, uCols, `${tab.label} — Unmatched Passport Number`);
    }
  }

  // Drill-down: list the seafarers behind a clicked status bar.
  function showVisaDetail(holders, tab, status) {
    renderVisaDetail(holders.filter(x => x.s === status).map(x => x.r), tab,
      `${tab.label} — ${status}`);
  }

  // Render a drill-down detail table (in a modal) for a set of seafarer records.
  function renderVisaDetail(rows, tab, title) {
    // Each column: label, render(row) -> HTML, sort(row) -> comparable, num flag.
    const cols = [
      { label: 'Name',       render: r => `${esc(r.name)}<div class="cell-sub">${esc(r.email)}</div>`, sort: r => txtSort(r.name) },
      { label: 'CTI Office', render: r => esc(r.ctiOffice), sort: r => txtSort(r.ctiOffice) },
    ];
    if (tab.numberKey) cols.push({ label: 'Number',      render: r => esc(r[tab.numberKey]),      sort: r => txtSort(r[tab.numberKey]) });
    if (tab.apptKey)   cols.push({ label: 'Appointment', render: r => formatDate(r[tab.apptKey]), sort: r => dateSort(parseDate(r[tab.apptKey])), num: true });
    if (tab.expiryKey) cols.push({ label: 'Expiry',      render: r => formatDate(r[tab.expiryKey]), sort: r => dateSort(parseDate(r[tab.expiryKey])), num: true });
    cols.push({ label: 'Ship',       render: r => esc(r.joiningShip),   sort: r => txtSort(r.joiningShip) });
    if (tab.key === 'oktb')
      cols.push({ label: 'Joining Port', render: r => esc(r.signOnPort), sort: r => txtSort(r.signOnPort) });
    cols.push({ label: 'Onboarding', render: r => esc(r.onboardingStatus), sort: r => txtSort(r.onboardingStatus) });
    cols.push({ label: 'Sign On',    render: r => formatDate(r.signOnDate),  sort: r => dateSort(parseDate(r.signOnDate)), num: true });
    cols.push({ label: 'Sign Off',   render: r => formatDate(r.signOffDate),      sort: r => dateSort(parseDate(r.signOffDate)),     num: true });

    openDetailModal(rows, cols, title);
  }

  // Generic sortable drill-down modal for any set of records + column defs.
  // cols: [{ label, render(row)->HTML, sort(row)->comparable, num? }]
  // tabs (optional): [{ label, rows }] — renders sub-tabs; `rows` param ignored.
  function openDetailModal(rows, cols, title, tabs) {
    const modal = document.getElementById('detailModal');
    const body  = document.getElementById('detailBody');
    if (!modal || !body) return;

    let activeTab = 0, sortI = -1, dir = 1;
    const curRows = () => tabs ? tabs[activeTab].rows : rows;

    // Fixed-width columns with ellipsis; full value on hover via title.
    // Columns may set `w` (px width) and `wrap:true` (show full value, wrapping).
    const cell = (c, r) => {
      const html = c.render(r);
      const txt  = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const cls = c.wrap ? ' class="cell-wrap"' : '';
      const st  = c.w ? ` style="width:${c.w}px"` : '';
      return `<td${cls}${st} title="${esc(txt)}">${html}</td>`;
    };

    const sortedRows = () => {
      const rws = curRows();
      if (sortI < 0) return rws;
      const c = cols[sortI];
      return rws.slice().sort((a, b) => {
        const x = c.sort(a), y = c.sort(b);
        const xe = (x === null || x === ''), ye = (y === null || y === '');
        if (xe && ye) return 0;
        if (xe) return 1;            // missing values always last
        if (ye) return -1;
        const cmp = c.num ? (x - y) : String(x).localeCompare(String(y));
        return cmp * dir;
      });
    };

    const headHtml = () => `<tr>${cols.map((c, i) => {
      const arrow = i === sortI ? `<span class="sort-arrow">${dir > 0 ? '▲' : '▼'}</span>` : '';
      const st = c.w ? ` style="width:${c.w}px"` : '';
      return `<th class="sortable" data-i="${i}"${st}>${c.label}${arrow}</th>`;
    }).join('')}</tr>`;

    const render = () => {
      // Header count: total across all tabs (not just the active one).
      const n = tabs ? tabs.reduce((s, t) => s + t.rows.length, 0) : curRows().length;
      const subtabs = tabs ? `<div class="subtabs" style="padding:8px 22px 0;margin:0;">${
        tabs.map((t, i) => `<button class="subtab ${i === activeTab ? 'active' : ''}" data-dtab="${i}">${esc(t.label)} · ${t.rows.length}</button>`).join('')
      }</div>` : '';
      body.innerHTML = `
        <div class="modal-detail-head">
          <span><b>${esc(title)}</b><span class="count">· ${n} seafarer${n === 1 ? '' : 's'}</span></span>
          <button class="btn-sm" id="detailClose">Close</button>
        </div>
        ${subtabs}
        <div class="modal-detail-body">
          <div class="table-wrap detail-wrap"><table class="data-table detail-table">
            <thead>${headHtml()}</thead>
            <tbody>${sortedRows().map(r => `<tr>${cols.map(c => cell(c, r)).join('')}</tr>`).join('')}</tbody>
          </table></div>
        </div>`;
      document.getElementById('detailClose').onclick = closeDetail;
      body.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
        const i = +th.dataset.i;
        if (i === sortI) dir = -dir; else { sortI = i; dir = 1; }
        render();
      });
      body.querySelectorAll('[data-dtab]').forEach(b => b.onclick = () => {
        activeTab = +b.dataset.dtab; sortI = -1; dir = 1; render();
      });
    };

    modal.classList.add('show');
    render();
  }

  function closeDetail() { document.getElementById('detailModal').classList.remove('show'); }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: RECORDS  (table + edit → push)
  // ═══════════════════════════════════════════════════════════
  async function renderRecords() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();

    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    // Hide excluded onboarding statuses (Resigned, Process by MSS Philippines).
    const data = allData.filter(includeRecord);

    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');
    const onboardings = distinctVals(data, 'onboardingStatus');

    // Records columns: label, render(row) -> HTML, sort(row) -> comparable, num.
    const cols = [
      { label: 'ID Number',             render: r => esc(r.crewIdNumber),      sort: r => txtSort(r.crewIdNumber) },
      { label: 'Seafarer Name',         render: r => esc(r.name),              sort: r => txtSort(r.name) },
      { label: 'Joining Ship',          render: r => esc(r.joiningShip),      sort: r => txtSort(r.joiningShip) },
      { label: 'Sign On Port',          render: r => esc(r.signOnPort),        sort: r => txtSort(r.signOnPort) },
      { label: 'Sign On Date',          render: r => formatDate(r.signOnDate), sort: r => dateSort(parseDate(r.signOnDate)), num: true },
      { label: 'Onboarding Status',     render: r => esc(r.onboardingStatus),  sort: r => txtSort(r.onboardingStatus) },
      { label: 'Passport Status',       render: r => esc(r.passportStatus),    sort: r => txtSort(r.passportStatus) },
      { label: 'BST Status',            render: r => esc(r.bstStatus),         sort: r => txtSort(r.bstStatus) },
      { label: 'Seaman Book Status',    render: r => esc(r.seamanBookStatus),  sort: r => txtSort(r.seamanBookStatus) },
      { label: 'Medical Status',        render: r => esc(r.medicalStatus),     sort: r => txtSort(r.medicalStatus) },
      { label: 'C1/D Visa Status',      render: r => esc(r.c1dVisaStatus),     sort: r => txtSort(r.c1dVisaStatus) },
      { label: 'OKTB Status',           render: r => esc(r.oktbStatus),        sort: r => txtSort(r.oktbStatus) },
      { label: 'MCV Status',            render: r => esc(r.mcvStatus),         sort: r => txtSort(r.mcvStatus) },
      { label: 'Completed Vaccination', render: r => esc(r.vaccinesStatus),    sort: r => txtSort(r.vaccinesStatus) },
      { label: 'Other Visa Status',     render: r => esc(r.otherVisaStatus),   sort: r => txtSort(r.otherVisaStatus) },
      { label: 'Other Visa Issued Date',render: r => formatDate(r.otherVisaIssuedDate), sort: r => dateSort(parseDate(r.otherVisaIssuedDate)), num: true },
    ];

    const stickyCls = i => i < 2 ? ` sticky-col sticky-col-${i + 1}` : '';
    const headHtml = () => `<tr>${cols.map((c, i) => {
      const arrow = i === _recSort.i ? `<span class="sort-arrow">${_recSort.dir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th class="sortable${stickyCls(i)}" data-i="${i}">${c.label}${arrow}</th>`;
    }).join('')}</tr>`;

    mc.innerHTML = `
      <div class="page-header"><h1>Records</h1></div>
      <div class="filter-bar">
        ${msHTML('rOffice', 'All CTI Offices', offices, _recFilters.office)}
        ${msHTML('rLine', 'All Cruise Lines', cruiseLines, _recFilters.cruiseLine)}
        ${msHTML('rOnboard', 'All Onboarding Status', onboardings, _recFilters.onboarding)}
        <label class="filter-date">Sign On <input type="date" id="rFrom" value="${esc(_recFilters.from)}"></label>
        <label class="filter-date">to <input type="date" id="rTo" value="${esc(_recFilters.to)}"></label>
        <button class="btn-sm" id="rClear">Clear</button>
      </div>
      <div class="toolbar">
        <input type="search" id="recSearch" class="search-input"
               placeholder="Search name, email, ID, port, status…" value="${esc(_search)}">
        <span class="rec-count" id="recCount"></span>
      </div>
      <div class="card table-card">
        <div class="table-wrap"><table class="data-table records-table">
          <thead id="recHead">${headHtml()}</thead>
          <tbody id="recBody"></tbody>
        </table></div>
      </div>`;

    const paint = () => {
      let rows = recFiltered(data);
      if (_recSort.i >= 0) {
        const c = cols[_recSort.i];
        rows = rows.slice().sort((a, b) => {
          const x = c.sort(a), y = c.sort(b);
          const xe = (x === null || x === ''), ye = (y === null || y === '');
          if (xe && ye) return 0;
          if (xe) return 1;
          if (ye) return -1;
          return (c.num ? (x - y) : String(x).localeCompare(String(y))) * _recSort.dir;
        });
      }
      const cnt = document.getElementById('recCount');
      if (cnt) cnt.textContent = `${rows.length.toLocaleString()} record${rows.length === 1 ? '' : 's'}`;
      document.getElementById('recHead').innerHTML = headHtml();
      paintRows(rows, cols);
      document.querySelectorAll('#recHead th.sortable').forEach(th =>
        th.onclick = () => {
          const i = +th.dataset.i;
          if (i === _recSort.i) _recSort.dir = -_recSort.dir; else { _recSort.i = i; _recSort.dir = 1; }
          paint();
        });
    };

    wireMS(mc, 'rOffice',  sel => { _recFilters.office = sel;     paint(); });
    wireMS(mc, 'rLine',    sel => { _recFilters.cruiseLine = sel; paint(); });
    wireMS(mc, 'rOnboard', sel => { _recFilters.onboarding = sel; paint(); });
    const wire = (id, prop) => {
      const el = mc.querySelector('#' + id);
      el.addEventListener('change', () => { _recFilters[prop] = el.value; paint(); });
    };
    wire('rFrom', 'from'); wire('rTo', 'to');
    mc.querySelector('#rClear').addEventListener('click', () => {
      _recFilters = emptyFilters();
      renderRecords();
    });
    mc.querySelector('#recSearch')
      .addEventListener('input', e => { _search = e.target.value; paint(); });

    paint();
    updateStatus();
  }

  // Records dataset filtered by the shared deployment filters + the search box.
  function recFiltered(data) {
    let rows = applyDeployFilters(data, _recFilters);
    const q = _search.trim().toLowerCase();
    if (q) rows = rows.filter(r =>
      [r.name, r.email, r.ctiOffice, r.crewIdNumber, r.joiningShip, r.signOnPort,
       r.onboardingStatus, r.passportNumber, r.passportStatus, r.mcvPassportNumber,
       r.c1dVisaStatus, r.oktbStatus, r.mcvStatus, r.otherVisaStatus]
        .some(v => String(v).toLowerCase().includes(q)));
    return rows;
  }

  function paintRows(rows, cols) {
    const tbody = document.getElementById('recBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty-row">No records match.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r =>
      `<tr>${cols.map((c, i) => {
        const html = c.render(r);
        if (i < 2) return `<td class="sticky-col sticky-col-${i + 1}" title="${String(html).replace(/<[^>]*>/g, '')}">${html}</td>`;
        return `<td>${html}</td>`;
      }).join('')}</tr>`
    ).join('');
  }

  // ── Edit modal → push Recruit status; all detail from the module ────
  function openEdit(rec) {
    const modal = document.getElementById('editModal');
    const body  = document.getElementById('editBody');

    const info = (label, val) =>
      `<div class="info-row"><span>${label}</span><b>${esc(val ?? '—')}</b></div>`;

    body.innerHTML = `
      <h2>${esc(rec.name)}</h2>
      <p class="modal-sub">${esc(rec.email)}${rec.ctiOffice && rec.ctiOffice !== '—' ? ' · ' + esc(rec.ctiOffice) : ''}</p>

      <div class="form-section-label">Zoho Recruit — Seafarers</div>
      <label>Seafarer Status</label>
      <input id="f_status" value="${esc(rec.status === '—' ? '' : rec.status)}">

      <div class="form-section-label">Deployment</div>
      ${info('Cruise Line', rec.cruiseLine)}
      ${info('Joining Ship', rec.joiningShip)}
      ${info('Onboarding Status', rec.onboardingStatus)}
      ${info('Employment Status', rec.employmentStatus)}
      ${info('Sign On Date', formatDate(rec.signOnDate))}
      ${info('Sign On Port', rec.signOnPort)}
      ${info('Sign Off Date', formatDate(rec.signOffDate))}

      <div class="form-section-label">Documents</div>
      ${info('Passport Status', rec.passportStatus)}
      ${info('Passport Number', rec.passportNumber)}
      ${info('Passport Expiry', formatDate(rec.passportExpiry))}
      ${info('Medical Status', rec.medicalStatus)}
      ${info('Medical Expiry', formatDate(rec.medicalExpiry))}
      ${info('BST Status', rec.bstStatus)}
      ${info('Seaman Book Status', rec.seamanBookStatus)}
      ${info('Completed Vaccination', rec.vaccinesStatus)}

      <div class="form-section-label">Visas</div>
      ${info('C1/D Visa Status', rec.c1dVisaStatus)}
      ${info('C1/D Visa Number', rec.c1dVisaNumber)}
      ${info('C1/D Visa Expiry', formatDate(rec.c1dVisaExpiry))}
      ${info('MCV Status', rec.mcvStatus)}
      ${info('MCV Number', rec.mcvNumber)}
      ${info("MCV's Passport Number", rec.mcvPassportNumber)}
      ${info('MCV Expiry', formatDate(rec.mcvExpiry))}
      ${info('OKTB Status', rec.oktbStatus)}
      ${info('Other Visa Name', rec.otherVisaName)}
      ${info('Other Visa Status', rec.otherVisaStatus)}
      ${info('Other Visa Number', rec.otherVisaNumber)}
      ${info('Other Visa Issued Date', formatDate(rec.otherVisaIssuedDate))}
      ${info('Other Visa Expiry', formatDate(rec.otherVisaExpiry))}

      <div class="modal-actions">
        <button class="btn-secondary" id="cancelEdit">Cancel</button>
        <button class="btn-primary" id="saveEdit">Save</button>
      </div>`;

    modal.classList.add('show');
    document.getElementById('cancelEdit').onclick = closeEdit;
    document.getElementById('saveEdit').onclick   = () => saveEdit(rec);
  }

  function closeEdit() { document.getElementById('editModal').classList.remove('show'); }

  async function saveEdit(rec) {
    const btn = document.getElementById('saveEdit');
    btn.disabled = true; btn.textContent = 'Saving…';

    const F = CONFIG.FIELDS;
    const newStatus = document.getElementById('f_status').value.trim();

    // Nothing changed → just close.
    if (!newStatus || newStatus === rec.status) { closeEdit(); return; }

    try {
      await Zoho.updateRecruit(rec, { id: rec.id, [F.status]: newStatus });
    } catch (err) {
      toast(`Save failed: ${err.message || 'unknown error'}`, 'error');
      btn.disabled = false; btn.textContent = 'Save';
      return;
    }

    toast('Saved successfully', 'success');
    closeEdit();
    await refresh();  // re-pull so the table reflects both sources
  }

  // ── Router ──────────────────────────────────────────────────
  const ROUTES = { overview: renderOverview, records: renderRecords, documents: renderVisa, visa: renderVisa };
  const TITLES = { overview: 'Overview', records: 'Records', documents: 'Documents', visa: 'Documents' };

  function currentPage() {
    const p = (location.hash || '#overview').slice(1);
    return ROUTES[p] ? p : 'overview';
  }

  function renderCurrentPage() {
    const page = currentPage();
    document.querySelectorAll('.nav-link').forEach(a =>
      a.classList.toggle('active', a.dataset.page === page));
    const tb = document.getElementById('topbarTitle');
    if (tb) tb.textContent = TITLES[page];
    ROUTES[page]();
  }

  // Manual/post-save refresh: refetch in the background, keeping the
  // current data on screen (no skeleton flash), then repaint.
  async function refresh() {
    try { await fetchFresh(); renderCurrentPage(); }
    catch (err) { toast(`Refresh failed: ${err.message}`, 'error'); }
  }

  function init() {
    document.querySelectorAll('.nav-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        location.hash = a.dataset.page;
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarOverlay')?.classList.remove('show');
      });
    });
    window.addEventListener('hashchange', renderCurrentPage);
    // Close any open multi-select panel when clicking elsewhere.
    document.addEventListener('click', () =>
      document.querySelectorAll('.ms-panel').forEach(p => p.hidden = true));
    // Drill-down modal: close on backdrop click or Escape.
    const detailModal = document.getElementById('detailModal');
    detailModal?.addEventListener('click', e => { if (e.target === detailModal) closeDetail(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && detailModal?.classList.contains('show')) closeDetail();
    });
    // Auto-refresh every 5 minutes — in the background, no skeleton.
    setInterval(revalidate, 300000);
    renderCurrentPage();
  }

  return { init, refresh, _toast: toast };
})();

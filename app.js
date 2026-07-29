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
    if (!c || !Array.isArray(c.records) || (Date.now() - c.ts) > CACHE_TTL) return null;
    return c;
  }

  async function fetchFresh() {
    _records = await Zoho.getAllRecords();
    _lastUpdated = Date.now();
    idbSet(CACHE_KEY, { ts: _lastUpdated, records: _records });  // fire and forget
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

    const data = await loadData();
    if (!data) { mc.innerHTML = errorHTML(); return; }

    const total     = data.length;
    const visaLogged= data.filter(r => r._sheetRows?.visa).length;
    const deployed  = data.filter(r => r._sheetRows?.cruise).length;
    const byStatus  = Zoho.groupBy(data, 'status');
    const byOffice  = Zoho.groupBy(data, 'ctiOffice');
    const active    = Object.entries(byStatus)
      .filter(([k]) => /active|progress|pending|onboard|hired|assigned|deployed|sign/i.test(k))
      .reduce((n, [, v]) => n + v, 0);

    destroyCharts();
    mc.innerHTML = `
      <div class="page-header"><h1>Overview</h1></div>
      <div class="stat-grid">
        ${statCard('Total Seafarers', total)}
        ${statCard('Visa Logged', visaLogged)}
        ${statCard('Deployed', deployed)}
        ${statCard('Active / In Progress', active)}
      </div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">By Status</div>
          <canvas id="chartStatus" height="220"></canvas>
        </div>
        <div class="card chart-card">
          <div class="card-title">By CTI Office</div>
          <canvas id="chartOffice" height="220"></canvas>
        </div>
      </div>`;

    drawBar('chartStatus', topN(byStatus, 10));
    drawBar('chartOffice', topN(byOffice, 8));
    updateStatus();
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
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        responsive: true, maintainAspectRatio: false,
        onClick: onClick ? (evt, els) => { if (els.length) onClick(c.data.labels[els[0].index]); } : undefined,
        onHover: onClick ? (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; } : undefined,
      },
    });
    _charts.push(c);
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: VISA  (sub-tabs per visa type, chart-driven)
  //  Data merged: Candidates module per-visa fields + Visa Log sheet.
  // ═══════════════════════════════════════════════════════════
  const VISA_TABS = [
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
  let _visaTab = 'c1d';
  const emptyFilters = () => ({ office: '', cruiseLine: '', onboarding: '', from: '', to: '' });
  let _visaFilters = emptyFilters();
  let _recFilters  = emptyFilters();

  // Distinct non-empty values of a field, sorted (for filter dropdowns).
  function distinctVals(data, key) {
    return [...new Set(data.map(r => r[key]).filter(v => v && v !== '—'))]
      .sort((a, b) => String(a).localeCompare(String(b)));
  }

  // Apply the shared deployment filters (CTI office / cruise line / onboarding
  // status / sign-on date range) to the dataset. Fields are module-sourced.
  function applyDeployFilters(data, f) {
    const from = f.from ? new Date(f.from) : null;
    const to   = f.to   ? new Date(f.to)   : null;
    if (to) to.setHours(23, 59, 59, 999);
    return data.filter(r => {
      if (f.office     && r.ctiOffice       !== f.office)     return false;
      if (f.cruiseLine && r.cruiseLine       !== f.cruiseLine) return false;
      if (f.onboarding && r.onboardingStatus !== f.onboarding) return false;
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
    // Exclude seafarers whose onboarding status is "Resigned" from the VISA page.
    const data = allData.filter(r => String(r.onboardingStatus).trim().toLowerCase() !== 'resigned');

    destroyCharts();
    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');
    const onboardings = distinctVals(data, 'onboardingStatus');
    const opts = (arr, sel) =>
      arr.map(v => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');

    mc.innerHTML = `
      <div class="page-header"><h1>Visa</h1></div>
      <div class="subtabs">
        ${VISA_TABS.map(t => `<button class="subtab ${t.key === _visaTab ? 'active' : ''}" data-visatab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div class="filter-bar">
        <select id="fOffice"><option value="">All CTI Offices</option>${opts(offices, _visaFilters.office)}</select>
        <select id="fLine"><option value="">All Cruise Lines</option>${opts(cruiseLines, _visaFilters.cruiseLine)}</select>
        <select id="fOnboard"><option value="">All Onboarding Status</option>${opts(onboardings, _visaFilters.onboarding)}</select>
        <label class="filter-date">Sign On <input type="date" id="fFrom" value="${esc(_visaFilters.from)}"></label>
        <label class="filter-date">to <input type="date" id="fTo" value="${esc(_visaFilters.to)}"></label>
        <button class="btn-sm" id="fClear">Clear</button>
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

    const wire = (id, prop) => {
      const el = mc.querySelector('#' + id);
      el.addEventListener('change', () => { _visaFilters[prop] = el.value; repaint(); });
    };
    wire('fOffice', 'office'); wire('fLine', 'cruiseLine'); wire('fOnboard', 'onboarding');
    wire('fFrom', 'from'); wire('fTo', 'to');
    mc.querySelector('#fClear').addEventListener('click', () => {
      _visaFilters = { office: '', cruiseLine: '', onboarding: '', from: '', to: '' };
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

    let expiringRows = [];
    if (tab.expiryKey) {
      const now = Date.now();
      const soonDate = new Date(); soonDate.setMonth(soonDate.getMonth() + 9);
      const soon = soonDate.getTime();
      expiringRows = holders
        .map(x => ({ r: x.r, t: (parseDate(x.r[tab.expiryKey]) || {}).getTime?.() }))
        .filter(x => x.t && x.t >= now && x.t <= soon)
        .sort((a, b) => a.t - b.t)   // soonest expiry first
        .map(x => x.r);
    }
    const expiring = expiringRows.length;

    const byStatus = {};
    holders.forEach(x => { byStatus[x.s] = (byStatus[x.s] || 0) + 1; });

    panel.innerHTML = `
      <div class="stat-grid">
        ${statCard(`Total ${tab.label}`, total, { id: 'statTotal', clickable: total > 0 })}
        ${statCard('Valid', valid, { id: 'statValid', clickable: valid > 0 })}
        ${statCard('In Progress', inProgress, { id: 'statProgress', clickable: inProgress > 0 })}
        ${tab.expiryKey ? statCard('Expiring < 9 months', expiring, { id: 'statExpiring', clickable: expiring > 0 }) : statCard('No Status', noStatus, { id: 'statNoStatus', clickable: noStatus > 0 })}
      </div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">${tab.label} — By Status ${total ? '<span class="hint">(click a bar to list those seafarers)</span>' : ''}</div>
          ${total ? `<canvas id="visaChart" height="240"></canvas>` : `<p class="empty-row">No ${tab.label} visa records found.</p>`}
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
    wireStat('statExpiring', expiringRows, `${tab.label} — Expiring < 9 months`);
    wireStat('statNoStatus', noStatusRows, `${tab.label} — No Status`);
  }

  // Drill-down: list the seafarers behind a clicked status bar.
  function showVisaDetail(holders, tab, status) {
    renderVisaDetail(holders.filter(x => x.s === status).map(x => x.r), tab,
      `${tab.label} — ${status}`);
  }

  // Render a drill-down detail table (in a modal) for a set of seafarer records.
  function renderVisaDetail(rows, tab, title) {
    const modal = document.getElementById('detailModal');
    const body  = document.getElementById('detailBody');
    if (!modal || !body) return;

    const txtSort  = v => (v == null || v === '' || v === '—') ? '' : String(v).toLowerCase();
    const dateSort = d => d ? d.getTime() : null;   // null = missing, sorted last

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

    // Columns are fixed-width with ellipsis (no horizontal scroll); expose the
    // full value on hover via a title attribute (HTML stripped for plain text).
    const cell = (c, r) => {
      const html = c.render(r);
      const txt  = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return `<td title="${esc(txt)}">${html}</td>`;
    };

    let sortI = -1, dir = 1;   // no sort initially; dir 1 = asc, -1 = desc

    const sortedRows = () => {
      if (sortI < 0) return rows;
      const c = cols[sortI];
      return rows.slice().sort((a, b) => {
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
      return `<th class="sortable" data-i="${i}">${c.label}${arrow}</th>`;
    }).join('')}</tr>`;

    const bodyHtml = () => sortedRows().map(r => `<tr>${cols.map(c => cell(c, r)).join('')}</tr>`).join('');

    const repaint = () => {
      body.querySelector('thead').innerHTML = headHtml();
      body.querySelector('tbody').innerHTML = bodyHtml();
      wireHeads();
    };

    const wireHeads = () => body.querySelectorAll('th.sortable').forEach(th => {
      th.onclick = () => {
        const i = +th.dataset.i;
        if (i === sortI) dir = -dir; else { sortI = i; dir = 1; }
        repaint();
      };
    });

    body.innerHTML = `
      <div class="modal-detail-head">
        <span><b>${esc(title)}</b><span class="count">· ${rows.length} seafarer${rows.length === 1 ? '' : 's'}</span></span>
        <button class="btn-sm" id="detailClose">Close</button>
      </div>
      <div class="modal-detail-body">
        <div class="table-wrap detail-wrap"><table class="data-table detail-table">
          <thead>${headHtml()}</thead>
          <tbody>${bodyHtml()}</tbody>
        </table></div>
      </div>`;

    modal.classList.add('show');
    document.getElementById('detailClose').onclick = closeDetail;
    wireHeads();
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
    // Exclude "Resigned" onboarding status, same as the VISA page.
    const data = allData.filter(r => String(r.onboardingStatus).trim().toLowerCase() !== 'resigned');

    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');
    const onboardings = distinctVals(data, 'onboardingStatus');
    const opts = (arr, sel) =>
      arr.map(v => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');

    mc.innerHTML = `
      <div class="page-header"><h1>Records</h1></div>
      <div class="filter-bar">
        <select id="rOffice"><option value="">All CTI Offices</option>${opts(offices, _recFilters.office)}</select>
        <select id="rLine"><option value="">All Cruise Lines</option>${opts(cruiseLines, _recFilters.cruiseLine)}</select>
        <select id="rOnboard"><option value="">All Onboarding Status</option>${opts(onboardings, _recFilters.onboarding)}</select>
        <label class="filter-date">Sign On <input type="date" id="rFrom" value="${esc(_recFilters.from)}"></label>
        <label class="filter-date">to <input type="date" id="rTo" value="${esc(_recFilters.to)}"></label>
        <button class="btn-sm" id="rClear">Clear</button>
      </div>
      <div class="toolbar">
        <input type="search" id="recSearch" class="search-input"
               placeholder="Search name, email, city, status…" value="${esc(_search)}">
      </div>
      <div class="card table-card">
        <div class="table-wrap"><table class="data-table">
          <thead><tr>
            <th>Joining Ship</th><th>Sign On Date</th><th>Sign On Port</th><th>Onboarding Status</th>
            <th>Seafarer Name</th><th>Seafarer ID Number</th><th>Passport Status</th><th>BST Status</th>
            <th>Seaman Book Status</th><th>Medical Status</th><th>C1/D Visa Status</th><th>OKTB Status</th>
            <th>MCV Status</th><th>MCV's Passport Number</th><th>Passport Number</th><th>Completed Vaccination</th>
            <th>Other Visa Status</th><th>Other Visa Issued Date</th><th></th>
          </tr></thead>
          <tbody id="recBody"></tbody>
        </table></div>
      </div>`;

    const paint = () => paintRows(recFiltered(data));

    const wire = (id, prop) => {
      const el = mc.querySelector('#' + id);
      el.addEventListener('change', () => { _recFilters[prop] = el.value; paint(); });
    };
    wire('rOffice', 'office'); wire('rLine', 'cruiseLine'); wire('rOnboard', 'onboarding');
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

  function paintRows(rows) {
    const tbody = document.getElementById('recBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="19" class="empty-row">No records match.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.joiningShip)}</td>
        <td>${formatDate(r.signOnDate)}</td>
        <td>${esc(r.signOnPort)}</td>
        <td>${esc(r.onboardingStatus)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.crewIdNumber)}</td>
        <td>${esc(r.passportStatus)}</td>
        <td>${esc(r.bstStatus)}</td>
        <td>${esc(r.seamanBookStatus)}</td>
        <td>${esc(r.medicalStatus)}</td>
        <td>${esc(r.c1dVisaStatus)}</td>
        <td>${esc(r.oktbStatus)}</td>
        <td>${esc(r.mcvStatus)}</td>
        <td>${esc(r.mcvPassportNumber)}</td>
        <td>${esc(r.passportNumber)}</td>
        <td>${esc(r.vaccinesStatus)}</td>
        <td>${esc(r.otherVisaStatus)}</td>
        <td>${formatDate(r.otherVisaIssuedDate)}</td>
        <td><button class="btn-sm" data-edit="${_records.indexOf(r)}">Edit</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEdit(_records[+b.dataset.edit])));
  }

  // ── Edit modal → push Recruit status; show merged sheets ────
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

      <div class="form-section-label">Visa Registration Log</div>
      ${info('Visa Type', rec.visaType)}
      ${info('Visa Status', rec.visaStatus)}
      ${info('Payment Status', rec.visaPayment)}
      ${info('Appointment Date', formatSheetDate(rec.visaAppointment))}
      ${info('Application ID', rec.visaAppId)}
      ${info('Registered', formatSheetDate(rec.visaRegDate))}

      <div class="form-section-label">Cruise Line Deployment</div>
      ${info('Cruise Line', rec.deployCruiseLine)}
      ${info('Ship', rec.deployShip)}
      ${info('Position Hired', rec.deployPosition)}
      ${info('Onboarding Status', rec.deployStatus)}
      ${info('Employment Status', rec.deployEmployment)}
      ${info('Sign On Date', formatSheetDate(rec.deployDate))}
      ${info('Sign On Port', rec.deployPort)}

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
  const ROUTES = { overview: renderOverview, records: renderRecords, visa: renderVisa };
  const TITLES = { overview: 'Overview', records: 'Records', visa: 'Visa' };

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

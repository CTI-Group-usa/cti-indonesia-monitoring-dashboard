// ─────────────────────────────────────────────────────────────
//  APP — SPA router + pages (Overview, Records)
//  Pull: merged Recruit + Sheet data. Push: edit → write back.
// ─────────────────────────────────────────────────────────────
const App = (() => {

  let _records = null;   // cached merged data
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

  function formatDate(str) {
    if (!str || str === '—') return '—';
    const d = new Date(str);
    if (isNaN(d)) return str;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function destroyCharts() { _charts.forEach(c => c.destroy()); _charts = []; }

  function updateStatus() {
    const el = document.getElementById('zohoStatus');
    if (!el) return;
    el.className = 'zoho-status connected';
    el.innerHTML = `<span class="dot"></span> Live Data`;
    el.title = 'Click to refresh';
    el.onclick = () => refresh();
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

  // ── Data load (stale-while-revalidate) ──────────────────────
  // On refresh the SPA reboots and _records is null; rather than
  // re-fetch everything (slow), we render instantly from a session
  // cache and revalidate in the background.
  const CACHE_KEY = 'cti_indo_records';
  const CACHE_TTL = 30 * 60 * 1000; // 30 min

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { ts, records } = JSON.parse(raw);
      if (!Array.isArray(records) || (Date.now() - ts) > CACHE_TTL) return null;
      return records;
    } catch { return null; }
  }
  function writeCache(records) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), records })); }
    catch { /* quota exceeded — skip caching, still works (just slower) */ }
  }

  async function fetchFresh() {
    _records = await Zoho.getAllRecords();
    writeCache(_records);
    return _records;
  }

  function revalidate() {
    fetchFresh().then(() => renderCurrentPage()).catch(() => {});
  }

  async function loadData(force = false) {
    if (_records && !force) return _records;
    if (!force) {
      const cached = readCache();
      if (cached) { _records = cached; revalidate(); return _records; }
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

  function statCard(label, value) {
    return `
      <div class="card stat-card">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${label}</div>
      </div>`;
  }

  function topN(obj, n) {
    return Object.fromEntries(
      Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  }

  function drawBar(canvasId, obj) {
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
      },
    });
    _charts.push(c);
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: VISA  (sub-tabs per visa type, chart-driven)
  //  Data merged: Candidates module per-visa fields + Visa Log sheet.
  // ═══════════════════════════════════════════════════════════
  const VISA_TABS = [
    { key: 'c1d',      label: 'C1D',
      statusKey: 'c1dVisaStatus',   expiryKey: 'c1dVisaExpiry',   sheetType: /c1\s*\/?\s*d/i },
    { key: 'schengen', label: 'Schengen',
      statusKey: 'otherVisaStatus', expiryKey: 'otherVisaExpiry', sheetType: /schengen/i,
      nameKey: 'otherVisaName',     nameMatch: /schengen/i },
    { key: 'mcv',      label: 'MCV',
      statusKey: 'mcvStatus',       expiryKey: 'mcvExpiry',       sheetType: /mcv/i },
    { key: 'oktb',     label: 'OKTB',
      statusKey: 'oktbStatus',      expiryKey: null,              sheetType: /oktb/i },
  ];
  let _visaTab = 'c1d';
  let _visaFilters = { office: '', cruiseLine: '', onboarding: '', from: '', to: '' };

  // Distinct non-empty values of a field, sorted (for filter dropdowns).
  function distinctVals(data, key) {
    return [...new Set(data.map(r => r[key]).filter(v => v && v !== '—'))]
      .sort((a, b) => String(a).localeCompare(String(b)));
  }

  // Apply the shared VISA filters (CTI office / cruise line / onboarding
  // status / sign-on date range) to the dataset.
  function applyVisaFilters(data) {
    const f = _visaFilters;
    const from = f.from ? new Date(f.from) : null;
    const to   = f.to   ? new Date(f.to)   : null;
    if (to) to.setHours(23, 59, 59, 999);
    return data.filter(r => {
      if (f.office     && r.ctiOffice        !== f.office)     return false;
      if (f.cruiseLine && r.deployCruiseLine !== f.cruiseLine) return false;
      if (f.onboarding && r.deployStatus     !== f.onboarding) return false;
      if (from || to) {
        const d = new Date(r.deployDate);
        if (isNaN(d)) return false;
        if (from && d < from) return false;
        if (to   && d > to)   return false;
      }
      return true;
    });
  }

  // Effective status for a record under a visa tab: the module field
  // first, falling back to the Visa Log sheet when the module is blank.
  // Returns null when the seafarer has no record of that visa.
  function visaStatusOf(rec, tab) {
    let s = rec[tab.statusKey];
    // Schengen only counts when the "Other Visa" is actually Schengen.
    if (tab.nameMatch && !tab.nameMatch.test(String(rec[tab.nameKey] || ''))) s = '—';
    if ((!s || s === '—') && tab.sheetType && tab.sheetType.test(String(rec.visaType || '')))
      s = rec.visaStatus;
    return (s && s !== '—') ? String(s) : null;
  }

  async function renderVisa() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();
    const data = await loadData();
    if (!data) { mc.innerHTML = errorHTML(); return; }

    destroyCharts();
    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'deployCruiseLine');
    const onboardings = distinctVals(data, 'deployStatus');
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
    const valid      = holders.filter(x => isValid(x.s)).length;
    const inProgress = holders.filter(x => isProgress(x.s)).length;

    let expiring = 0;
    if (tab.expiryKey) {
      const now = Date.now(), soon = now + 90 * 86400000;
      expiring = holders.filter(x => {
        const d = new Date(x.r[tab.expiryKey]);
        return !isNaN(d) && d.getTime() >= now && d.getTime() <= soon;
      }).length;
    }

    const byStatus = {};
    holders.forEach(x => { byStatus[x.s] = (byStatus[x.s] || 0) + 1; });

    panel.innerHTML = `
      <div class="stat-grid">
        ${statCard(`Total ${tab.label}`, total)}
        ${statCard('Valid', valid)}
        ${statCard('In Progress', inProgress)}
        ${tab.expiryKey ? statCard('Expiring ≤90d', expiring) : statCard('Distinct statuses', Object.keys(byStatus).length)}
      </div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">${tab.label} — By Status</div>
          ${total ? `<canvas id="visaChart" height="240"></canvas>` : `<p class="empty-row">No ${tab.label} visa records found.</p>`}
        </div>
      </div>`;

    if (total) drawBar('visaChart', topN(byStatus, 8));
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: RECORDS  (table + edit → push)
  // ═══════════════════════════════════════════════════════════
  async function renderRecords() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();

    const data = await loadData();
    if (!data) { mc.innerHTML = errorHTML(); return; }

    mc.innerHTML = `
      <div class="page-header"><h1>Records</h1></div>
      <div class="toolbar">
        <input type="search" id="recSearch" class="search-input"
               placeholder="Search name, email, city, status…" value="${esc(_search)}">
      </div>
      <div class="card table-card">
        <div class="table-wrap"><table class="data-table">
          <thead><tr>
            <th>Name</th><th>CTI Office</th><th>Position</th><th>Seafarer Status</th>
            <th>Visa Status</th><th>Deployment</th><th></th>
          </tr></thead>
          <tbody id="recBody"></tbody>
        </table></div>
      </div>`;

    const input = document.getElementById('recSearch');
    input.addEventListener('input', e => { _search = e.target.value; paintRows(); });
    paintRows();
    updateStatus();
  }

  function filtered() {
    const q = _search.trim().toLowerCase();
    if (!q) return _records;
    return _records.filter(r =>
      [r.name, r.email, r.ctiOffice, r.country, r.position, r.status,
       r.visaStatus, r.deployCruiseLine, r.deployShip, r.deployStatus]
        .some(v => String(v).toLowerCase().includes(q)));
  }

  function paintRows() {
    const tbody = document.getElementById('recBody');
    if (!tbody) return;
    const rows = filtered();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No records match.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, i) => {
      const deployment = [r.deployCruiseLine, r.deployShip]
        .filter(v => v && v !== '—').join(' · ') || '—';
      return `
      <tr>
        <td>${esc(r.name)}<div class="cell-sub">${esc(r.email)}</div></td>
        <td>${esc(r.ctiOffice)}</td>
        <td>${esc(r.position)}</td>
        <td>${badge(r.status)}</td>
        <td>${badge(r.visaStatus)}</td>
        <td>${esc(deployment)}${r.deployStatus && r.deployStatus !== '—' ? `<div class="cell-sub">${esc(r.deployStatus)}</div>` : ''}</td>
        <td><button class="btn-sm" data-edit="${_records.indexOf(r)}">Edit</button></td>
      </tr>`;
    }).join('');
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
      ${info('Appointment Date', formatDate(rec.visaAppointment))}
      ${info('Application ID', rec.visaAppId)}
      ${info('Registered', formatDate(rec.visaRegDate))}

      <div class="form-section-label">Cruise Line Deployment</div>
      ${info('Cruise Line', rec.deployCruiseLine)}
      ${info('Ship', rec.deployShip)}
      ${info('Position Hired', rec.deployPosition)}
      ${info('Onboarding Status', rec.deployStatus)}
      ${info('Employment Status', rec.deployEmployment)}
      ${info('Sign On Date', formatDate(rec.deployDate))}
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
    // Auto-refresh every 10 minutes — in the background, no skeleton.
    setInterval(revalidate, 600000);
    renderCurrentPage();
  }

  return { init, refresh, _toast: toast };
})();

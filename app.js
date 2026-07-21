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

  // ── Data load (cached) ──────────────────────────────────────
  async function loadData(force = false) {
    if (_records && !force) return _records;
    try {
      _records = await Zoho.getAllRecords();
      return _records;
    } catch (err) {
      toast(`Failed to load: ${err.message}`, 'error');
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: OVERVIEW
  // ═══════════════════════════════════════════════════════════
  async function renderOverview() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();

    const data = await loadData();
    if (!data) { mc.innerHTML = errorHTML(); return; }

    const total    = data.length;
    const monitored= data.filter(r => r._hasSheetRow).length;
    const followUp = data.filter(r => r.followUpDate && r.followUpDate !== '—').length;
    const byStatus  = Zoho.groupBy(data, 'status');
    const byOffice  = Zoho.groupBy(data, 'ctiOffice');
    const active    = Object.entries(byStatus)
      .filter(([k]) => /active|progress|pending|onboard|hired|assigned|deployed|sign/i.test(k))
      .reduce((n, [, v]) => n + v, 0);

    destroyCharts();
    mc.innerHTML = `
      <div class="page-header"><h1>Overview</h1></div>
      <div class="stat-grid">
        ${statCard('Total Records', total)}
        ${statCard('In Monitoring', monitored)}
        ${statCard('Active / In Progress', active)}
        ${statCard('Follow-ups Set', followUp)}
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
            <th>Name</th><th>CTI Office</th><th>Country</th><th>Position</th>
            <th>Status</th><th>Monitoring</th><th>Follow Up</th><th></th>
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
      [r.name, r.email, r.ctiOffice, r.country, r.position, r.status, r.monitorStatus, r.handledBy]
        .some(v => String(v).toLowerCase().includes(q)));
  }

  function paintRows() {
    const tbody = document.getElementById('recBody');
    if (!tbody) return;
    const rows = filtered();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No records match.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td>${esc(r.name)}<div class="cell-sub">${esc(r.email)}</div></td>
        <td>${esc(r.ctiOffice)}</td>
        <td>${esc(r.country)}</td>
        <td>${esc(r.position)}</td>
        <td>${badge(r.status)}</td>
        <td>${badge(r.monitorStatus)}</td>
        <td>${formatDate(r.followUpDate)}</td>
        <td><button class="btn-sm" data-edit="${_records.indexOf(r)}">Edit</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEdit(_records[+b.dataset.edit])));
  }

  // ── Edit modal → push to Recruit + Sheet ────────────────────
  function openEdit(rec) {
    const F = CONFIG.FIELDS;
    const SC = CONFIG.SHEET.columns;
    const modal = document.getElementById('editModal');
    const body  = document.getElementById('editBody');

    body.innerHTML = `
      <h2>Edit — ${esc(rec.name)}</h2>
      <p class="modal-sub">${esc(rec.email)}</p>

      <div class="form-section-label">Zoho Recruit — Seafarers</div>
      <label>Seafarer Status</label>
      <input id="f_status" value="${esc(rec.status === '—' ? '' : rec.status)}">

      <div class="form-section-label">Monitoring (Zoho Sheet)</div>
      <label>Monitoring Status</label>
      <input id="s_monitorStatus" value="${esc(rec.monitorStatus === '—' ? '' : rec.monitorStatus)}">
      <label>Handled By</label>
      <input id="s_handledBy" value="${esc(rec.handledBy === '—' ? '' : rec.handledBy)}">
      <label>Follow Up Date</label>
      <input id="s_followUpDate" type="date" value="${toDateInput(rec.followUpDate)}">
      <label>Notes</label>
      <textarea id="s_notes" rows="3">${esc(rec.notes === '—' ? '' : rec.notes)}</textarea>

      <div class="modal-actions">
        <button class="btn-secondary" id="cancelEdit">Cancel</button>
        <button class="btn-primary" id="saveEdit">Save</button>
      </div>`;

    modal.classList.add('show');
    document.getElementById('cancelEdit').onclick = closeEdit;
    document.getElementById('saveEdit').onclick   = () => saveEdit(rec);
  }

  function closeEdit() { document.getElementById('editModal').classList.remove('show'); }

  function toDateInput(str) {
    if (!str || str === '—') return '';
    const d = new Date(str);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  async function saveEdit(rec) {
    const btn = document.getElementById('saveEdit');
    btn.disabled = true; btn.textContent = 'Saving…';

    const F  = CONFIG.FIELDS;
    const SC = CONFIG.SHEET.columns;

    const newStatus   = document.getElementById('f_status').value.trim();
    const sheetData   = {
      [SC.monitorStatus]: document.getElementById('s_monitorStatus').value.trim(),
      [SC.handledBy]:     document.getElementById('s_handledBy').value.trim(),
      [SC.followUpDate]:  document.getElementById('s_followUpDate').value,
      [SC.notes]:         document.getElementById('s_notes').value.trim(),
    };

    const tasks = [];
    // Push to Recruit only if the status actually changed.
    if (newStatus && newStatus !== rec.status)
      tasks.push(Zoho.updateRecruit(rec, { id: rec.id, [F.status]: newStatus }));
    // Push monitoring fields to the Sheet.
    tasks.push(Zoho.updateSheet(rec, sheetData));

    const results = await Promise.allSettled(tasks);
    const failed  = results.filter(r => r.status === 'rejected');

    if (failed.length) {
      toast(`Save failed: ${failed[0].reason?.message || 'unknown error'}`, 'error');
      btn.disabled = false; btn.textContent = 'Save';
      return;
    }

    toast('Saved successfully', 'success');
    closeEdit();
    await refresh();  // re-pull so the table reflects both sources
  }

  // ── Router ──────────────────────────────────────────────────
  const ROUTES = { overview: renderOverview, records: renderRecords };
  const TITLES = { overview: 'Overview', records: 'Records' };

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

  async function refresh() {
    _records = null;
    await loadData(true);
    renderCurrentPage();
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
    // Auto-refresh every 10 minutes.
    setInterval(() => { _records = null; renderCurrentPage(); }, 600000);
    renderCurrentPage();
  }

  return { init, refresh, _toast: toast };
})();

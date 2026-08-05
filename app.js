// ─────────────────────────────────────────────────────────────
//  APP — SPA router + pages (Overview, Records)
//  Pull: merged Recruit + Sheet data. Push: edit → write back.
// ─────────────────────────────────────────────────────────────
const App = (() => {

  let _records = null;   // cached merged data
  let _lastUpdated = null;   // ms timestamp of the data currently shown
  let _charts  = [];      // live Chart.js instances (destroyed on re-render)
  let _search  = '';

  // ── Top load bar ───────────────────────────────────────────
  // A slim progress bar pinned to the top of the viewport, shown during every
  // data fetch (initial load AND background refresh) so users see work is in
  // progress and roughly how far along, instead of an unexplained "blink".
  // It fills with real record-page progress when known, and trickles forward
  // otherwise; done() completes it to 100% and fades it out.
  const Progress = (() => {
    let bar, fill, timer = null, val = 0, active = false;
    const grab = () => { if (!bar) { bar = document.getElementById('loadBar'); fill = bar && bar.querySelector('.load-bar-fill'); } };
    const paint = () => { if (fill) fill.style.width = (val * 100).toFixed(1) + '%'; };
    function start() {
      grab(); if (!bar) return;
      active = true; val = 0.08;
      if (fill) fill.style.opacity = '1';
      bar.classList.add('active'); paint();
      clearInterval(timer);
      // Ease toward 90% while waiting; the final 10% is reserved for done().
      timer = setInterval(() => { if (active && val < 0.9) { val += (0.9 - val) * 0.08; paint(); } }, 300);
    }
    function set(frac) {
      grab(); if (!active) return;
      if (typeof frac === 'number' && frac > val) { val = Math.min(frac, 0.97); paint(); }
    }
    function done() {
      grab(); clearInterval(timer); timer = null;
      if (!active || !bar) { return; }
      active = false; val = 1; paint();
      setTimeout(() => {
        if (fill) fill.style.opacity = '0';
        if (bar) bar.classList.remove('active');
        setTimeout(() => { val = 0; paint(); }, 300);
      }, 250);
    }
    // Quick 0→100% sweep — used on a warm-cache reload where the data is
    // already available, so the user gets clear "refreshed" feedback that
    // always completes (the real refresh then runs silently in the background).
    function sweep() { start(); setTimeout(done, 450); }
    return { start, set, done, sweep };
  })();

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

  // Seafarer "business day" key, with the day boundary at 06:00 WITA (UTC+8) —
  // the daily last-minute comparison/baseline aligns to 6 AM WITA. 06:00 WITA
  // == 22:00 UTC the previous day, so shifting the instant by +2h maps it to
  // UTC-midnight of the seafarer day; the UTC date is then the day key.
  function seafarerDayKey(t = Date.now()) {
    return new Date(t + 2 * 3600000).toISOString().slice(0, 10);   // "YYYY-MM-DD"
  }
  // Format an epoch (ms) as a WITA date + time stamp for display.
  function fmtWITA(ms) {
    if (!ms) return null;
    return new Date(ms).toLocaleString('en-US', {
      timeZone: 'Asia/Makassar', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }) + ' WITA';
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
  const CACHE_VERSION = 6;
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

  async function fetchFresh(onProgress) {
    _records = await Zoho.getAllRecords(onProgress);
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
        // Data is already available from cache — give a quick completing sweep
        // for feedback, then pull fresh SILENTLY in the background so a reload
        // reflects the latest Zoho edits without a long-lingering bar.
        Progress.sweep();
        revalidate();
        return _records;
      }
    }
    // Cold load (or forced): the user is genuinely waiting on this fetch, so
    // show the real, page-by-page progress and complete it when the data lands.
    Progress.start();
    try { return await fetchFresh(frac => Progress.set(frac)); }
    catch (err) { toast(`Failed to load: ${err.message}`, 'error'); return null; }
    finally { Progress.done(); }
  }

  // ═══════════════════════════════════════════════════════════
  //  PAGE: OVERVIEW
  // ═══════════════════════════════════════════════════════════
  async function renderOverview() {
    const mc = document.getElementById('main-content');
    if (!_records) mc.innerHTML = skeletonHTML();   // skeleton only on cold load; keep current view during background refresh

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
      </div>
      <div class="chart-row compact">
        <div class="card chart-card">
          <div class="card-title">Rescheduled — last 6 months <span class="hint">(by Rescheduled Date · click a bar)</span></div>
          <canvas id="chartResched" height="200"></canvas>
        </div>
        <div class="card chart-card">
          <div class="card-title">Rescheduled Reason <span class="hint">(last 6 months · click a bar)</span></div>
          <canvas id="chartReschedReason" height="200"></canvas>
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
    // Onboard = signed on in the past AND signs off in the future.
    // At Home = everyone not currently onboard (future/blank sign-on, or a
    // contract that has already ended).
    const nowT = Date.now();
    const isOnboard = r => {
      const on = parseDate(r.signOnDate), off = parseDate(r.signOffDate);
      return on && on.getTime() <= nowT && off && off.getTime() > nowT;
    };
    const onboard = recs.filter(isOnboard).length;
    const atHome = recs.length - onboard;
    const stats = document.getElementById('ovStats');
    if (stats) stats.innerHTML =
      statCard('Total Seafarers', recs.length.toLocaleString()) +
      statCard('New Hired', newHired.toLocaleString()) +
      statCard('Repeater', repeater.toLocaleString()) +
      statCard('Assigned', assigned.toLocaleString()) +
      statCard('No Assignment', noAssign.toLocaleString(), { id: 'statNoAssign', clickable: noAssign > 0 }) +
      statCard('Onboard', onboard.toLocaleString()) +
      statCard('At Home', atHome.toLocaleString());

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

    // Chart 2 — upcoming assignments.
    //  Future months  = module sign-on dates.
    //  Current month  = total deployment this month (deployment sheet, deduped
    //    by Crew ID) + this month's Zoho Recruit assignments whose onboarding
    //    status is NOT "Report to Ship" (those already reported are counted in
    //    the deployment sheet, so excluding them avoids double-counting).
    const sameMonth = (d, ref) => d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
    const idNorm = v => String(v ?? '').trim();
    const fwd = {};
    for (let i = 0; i <= 6; i++) { const d = new Date(base); d.setMonth(d.getMonth() + i); fwd[monthKey(d)] = 0; }
    const nextMonth = new Date(base); nextMonth.setMonth(nextMonth.getMonth() + 1);
    const maxFwd = new Date(base); maxFwd.setMonth(maxFwd.getMonth() + 7);
    recs.forEach(r => {   // future months only
      const d = parseDate(r.signOnDate);
      if (!d || d < nextMonth || d >= maxFwd) return;
      const k = monthKey(new Date(d.getFullYear(), d.getMonth(), 1));
      if (k in fwd) fwd[k]++;
    });
    // Current month = total deployment (sheet) + recruit assignments not yet
    // reported to ship.
    const deployCurIds = new Set();
    deployRows.forEach(row => {
      if (!inSet(f.office, row['CTI Office']) || !inSet(f.cruiseLine, row['Cruise Line'])) return;
      const d = parseSheetDate(row['Sign On Date']);
      if (d && sameMonth(d, base)) { const id = idNorm(row['Crew ID']); if (id) deployCurIds.add(id); }
    });
    let notReported = 0;
    recs.forEach(r => {
      const d = parseDate(r.signOnDate);
      if (!d || !sameMonth(d, base)) return;   // sign-on this month
      if (String(r.onboardingStatus || '').trim().toLowerCase() === 'report to ship') return;  // already deployed
      notReported++;
    });
    fwd[monthKey(base)] = deployCurIds.size + notReported;
    drawBar('chartAssign', fwd);

    // ── Charts 3 & 4 — Rescheduled records (last 6 months) + their reasons.
    // Uses the module field Rescheduled_Date; reasons from
    // Reasons_for_Delayed_Assignment_or_Resignation. Resigned onboarding status
    // is excluded (already dropped from `data`, guarded here too for safety).
    const notResigned = r => String(r.onboardingStatus || '').trim().toLowerCase() !== 'resigned';
    const minResched = new Date(base); minResched.setMonth(minResched.getMonth() - 5);   // 6 months incl. current
    const maxResched = new Date(base); maxResched.setMonth(maxResched.getMonth() + 1);

    const resched = {}, reschedRows = {};
    for (let i = 5; i >= 0; i--) { const d = new Date(base); d.setMonth(d.getMonth() - i); const k = monthKey(d); resched[k] = 0; reschedRows[k] = []; }
    const reasons = {}, reasonRows = {};
    recs.forEach(r => {
      if (!notResigned(r)) return;
      const d = parseDate(r.rescheduledDate);
      if (!d || d < minResched || d >= maxResched) return;
      const k = monthKey(new Date(d.getFullYear(), d.getMonth(), 1));
      if (k in resched) { resched[k]++; reschedRows[k].push(r); }
      const reason = String(r.delayReason || '').trim();
      const rk = (!reason || reason === '—') ? '(No reason given)' : reason;
      reasons[rk] = (reasons[rk] || 0) + 1;
      (reasonRows[rk] = reasonRows[rk] || []).push(r);
    });

    // Drill-down columns shared by both rescheduled charts.
    // Percentage widths (sum = 100%) so the table fills the modal exactly with
    // no horizontal scroll; long values ellipsize (Name/Reason wrap instead).
    const reschedCols = [
      { label: 'ID Number',         render: r => esc(r.crewIdNumber),           sort: r => txtSort(r.crewIdNumber), w: '8%' },
      { label: 'Name',              render: r => esc(r.name),                   sort: r => txtSort(r.name),         w: '16%', wrap: true },
      { label: 'Cruise Line',       render: r => esc(r.cruiseLine),             sort: r => txtSort(r.cruiseLine),   w: '11%' },
      { label: 'Joining Ship',      render: r => esc(r.joiningShip),            sort: r => txtSort(r.joiningShip),  w: '11%' },
      { label: 'Sign On Date',      render: r => formatDate(r.signOnDate),      sort: r => dateSort(parseDate(r.signOnDate)), num: true, w: '9%' },
      { label: 'Rescheduled Date',  render: r => formatDate(r.rescheduledDate), sort: r => dateSort(parseDate(r.rescheduledDate)), num: true, w: '9%' },
      { label: 'Reason',            render: r => esc(r.delayReason),            sort: r => txtSort(r.delayReason),  w: '15%', wrap: true },
      { label: 'Onboarding Status', render: r => esc(r.onboardingStatus),       sort: r => txtSort(r.onboardingStatus), w: '12%' },
      { label: 'Mistral Status',    render: r => esc(r.mistralStatus),          sort: r => txtSort(r.mistralStatus), w: '9%' },
    ];
    drawBar('chartResched', resched, month => {
      const rows = reschedRows[month] || [];
      if (rows.length) openDetailModal(rows, reschedCols, `Rescheduled — ${month}`);
    });
    drawBar('chartReschedReason', topN(reasons, 8), reason => {
      const rows = reasonRows[reason] || [];
      if (rows.length) openDetailModal(rows, reschedCols, `Rescheduled Reason — ${reason}`);
    }, { wrapLabels: true });
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

  // Split a label into up to 2 balanced lines (by words) for the x-axis, so
  // long category names sit horizontally under each bar instead of tilting.
  // Single-word labels stay on one line. Returns a string or [line1, line2];
  // Chart.js renders an array of strings as stacked lines.
  function wrapLabel2(str) {
    const words = String(str).trim().split(/\s+/);
    if (words.length < 2) return str;
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }

  function drawBar(canvasId, obj, onClick, opts = {}) {
    const el = document.getElementById(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    const accent = CONFIG.ACCENT_COLOR || '#B01A18';
    // Wrapped labels are display-only (via the tick callback); data.labels keeps
    // the original strings so onClick still resolves the right bucket.
    const xScale = opts.wrapLabels
      ? { ticks: { autoSkip: false, maxRotation: 0, minRotation: 0,
                   callback(v) { return wrapLabel2(this.getLabelForValue(v)); } } }
      : {};
    const c = new Chart(el, {
      type: 'bar',
      data: {
        labels: Object.keys(obj),
        datasets: [{ data: Object.values(obj), backgroundColor: accent, borderRadius: 4 }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grace: '8%', ticks: { precision: 0 } }, x: xScale },
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
      expiryKey: 'passportExpiry',    expectedKey: 'passportExpectedDate' },
    { key: 'bst',      label: 'BST',
      statusKey: 'bstStatus',         numberKey: 'bstNumber',         apptKey: null,
      expiryKey: 'bstExpiry',         expectedKey: 'bstExpectedDate' },
    { key: 'seaman',   label: "Seaman's Book",
      statusKey: 'seamanBookStatus',  numberKey: 'seamanBookNumber',  apptKey: null,
      expiryKey: 'seamanBookExpiry',  expectedKey: 'seamanBookExpectedDate' },
    { key: 'medical',  label: 'Medical',
      statusKey: 'medicalStatus',     numberKey: null,                apptKey: null,
      expiryKey: 'medicalExpiry',     expectedKey: 'medicalExpectedDate' },
    // Visas.
    { key: 'c1d',      label: 'C1/D',
      statusKey: 'c1dVisaStatus',   numberKey: 'c1dVisaNumber',   apptKey: 'c1dVisaAppointment',
      expiryKey: 'c1dVisaExpiry',   sheetType: /c1\s*\/?\s*d/i,   expectedKey: 'c1dExpectedDate' },
    { key: 'schengen', label: 'Schengen',
      statusKey: 'otherVisaStatus', numberKey: 'otherVisaNumber', apptKey: 'otherVisaAppointment',
      expiryKey: 'otherVisaExpiry', sheetType: /schengen/i,
      nameKey: 'otherVisaName',     nameMatch: /schengen/i,       expectedKey: 'otherVisaExpectedDate',
      moduleOnly: true },   // Recruit module only — no Visa Log sheet fallback (excludes payment statuses)
    { key: 'mcv',      label: 'MCV',
      statusKey: 'mcvStatus',       numberKey: 'mcvNumber',       apptKey: null,
      expiryKey: 'mcvExpiry',       sheetType: /mcv/i,            expectedKey: 'mcvExpectedDate' },
    { key: 'oktb',     label: 'OKTB',
      statusKey: 'oktbStatus',      numberKey: null,              apptKey: null,
      expiryKey: null,              sheetType: /oktb/i,
      expectedKey: 'oktbRequestedDate', expectedLabel: 'Requested Date' },
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
  let _recTab = 'all';                // Records sub-tab: 'all' | 'lastmin' | 'lastresched'
  let _lastMinSet = new Set();        // crew IDs flagged as last-minute assignments
  let _lastReschedSet = new Set();    // crew IDs flagged as last-minute RESCHEDULED (imminent sign-on moved)
  let _lastComparedAt = null;         // epoch ms of the last daily comparison (6 AM WITA)
  let _j1Tab  = 'performance';        // J1 Program sub-tab: 'performance' | 'progress'
  let _j1Sort = { i: 0, dir: 1 };     // J1 Visa Performance table sort
  let _j1Filters = { source: ['CTI Indonesia'], apptRange: 'upcoming' };   // J1 Visa Performance filters

  // Shared state via the worker KV endpoint (/state/<key>), so all users see
  // the same snapshot. Falls back to null if the endpoint isn't deployed yet.
  async function stateGet(key) {
    try {
      const r = await fetch(`${CONFIG.PROXY}/state/${key}`, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  async function statePut(key, val) {
    try {
      await fetch(`${CONFIG.PROXY}/state/${key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(val),
      });
    } catch { /* ignore */ }
  }

  // Detect "last-minute" assignments by comparing each seafarer's SIGN-ON DATE
  // against the previous day's snapshot. A seafarer is flagged when their sign-on
  // date CHANGED to a value under 4 weeks away — this catches both a brand-new
  // assignment (no date before) AND a reschedule-forward (was >4 weeks, moved to
  // <4 weeks). The snapshot + flags live in the shared worker KV so every user
  // sees the same list.
  async function refreshLastMinute(records) {
    const KEY = 'lastmin';
    const idOf = r => String(r.crewIdNumber ?? '').trim();
    const dayKey = seafarerDayKey();   // day boundary = 06:00 WITA
    const now0 = new Date(); now0.setHours(0, 0, 0, 0);
    const nowT = now0.getTime(), FOUR_WK = 28 * 86400000, FOUR_DAYS = 4 * 86400000;
    const signKey = d => d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null;
    const parseSignKey = k => { if (!k) return null; const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); };

    // Today's sign-on date per assigned seafarer.
    const byId = {}, todaySign = {};
    records.forEach(r => {
      const id = idOf(r);
      if (!id || id === '—') return;
      byId[id] = r;
      const d = parseDate(r.signOnDate);
      if (d) todaySign[id] = signKey(d);
    });

    const state = (await stateGet(KEY)) || { day: null, signon: {}, flags: {}, reschedFlags: {} };
    let flags = state.flags || {};
    let reschedFlags = state.reschedFlags || {};
    let changed = false;

    // One-time self-heal: an earlier version stored a legacy `ids` key and, on
    // the snapshot-format change, mass-flagged ~10% of all seafarers in a single
    // day (the "234"/"390" blow-up). Its presence proves the state predates the
    // current logic, so drop the bogus flag batch and rebuild the snapshot from
    // scratch (no detection this run; genuine day-over-day flagging resumes next
    // day). This cannot re-trigger once healed.
    if ('ids' in state) {
      delete state.ids;
      flags = {};        state.flags = flags;
      reschedFlags = {}; state.reschedFlags = reschedFlags;
      state.day = null;     // force a clean snapshot rebuild below
      changed = true;
    }

    // Run the comparison ONCE per seafarer-day (boundary = 06:00 WITA). A
    // Cloudflare Cron runs this at exactly 6 AM WITA (authoritative); if it
    // hasn't (not deployed, or the day hasn't been compared yet), the first
    // dashboard load after 6 AM does it as a fallback. Either way the baseline,
    // flags, and comparedAt timestamp advance only once per day — so the list
    // and the "last compared" time stay stable through the day.
    if (state.day !== dayKey) {
      const prev = state.signon || {};
      // Skip the very first run (empty baseline) so it can't flag everyone.
      if (Object.keys(prev).length) {
        Object.keys(todaySign).forEach(id => {
          if (prev[id] === todaySign[id]) return;               // sign-on unchanged
          const d = parseDate(byId[id].signOnDate);
          // Last-minute ASSIGNMENT: sign-on changed to under 4 weeks away.
          if (d && d.getTime() >= nowT && d.getTime() < nowT + FOUR_WK) flags[id] = dayKey;
          // Last-minute RESCHEDULE: a sign-on that was imminent (≤4 days away)
          // moved to a different date — e.g. a seafarer already at the airport
          // pushed to a later date. Needs a prior imminent date, so brand-new
          // assignments don't count.
          const pd = parseSignKey(prev[id]);
          if (pd && pd.getTime() >= nowT && pd.getTime() <= nowT + FOUR_DAYS) reschedFlags[id] = dayKey;
        });
      }
      state.day = dayKey;
      state.signon = todaySign;
      state.comparedAt = Date.now();    // stamp when this day's comparison ran
      changed = true;
    }
    // A flag is cleared once the assignment is handled (onboarding = Report to
    // Ship / Rescheduled / Resigned), the record is gone, OR its sign-on date
    // has already passed — a past sign-on is no longer a last-minute assignment
    // to act on, so it must drop off the list instead of accumulating forever.
    const DONE = ['report to ship', 'rescheduled', 'resigned'];
    Object.keys(flags).forEach(id => {
      const r = byId[id];
      if (!r) { delete flags[id]; changed = true; return; }
      const d = parseDate(r.signOnDate);
      const done = DONE.includes(String(r.onboardingStatus ?? '').trim().toLowerCase());
      if (done || !d || d.getTime() < nowT) { delete flags[id]; changed = true; }
    });
    // Reschedule flags clear ONLY once the seafarer reports to ship (or the
    // record is gone / resigned → already filtered out). Being "Rescheduled" is
    // the trigger here, so — unlike assignment flags — it must NOT clear them.
    Object.keys(reschedFlags).forEach(id => {
      const r = byId[id];
      if (!r) { delete reschedFlags[id]; changed = true; return; }
      if (String(r.onboardingStatus ?? '').trim().toLowerCase() === 'report to ship') { delete reschedFlags[id]; changed = true; }
    });
    state.flags = flags;
    state.reschedFlags = reschedFlags;
    if (changed) await statePut(KEY, state);
    return { assign: new Set(Object.keys(flags)), resched: new Set(Object.keys(reschedFlags)), comparedAt: state.comparedAt || null };
  }
  let _ovFilters = { office: [DEFAULT_OFFICE], cruiseLine: [] };   // Overview charts
  let _penFilters = emptyFilters();   // Pending Action page
  let _penSort = { i: 5, dir: 1 };    // default: Expected Date ascending (closest first)

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
    if (!_records) mc.innerHTML = skeletonHTML();   // skeleton only on cold load; keep current view during background refresh
    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    // Hide excluded onboarding statuses (Resigned, Process by MSS Philippines).
    const data = allData.filter(includeRecord);
    // Visa Registration Log sheet (drives the C1/D processing chart).
    let visaSheet = [];
    try { visaSheet = await Zoho.getSheetRows('visa'); } catch { visaSheet = []; }

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

    const repaint = () => { destroyCharts(); paintVisaPanel(applyVisaFilters(data), visaSheet); };

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

  function paintVisaPanel(data, visaSheet) {
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

    // Cruise-line rule: a document must stay valid through (Sign Off Date + a
    // buffer) — 6 months for Passport, 1 month for every other document. A
    // currently-Valid document that expires before that is flagged as expiring.
    const soBuffer = tab.key === 'passport' ? 6 : 1;
    const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
    let expiringRows = [];
    if (tab.expiryKey) {
      expiringRows = holders
        .filter(x => isValid(x.s))
        .map(x => ({ r: x.r, off: parseDate(x.r.signOffDate), exp: parseDate(x.r[tab.expiryKey]) }))
        .filter(x => x.off && x.exp && x.exp.getTime() < addMonths(x.off, soBuffer).getTime())
        .sort((a, b) => a.exp - b.exp)   // soonest expiry first
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

    // Schengen only: Other Visa Issued Date must be at least 2 days before the
    // Sign On Date — otherwise immigration treats the visa as invalid. Flag any
    // issued later than (sign-on − 2 days).
    let issueGapRows = [];
    if (tab.key === 'schengen') {
      const TWO_DAYS = 2 * 86400000;
      issueGapRows = holders.map(x => x.r).filter(r => {
        const issued = parseDate(r.otherVisaIssuedDate), signOn = parseDate(r.signOnDate);
        return issued && signOn && issued.getTime() > (signOn.getTime() - TWO_DAYS);
      });
    }
    const issueGap = issueGapRows.length;

    // Visa Registration Log processing groups (from the sheet), for C1/D and
    // Schengen. NOTE: intentionally NOT filtered by the page filters — always
    // counts every matching application in the log (matched by the visa-type
    // column only).
    let procGroups = null;
    if ((tab.key === 'c1d' || tab.key === 'schengen') && Array.isArray(visaSheet) && visaSheet.length) {
      const typeCol = 'Please select the type of visa you want to process';
      const norm = v => String(v ?? '').trim();
      const low  = v => norm(v).toLowerCase();
      const schengenTypes = ['schengen visa', 'schengen visa prime time', 'spain visa prime time'];
      const typeMatch = tab.key === 'c1d'
        ? (t => low(t) === 'c1/d visa')
        : (t => schengenTypes.includes(low(t)));
      const rows = visaSheet.filter(row => typeMatch(row[typeCol]));
      const nowT = Date.now();
      const firstLabel = tab.key === 'c1d' ? 'Pending DS-160' : 'Pending Application';
      procGroups = [
        [firstLabel,            rows.filter(row => {
          if (low(row['Payment Status']) !== 'paid' || norm(row['Visa Status']) !== '') return false;
          if (tab.key === 'schengen') return norm(row['Appointment Date']) === '' && norm(row['Notes']) === '';
          return true;
        })],
        ['Pending Appointment', rows.filter(row => {
          if (low(row['Payment Status']) !== 'paid') return false;
          if (norm(row['Appointment Date']) !== '') return false;   // no appointment yet
          if (tab.key === 'schengen') return norm(row['Notes']) !== '' && norm(row['Visa Status']) === '';   // Schengen: Notes not blank, Visa Status blank
          const vs = low(row['Visa Status']);                             // C1/D: visa status processed
          return vs === 'visa payment processed' || vs === 'visa application processed';
        })],
        ['Secured Appointment', rows.filter(row => {
          const d = parseSheetDate(row['Appointment Date']);
          if (!d || d.getTime() <= nowT) return false;              // future appointment
          if (tab.key === 'schengen') return low(row['Payment Status']) === 'paid';  // Schengen also requires Paid
          return true;
        })],
      ];
    }

    const byStatus = {};
    holders.forEach(x => { byStatus[x.s] = (byStatus[x.s] || 0) + 1; });

    panel.innerHTML = `
      <div class="stat-grid">
        ${statCard(`Total ${tab.label}`, total, { id: 'statTotal', clickable: total > 0 })}
        ${statCard('Valid', valid, { id: 'statValid', clickable: valid > 0 })}
        ${statCard('In Progress', inProgress, { id: 'statProgress', clickable: inProgress > 0 })}
        ${tab.expiryKey ? statCard(`Expiring (Sign-off +${soBuffer}mo)`, expiring, { id: 'statExpiring', clickable: expiring > 0 }) : statCard('No Status', noStatus, { id: 'statNoStatus', clickable: noStatus > 0 })}
        ${tab.key === 'mcv' ? statCard('Unmatched Passport', unmatched, { id: 'statUnmatched', clickable: unmatched > 0 }) : ''}
        ${tab.key === 'schengen' ? statCard('Issued < 2d before Sign On', issueGap, { id: 'statIssueGap', clickable: issueGap > 0 }) : ''}
      </div>
      <div class="chart-row">
        <div class="card chart-card">
          <div class="card-title">${tab.label} — By Status ${total ? '<span class="hint">(click a bar to list those seafarers)</span>' : ''}</div>
          ${total ? `<canvas id="visaChart" height="240"></canvas>` : `<p class="empty-row">No ${tab.label} records found.</p>`}
        </div>
        ${procGroups ? `
        <div class="card chart-card">
          <div class="card-title">${tab.label} — Visa Processing <span class="hint">(Visa Registration Log · click a bar)</span></div>
          <canvas id="c1dSheetChart" height="240"></canvas>
        </div>` : ''}
      </div>`;

    if (total) drawBar('visaChart', topN(byStatus, 8), status => showVisaDetail(holders, tab, status));

    // Visa-processing chart (from the Visa Registration Log), bars clickable.
    if (procGroups) {
      const counts = {};
      procGroups.forEach(([label, rows]) => { counts[label] = rows.length; });
      const s = (row, k) => esc(row[k] || '—');
      const col = {
        name:  { label: 'Name',             render: r => s(r, 'Name'),            sort: r => txtSort(r['Name']),          w: 200, wrap: true },
        email: { label: 'Email',            render: r => s(r, 'Email Address'),   sort: r => txtSort(r['Email Address']), w: 230, wrap: true },
        line:  { label: 'Cruise Line',      render: r => s(r, 'Cruise Line'),     sort: r => txtSort(r['Cruise Line']),   w: 150 },
        pay:   { label: 'Payment Status',   render: r => s(r, 'Payment Status'),  sort: r => txtSort(r['Payment Status']), w: 130 },
        vstat: { label: 'Visa Status',      render: r => s(r, 'Visa Status'),     sort: r => txtSort(r['Visa Status']),   w: 180 },
        added: { label: 'Added Time',       render: r => formatSheetDate(r['Added Time']), sort: r => dateSort(parseSheetDate(r['Added Time'])), num: true, w: 140 },
        bniva: { label: 'BNIVA Number',     render: r => s(r, 'BNIVA Number'),    sort: r => txtSort(r['BNIVA Number']),  w: 140 },
        appt:  { label: 'Appointment Date', render: r => formatSheetDate(r['Appointment Date']), sort: r => dateSort(parseSheetDate(r['Appointment Date'])), num: true, w: 150 },
        appid: { label: 'Application ID',   render: r => s(r, 'Visa Application ID'), sort: r => txtSort(r['Visa Application ID']), w: 140 },
        notes: { label: 'Notes',            render: r => s(r, 'Notes'),           sort: r => txtSort(r['Notes']),         w: 600, wrap: true },
      };
      // Pending DS-160 / Pending Application uses "Added Time"; the other two
      // keep BNIVA + Appointment. Schengen's Pending Appointment is special:
      // Added Time (first), Name, Email, Cruise Line, Payment Status, wide Notes.
      const ds160Cols      = [col.added, col.name, col.email, col.line, col.pay, col.vstat, col.appid];
      const otherCols      = [col.name, col.email, col.line, col.pay, col.vstat, col.bniva, col.appt, col.appid];
      const c1dApptCols    = [col.added, col.name, col.email, col.line, col.vstat, col.bniva, col.appt, col.appid];   // no Payment Status
      const c1dSecuredCols = [col.name, col.email, col.line, col.vstat, col.bniva, col.appt, col.appid];               // no Payment Status
      const schApptCols    = [col.added, col.name, col.email, col.line, col.notes];
      const firstLabel = procGroups[0][0];   // "Pending DS-160" / "Pending Application"
      drawBar('c1dSheetChart', counts, label => {
        const g = procGroups.find(([l]) => l === label);
        if (!g || !g[1].length) return;
        const cols = label === firstLabel ? ds160Cols
          : (tab.key === 'schengen' && label === 'Pending Appointment') ? schApptCols
          : (tab.key === 'c1d' && label === 'Pending Appointment') ? c1dApptCols
          : (tab.key === 'c1d' && label === 'Secured Appointment') ? c1dSecuredCols
          : otherCols;
        openDetailModal(g[1], cols, `${tab.label} — ${label}`);
      });
    }

    // Stat tiles → drill down to the seafarers behind each count.
    const wireStat = (id, rows, title, extraCols) => {
      const el = document.getElementById(id);
      if (el && rows.length) el.onclick = () => renderVisaDetail(rows, tab, title, extraCols);
    };
    // In Progress drill-down also shows the admin-recorded Expected/Requested Date.
    const expectedCol = tab.expectedKey ? [{
      label: tab.expectedLabel || 'Expected Date',
      render: r => formatDate(r[tab.expectedKey]),
      sort: r => dateSort(parseDate(r[tab.expectedKey])), num: true,
    }] : null;
    wireStat('statTotal',    totalRows,    `${tab.label} — All`);
    wireStat('statValid',    validRows,    `${tab.label} — Valid`);
    wireStat('statProgress', progressRows, `${tab.label} — In Progress`, expectedCol);
    wireStat('statExpiring', expiringRows, `${tab.label} — Expiring (valid < Sign-off +${soBuffer}mo)`);
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
        { label: 'Sign On',             render: r => formatDate(r.signOnDate), sort: r => dateSort(parseDate(r.signOnDate)), num: true, w: 120 },
        { label: 'Sign Off',            render: r => formatDate(r.signOffDate),sort: r => dateSort(parseDate(r.signOffDate)), num: true, w: 120 },
        { label: 'Ship',                render: r => esc(r.joiningShip),       sort: r => txtSort(r.joiningShip),  w: 150 },
        { label: 'Joining Port',        render: r => esc(r.signOnPort),        sort: r => txtSort(r.signOnPort),   w: 140 },
      ];
      uCard.onclick = () => openDetailModal(unmatchedRows, uCols, `${tab.label} — Unmatched Passport Number`);
    }

    // Schengen: visa-issued-too-late drill-down.
    const igCard = document.getElementById('statIssueGap');
    if (igCard && issueGap) {
      const igCols = [
        { label: 'ID Number',        render: r => esc(r.crewIdNumber),      sort: r => txtSort(r.crewIdNumber), w: 100 },
        { label: 'Name',             render: r => esc(r.name),              sort: r => txtSort(r.name),         w: 200, wrap: true },
        { label: 'Visa Issued Date', render: r => formatDate(r.otherVisaIssuedDate), sort: r => dateSort(parseDate(r.otherVisaIssuedDate)), num: true, w: 150 },
        { label: 'Sign On',          render: r => formatDate(r.signOnDate), sort: r => dateSort(parseDate(r.signOnDate)), num: true, w: 130 },
        { label: 'Ship',             render: r => esc(r.joiningShip),       sort: r => txtSort(r.joiningShip),  w: 150 },
        { label: 'Sign On Port',     render: r => esc(r.signOnPort),        sort: r => txtSort(r.signOnPort),   w: 140 },
      ];
      igCard.onclick = () => openDetailModal(issueGapRows, igCols, `${tab.label} — Visa Issued < 2 days before Sign On`);
    }
  }

  // Drill-down: list the seafarers behind a clicked status bar.
  function showVisaDetail(holders, tab, status) {
    // MCV: the "Need to Process" / "In Process" bars also show the
    // admin-recorded Expected Date column (matching the In Progress chip).
    let extraCols = null;
    if (tab.key === 'mcv' && tab.expectedKey &&
        /need|process|pending|progress|applied|appointment|schedul|await/i.test(status)) {
      extraCols = [{
        label: tab.expectedLabel || 'Expected Date',
        render: r => formatDate(r[tab.expectedKey]),
        sort: r => dateSort(parseDate(r[tab.expectedKey])), num: true,
      }];
    }
    renderVisaDetail(holders.filter(x => x.s === status).map(x => x.r), tab,
      `${tab.label} — ${status}`, extraCols);
  }

  // Render a drill-down detail table (in a modal) for a set of seafarer records.
  // extraCols: optional column defs appended at the end (e.g. Expected Date).
  function renderVisaDetail(rows, tab, title, extraCols) {
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
    if (tab.key === 'schengen')
      cols.push({ label: 'Sign On Port', render: r => esc(r.signOnPort), sort: r => txtSort(r.signOnPort) });
    cols.push({ label: 'Onboarding', render: r => esc(r.onboardingStatus), sort: r => txtSort(r.onboardingStatus) });
    cols.push({ label: 'Sign On',    render: r => formatDate(r.signOnDate),  sort: r => dateSort(parseDate(r.signOnDate)), num: true });
    cols.push({ label: 'Sign Off',   render: r => formatDate(r.signOffDate),      sort: r => dateSort(parseDate(r.signOffDate)),     num: true });
    if (extraCols) cols.push(...extraCols);

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
      // `w` as a number → px; as a string (e.g. '12%') → used verbatim, so a
      // column set can be sized to fit the modal exactly (no horizontal scroll).
      const st  = c.w ? ` style="width:${typeof c.w === 'number' ? c.w + 'px' : c.w}"` : '';
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
      const st = c.w ? ` style="width:${typeof c.w === 'number' ? c.w + 'px' : c.w}"` : '';
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
    if (!_records) mc.innerHTML = skeletonHTML();   // skeleton only on cold load; keep current view during background refresh

    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    // Hide excluded onboarding statuses (Resigned, Process by MSS Philippines).
    const data = allData.filter(includeRecord);
    const _lm = await refreshLastMinute(data);     // day-over-day (shared via worker KV)
    _lastMinSet = _lm.assign;
    _lastReschedSet = _lm.resched;
    _lastComparedAt = _lm.comparedAt;

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
      { label: 'Other Visa Name',      render: r => esc(r.otherVisaName),     sort: r => txtSort(r.otherVisaName) },
    ];

    const stickyCls = i => i < 2 ? ` sticky-col sticky-col-${i + 1}` : '';
    const headHtml = () => `<tr>${cols.map((c, i) => {
      const arrow = i === _recSort.i ? `<span class="sort-arrow">${_recSort.dir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th class="sortable${stickyCls(i)}" data-i="${i}">${c.label}${arrow}</th>`;
    }).join('')}</tr>`;

    mc.innerHTML = `
      <div class="page-header"><h1>Records</h1></div>
      <div class="subtabs">
        <button class="subtab ${_recTab === 'all' ? 'active' : ''}" data-rectab="all">All Records</button>
        <button class="subtab ${_recTab === 'lastmin' ? 'active' : ''}" data-rectab="lastmin">Last Minutes Assignment <span class="subtab-count" id="lastminCount"></span></button>
        <button class="subtab ${_recTab === 'lastresched' ? 'active' : ''}" data-rectab="lastresched">Last Minutes Rescheduled <span class="subtab-count" id="lastreschedCount"></span></button>
        <button class="subtab ${_recTab === 'reassigned' ? 'active' : ''}" data-rectab="reassigned">Re-Assigned <span class="subtab-count" id="reassignedCount"></span></button>
        <span class="compare-stamp" id="compareStamp"></span>
      </div>
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
      const lm = document.getElementById('lastminCount');
      if (lm) lm.textContent = '· ' + applyDeployFilters(data, _recFilters)
        .filter(r => _lastMinSet.has(String(r.crewIdNumber ?? '').trim())).length;
      const lr = document.getElementById('lastreschedCount');
      if (lr) lr.textContent = '· ' + applyDeployFilters(data, _recFilters)
        .filter(r => _lastReschedSet.has(String(r.crewIdNumber ?? '').trim())).length;
      const ra = document.getElementById('reassignedCount');
      if (ra) ra.textContent = '· ' + applyDeployFilters(data, _recFilters).filter(isReassigned).length;
      const cs = document.getElementById('compareStamp');
      if (cs) cs.textContent = _lastComparedAt ? `Last compared: ${fmtWITA(_lastComparedAt)}` : 'Last compared: not yet run';
      document.getElementById('recHead').innerHTML = headHtml();
      paintRows(rows, cols);
      document.querySelectorAll('#recHead th.sortable').forEach(th =>
        th.onclick = () => {
          const i = +th.dataset.i;
          if (i === _recSort.i) _recSort.dir = -_recSort.dir; else { _recSort.i = i; _recSort.dir = 1; }
          paint();
        });
    };

    mc.querySelectorAll('[data-rectab]').forEach(b =>
      b.addEventListener('click', () => {
        _recTab = b.dataset.rectab;
        mc.querySelectorAll('[data-rectab]').forEach(x =>
          x.classList.toggle('active', x.dataset.rectab === _recTab));
        paint();
      }));
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

  // Re-Assigned: onboarding is "Rescheduled" but the current Sign On Date no
  // longer matches Rescheduled_Date (a new join date was set without updating
  // the status). Dates compared by day; needs a Sign On Date to be present.
  function isReassigned(r) {
    if (String(r.onboardingStatus ?? '').trim().toLowerCase() !== 'rescheduled') return false;
    const dayKeyOf = v => { const d = parseDate(v); return d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : ''; };
    const so = dayKeyOf(r.signOnDate);
    if (!so) return false;                         // no new join date yet
    return so !== dayKeyOf(r.rescheduledDate);     // unmatched
  }

  // Records dataset filtered by the shared deployment filters + the search box.
  function recFiltered(data) {
    let rows = applyDeployFilters(data, _recFilters);
    // Last Minutes Assignment: newly assigned since the previous day's snapshot,
    // with a sign-on under 4 weeks away (see refreshLastMinute).
    if (_recTab === 'lastmin')
      rows = rows.filter(r => _lastMinSet.has(String(r.crewIdNumber ?? '').trim()));
    // Last Minutes Rescheduled: an imminent (≤4-day) sign-on that moved to a
    // new date; stays until onboarding = Report to Ship (see refreshLastMinute).
    else if (_recTab === 'lastresched')
      rows = rows.filter(r => _lastReschedSet.has(String(r.crewIdNumber ?? '').trim()));
    // Re-Assigned: onboarding still "Rescheduled" but the Sign On Date no longer
    // matches Rescheduled_Date — i.e. a new join date was set but the status was
    // never updated. Drops off once onboarding changes away from Rescheduled.
    else if (_recTab === 'reassigned')
      rows = rows.filter(isReassigned);
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

  // ═══════════════════════════════════════════════════════════
  //  PAGE: PENDING ACTION  (documents not yet Valid, with an expected date)
  // ═══════════════════════════════════════════════════════════
  async function renderPending() {
    const mc = document.getElementById('main-content');
    if (!_records) mc.innerHTML = skeletonHTML();   // skeleton only on cold load; keep current view during background refresh
    const allData = await loadData();
    if (!allData) { mc.innerHTML = errorHTML(); return; }
    const data = allData.filter(includeRecord);

    const offices     = distinctVals(data, 'ctiOffice');
    const cruiseLines = distinctVals(data, 'cruiseLine');
    const onboardings = distinctVals(data, 'onboardingStatus');

    const isValid = s => /valid|approv|issued|granted|complete|pass|board|ok to/i.test(String(s || ''));
    // Each document type: label, expected-date field, status field.
    const DOC_TYPES = [
      { label: 'Passport',      exp: 'passportExpectedDate',   st: 'passportStatus' },
      { label: 'BST',           exp: 'bstExpectedDate',        st: 'bstStatus' },
      { label: "Seaman's Book", exp: 'seamanBookExpectedDate', st: 'seamanBookStatus' },
      { label: 'Medical',       exp: 'medicalExpectedDate',    st: 'medicalStatus' },
      { label: 'C1/D Visa',     exp: 'c1dExpectedDate',        st: 'c1dVisaStatus' },
      { label: 'Other Visa',    exp: 'otherVisaExpectedDate',  st: 'otherVisaStatus' },
      { label: 'MCV',           exp: 'mcvExpectedDate',        st: 'mcvStatus' },
    ];

    // Row = one (seafarer, pending document) pair.
    const cols = [
      { label: 'ID Number',      render: x => esc(x.r.crewIdNumber), sort: x => txtSort(x.r.crewIdNumber) },
      { label: 'Name',           render: x => esc(x.r.name),         sort: x => txtSort(x.r.name) },
      { label: 'Email',          render: x => esc(x.r.email),        sort: x => txtSort(x.r.email) },
      { label: 'Document',       render: x => esc(x.doc),            sort: x => txtSort(x.doc) },
      { label: 'Current Status', render: x => esc(x.status),         sort: x => txtSort(x.status) },
      { label: 'Expected Date',  render: x => formatDate(x.exp),     sort: x => x.exp ? x.exp.getTime() : null, num: true },
      { label: 'Sign On Date',   render: x => formatDate(x.r.signOnDate), sort: x => dateSort(parseDate(x.r.signOnDate)), num: true },
      { label: 'Sign On Port',   render: x => esc(x.r.signOnPort),   sort: x => txtSort(x.r.signOnPort) },
      { label: 'Ship',           render: x => esc(x.r.joiningShip),  sort: x => txtSort(x.r.joiningShip) },
      { label: 'Onboarding Status', render: x => esc(x.r.onboardingStatus), sort: x => txtSort(x.r.onboardingStatus) },
    ];

    const headHtml = () => `<tr>${cols.map((c, i) => {
      const arrow = i === _penSort.i ? `<span class="sort-arrow">${_penSort.dir > 0 ? '▲' : '▼'}</span>` : '';
      return `<th class="sortable" data-i="${i}">${c.label}${arrow}</th>`;
    }).join('')}</tr>`;

    mc.innerHTML = `
      <div class="page-header"><h1>Pending Action</h1></div>
      <div class="filter-bar">
        ${msHTML('pOffice', 'All CTI Offices', offices, _penFilters.office)}
        ${msHTML('pLine', 'All Cruise Lines', cruiseLines, _penFilters.cruiseLine)}
        ${msHTML('pOnboard', 'All Onboarding Status', onboardings, _penFilters.onboarding)}
        <label class="filter-date">Sign On <input type="date" id="pFrom" value="${esc(_penFilters.from)}"></label>
        <label class="filter-date">to <input type="date" id="pTo" value="${esc(_penFilters.to)}"></label>
        <button class="btn-sm" id="pClear">Clear</button>
      </div>
      <div class="toolbar">
        <input type="search" id="penSearch" class="search-input" placeholder="Search name, email, ID, document…" value="${esc(_search)}">
        <span class="rec-count" id="penCount"></span>
      </div>
      <div class="card table-card">
        <div class="table-wrap"><table class="data-table">
          <thead id="penHead">${headHtml()}</thead>
          <tbody id="penBody"></tbody>
        </table></div>
      </div>`;

    const buildRows = () => {
      const filtered = applyDeployFilters(data, _penFilters);
      const rows = [];
      filtered.forEach(r => DOC_TYPES.forEach(dt => {
        const exp = parseDate(r[dt.exp]);
        if (!exp) return;                // no expected date recorded
        if (isValid(r[dt.st])) return;   // already Valid → resolved
        rows.push({ r, doc: dt.label, exp, status: r[dt.st] });
      }));
      const q = _search.trim().toLowerCase();
      let out = q ? rows.filter(x => [x.r.name, x.r.email, x.r.crewIdNumber, x.doc, x.status]
        .some(v => String(v).toLowerCase().includes(q))) : rows;
      if (_penSort.i >= 0) {
        const c = cols[_penSort.i];
        out = out.slice().sort((a, b) => {
          const x = c.sort(a), y = c.sort(b);
          const xe = (x === null || x === ''), ye = (y === null || y === '');
          if (xe && ye) return 0; if (xe) return 1; if (ye) return -1;
          return (c.num ? (x - y) : String(x).localeCompare(String(y))) * _penSort.dir;
        });
      }
      return out;
    };

    const paint = () => {
      const rows = buildRows();
      const cnt = document.getElementById('penCount');
      if (cnt) cnt.textContent = `${rows.length.toLocaleString()} item${rows.length === 1 ? '' : 's'}`;
      document.getElementById('penHead').innerHTML = headHtml();
      const tbody = document.getElementById('penBody');
      if (tbody) tbody.innerHTML = rows.length
        ? rows.map(x => `<tr>${cols.map(c => `<td>${c.render(x)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${cols.length}" class="empty-row">No pending actions.</td></tr>`;
      document.querySelectorAll('#penHead th.sortable').forEach(th =>
        th.onclick = () => {
          const i = +th.dataset.i;
          if (i === _penSort.i) _penSort.dir = -_penSort.dir; else { _penSort.i = i; _penSort.dir = 1; }
          paint();
        });
    };

    wireMS(mc, 'pOffice',  sel => { _penFilters.office = sel;     paint(); });
    wireMS(mc, 'pLine',    sel => { _penFilters.cruiseLine = sel; paint(); });
    wireMS(mc, 'pOnboard', sel => { _penFilters.onboarding = sel; paint(); });
    const wire = (id, prop) => {
      const el = mc.querySelector('#' + id);
      el.addEventListener('change', () => { _penFilters[prop] = el.value; paint(); });
    };
    wire('pFrom', 'from'); wire('pTo', 'to');
    mc.querySelector('#pClear').addEventListener('click', () => { _penFilters = emptyFilters(); renderPending(); });
    mc.querySelector('#penSearch').addEventListener('input', e => { _search = e.target.value; paint(); });

    paint();
    updateStatus();
  }

  // ── Router ──────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  //  PAGE: J1 PROGRAM  (standalone module + sheet, own sub-tabs)
  // ═══════════════════════════════════════════════════════════
  async function renderJ1() {
    const mc = document.getElementById('main-content');
    mc.innerHTML = skeletonHTML();
    Progress.start();
    let participants = [], j1rows = [];
    try {
      [participants, j1rows] = await Promise.all([
        Zoho.getJ1Participants().catch(() => []),
        Zoho.getJ1VisaRows().catch(() => []),
      ]);
    } finally { Progress.done(); }

    mc.innerHTML = `
      <div class="page-header"><h1>J1 Program</h1></div>
      <div class="subtabs">
        <button class="subtab active" data-j1tab="performance">Visa Performance</button>
      </div>
      <div id="j1Panel"></div>`;

    const paint = () => paintJ1(participants, j1rows);
    mc.querySelectorAll('[data-j1tab]').forEach(b => b.addEventListener('click', () => {
      _j1Tab = b.dataset.j1tab;
      mc.querySelectorAll('[data-j1tab]').forEach(x => x.classList.toggle('active', x.dataset.j1tab === _j1Tab));
      paint();
    }));
    paint();
    updateStatus();
  }

  function paintJ1(participants, j1rows) {
    destroyCharts();
    const panel = document.getElementById('j1Panel');
    if (panel) paintJ1Performance(panel, participants, j1rows);
  }

  // Shared J1 "Visa Processing" grouping (mirrors the C1/D logic) + chart with
  // per-bar drill-downs. Used by both the Progress tab and the mini-chart shown
  // on the Performance tab.
  function j1ProcessingGroups(rows) {
    const norm = v => String(v ?? '').trim();
    const low  = v => norm(v).toLowerCase();
    const nowT = Date.now();
    return [
      ['Pending DS-160', rows.filter(r => low(r['Payment Status']) === 'paid' && norm(r['Visa Status']) === '')],
      ['Pending Appointment', rows.filter(r => {
        if (low(r['Payment Status']) !== 'paid') return false;
        if (norm(r['Appointment Date']) !== '') return false;
        const vs = low(r['Visa Status']);
        return vs === 'visa payment processed' || vs === 'visa application processed';
      })],
      ['Secured Appointment', rows.filter(r => {
        const d = parseSheetDate(r['Appointment Date']);
        return d && d.getTime() > nowT;
      })],
    ];
  }
  function drawJ1ProcessingChart(canvasId, rows) {
    const groups = j1ProcessingGroups(rows);
    const s = (row, k) => esc(row[k] || '—');
    const col = {
      name:  { label: 'Name',             render: r => s(r, 'Name'),            sort: r => txtSort(r['Name']),           w: 200, wrap: true },
      email: { label: 'Email',            render: r => s(r, 'Email Address'),   sort: r => txtSort(r['Email Address']),  w: 230, wrap: true },
      prog:  { label: 'Program Number',   render: r => s(r, 'Program Number'),  sort: r => txtSort(r['Program Number']), w: 150 },
      pay:   { label: 'Payment Status',   render: r => s(r, 'Payment Status'),  sort: r => txtSort(r['Payment Status']), w: 130 },
      vstat: { label: 'Visa Status',      render: r => s(r, 'Visa Status'),     sort: r => txtSort(r['Visa Status']),    w: 180 },
      added: { label: 'Added Time',       render: r => formatSheetDate(r['Added Time']), sort: r => dateSort(parseSheetDate(r['Added Time'])), num: true, w: 140 },
      bniva: { label: 'BNIVA Number',     render: r => s(r, 'BNIVA Number'),    sort: r => txtSort(r['BNIVA Number']),   w: 140 },
      appt:  { label: 'Appointment Date', render: r => formatSheetDate(r['Appointment Date']), sort: r => dateSort(parseSheetDate(r['Appointment Date'])), num: true, w: 150 },
      appid: { label: 'Application ID',   render: r => s(r, 'Visa Application ID'), sort: r => txtSort(r['Visa Application ID']), w: 140 },
    };
    const ds160Cols   = [col.added, col.name, col.email, col.prog, col.pay, col.vstat, col.appid];
    const apptCols    = [col.added, col.name, col.email, col.prog, col.vstat, col.bniva, col.appt, col.appid];
    const securedCols = [col.name, col.email, col.prog, col.vstat, col.bniva, col.appt, col.appid];
    const counts = {};
    groups.forEach(([label, rs]) => { counts[label] = rs.length; });
    drawBar(canvasId, counts, label => {
      const g = groups.find(([l]) => l === label);
      if (!g || !g[1].length) return;
      const cols = label === 'Pending DS-160' ? ds160Cols
        : label === 'Pending Appointment' ? apptCols
        : securedCols;
      openDetailModal(g[1], cols, `J1 Visa — ${label}`);
    });
  }

  // Sub-tab 1 — Visa Performance: J1_Participants table (+ Visa Processing
  // chart in the top-right space, sharing the drill-downs).
  function paintJ1Performance(panel, allParticipants, j1rows) {
    // "Current Appt" = 3rd appt, else 2nd, else 1st.
    // "Current Appt" = 3rd appt, else 2nd, else 1st.
    const lastAppt = p => p.appt3 || p.appt2 || p.appt1 || null;
    const nowT = Date.now();
    // Program Source is bucketed into 4 fixed options; anything that isn't
    // MCSI / Bangkok / Vietnam is treated as CTI Indonesia.
    const sources = ['CTI MCSI', 'CTI Bangkok', 'CTI Vietnam', 'CTI Indonesia'];
    const sourceBucket = p => {
      const s = String(p.programSources ?? '').trim().toLowerCase();
      if (s === 'cti mcsi')    return 'CTI MCSI';
      if (s === 'cti bangkok' || s === 'bangkok career fair') return 'CTI Bangkok';
      if (s === 'cti vietnam') return 'CTI Vietnam';
      return 'CTI Indonesia';   // all other sources
    };
    const inSel = (arr, v) => !arr.length || arr.includes(v);
    // Filters: only real Hosting Company (exclude blank + "Application Process
    // On Hold"), J1 Program Sources (4 buckets), and Appointment record range
    // (past / upcoming relative to the Current Appt date).
    const applyFilters = () => allParticipants.filter(p => {
      const hc = String(p.hostingCompany ?? '').trim();
      if (!hc || hc === '—' || hc.toLowerCase() === 'application process on hold') return false;
      if (!inSel(_j1Filters.source, sourceBucket(p))) return false;
      if (_j1Filters.apptRange !== 'all') {
        const d = parseDate(lastAppt(p));
        if (!d) return false;   // no current appointment → not past nor upcoming
        if (_j1Filters.apptRange === 'past'     && !(d.getTime() <  nowT)) return false;
        if (_j1Filters.apptRange === 'upcoming' && !(d.getTime() >= nowT)) return false;
      }
      return true;
    });
    let participants = applyFilters();
    // Auto layout: every column sizes to its content (nowrap); Hosting Company
    // (cls j1-host, width:100% in CSS) soaks up any leftover horizontal space.
    const cols = [
      { label: 'Full Name',          render: p => esc(p.fullName),            sort: p => txtSort(p.fullName) },
      { label: 'Email',              render: p => esc(p.email),               sort: p => txtSort(p.email) },
      { label: 'J1 Program Sources', render: p => esc(p.programSources),      sort: p => txtSort(p.programSources) },
      { label: 'Hosting Company',    cls: 'j1-host', render: p => esc(p.hostingCompany), sort: p => txtSort(p.hostingCompany) },
      { label: 'Program Start',      render: p => formatDate(p.programStart), sort: p => dateSort(parseDate(p.programStart)), num: true },
      { label: 'J1 Visa Status',     render: p => badge(p.visaStatus),        sort: p => txtSort(p.visaStatus) },
      { label: '1st Appt',           render: p => formatDate(p.appt1),        sort: p => dateSort(parseDate(p.appt1)), num: true },
      { label: '2nd Appt',           render: p => formatDate(p.appt2),        sort: p => dateSort(parseDate(p.appt2)), num: true },
      { label: '3rd Appt',           render: p => formatDate(p.appt3),        sort: p => dateSort(parseDate(p.appt3)), num: true },
      { label: 'Current Appt',       render: p => formatDate(lastAppt(p)),    sort: p => dateSort(parseDate(lastAppt(p))), num: true },
    ];
    const cellTitle = html => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const bodyHtml = () => {
      const c = cols[_j1Sort.i];
      const rows = participants.slice().sort((a, b) => {
        const x = c.sort(a), y = c.sort(b);
        const xe = (x === null || x === ''), ye = (y === null || y === '');
        if (xe && ye) return 0; if (xe) return 1; if (ye) return -1;
        return (c.num ? (x - y) : String(x).localeCompare(String(y))) * _j1Sort.dir;
      });
      if (!rows.length) return `<tr><td colspan="${cols.length}" class="empty-row">No J1 participants found.</td></tr>`;
      return rows.map(p => `<tr>${cols.map(c => { const h = c.render(p); return `<td class="${c.cls || ''}" title="${esc(cellTitle(h))}">${h}</td>`; }).join('')}</tr>`).join('');
    };
    const headHtml = () => `<tr>${cols.map((c, i) =>
      `<th class="sortable ${c.cls || ''}" data-i="${i}">${c.label}${i === _j1Sort.i ? `<span class="sort-arrow">${_j1Sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>`;
    const hasChart = Array.isArray(j1rows) && j1rows.length;
    panel.innerHTML = `
      <div class="j1-perf-head">
        <div class="j1-perf-left">
          <div class="filter-bar">
            ${msHTML('j1Source', 'All Program Sources', sources, _j1Filters.source)}
            <select id="j1ApptRange" class="filter-select">
              <option value="all">All Appointment Records</option>
              <option value="past">Past Records</option>
              <option value="upcoming">Upcoming Records</option>
            </select>
            <button class="btn-sm" id="j1Clear">Clear</button>
          </div>
          <div class="toolbar"><span class="rec-count" id="j1Count"></span></div>
        </div>
        ${hasChart ? `<div class="card chart-card j1-perf-chart">
          <div class="card-title">J1 Visa — Visa Processing <span class="hint">(click a bar)</span></div>
          <canvas id="j1ChartPerf" height="150"></canvas>
        </div>` : ''}
      </div>
      <div class="card table-card"><div class="table-wrap"><table class="data-table j1-table">
        <thead id="j1Head">${headHtml()}</thead><tbody id="j1Body">${bodyHtml()}</tbody>
      </table></div></div>`;
    if (hasChart) drawJ1ProcessingChart('j1ChartPerf', j1rows);

    const apptSel = panel.querySelector('#j1ApptRange');
    apptSel.value = _j1Filters.apptRange;
    const updateCount = () => {
      const c = panel.querySelector('#j1Count');
      if (c) c.textContent = `${participants.length.toLocaleString()} participant${participants.length === 1 ? '' : 's'}`;
    };
    const refresh = () => {
      participants = applyFilters();
      panel.querySelector('#j1Body').innerHTML = bodyHtml();
      updateCount();
    };
    updateCount();

    wireMS(panel, 'j1Source', sel => { _j1Filters.source = sel; refresh(); });
    apptSel.onchange = () => { _j1Filters.apptRange = apptSel.value; refresh(); };
    panel.querySelector('#j1Clear').onclick = () => {
      _j1Filters = { source: [], apptRange: 'all' };
      destroyCharts();
      paintJ1Performance(panel, allParticipants, j1rows);
    };

    const wire = () => panel.querySelectorAll('#j1Head th.sortable').forEach(th => th.onclick = () => {
      const i = +th.dataset.i;
      if (i === _j1Sort.i) _j1Sort.dir = -_j1Sort.dir; else { _j1Sort.i = i; _j1Sort.dir = 1; }
      panel.querySelector('#j1Head').innerHTML = headHtml();
      panel.querySelector('#j1Body').innerHTML = bodyHtml();
      wire();
    });
    wire();
  }

  const ROUTES = { overview: renderOverview, records: renderRecords, documents: renderVisa, visa: renderVisa, pending: renderPending, j1: renderJ1 };
  const TITLES = { overview: 'Overview', records: 'Records', documents: 'Documents', visa: 'Documents', pending: 'Pending Action', j1: 'J1 Program' };

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
    Progress.start();
    try { await fetchFresh(frac => Progress.set(frac)); renderCurrentPage(); }
    catch (err) { toast(`Refresh failed: ${err.message}`, 'error'); }
    finally { Progress.done(); }
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

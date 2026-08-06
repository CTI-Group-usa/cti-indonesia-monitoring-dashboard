// Daily "last-minute" comparison, run by GitHub Actions at 06:00 WITA.
// Mirrors app.js refreshLastMinute / worker.js runDailyComparison exactly, but
// runs server-side against the live worker's existing endpoints (no Cloudflare
// deploy needed). Fetches current sign-on dates, compares them to the stored
// baseline in KV, updates the assignment + reschedule flags, advances the
// baseline, and stamps comparedAt = the run time (~06:00 WITA).
//
// Set DRY_RUN=1 to compute + print without writing to KV.

const PROXY = 'https://cti-indo-proxy.putu-astra.workers.dev';
const DAY = 86400000, FOUR_WK = 28 * DAY, FOUR_DAYS = 4 * DAY;

const seafarerDayKey = (t = Date.now()) => new Date(t + 2 * 3600000).toISOString().slice(0, 10);
const parseDate = v => { if (v == null || v === '' || v === '—') return null; const d = new Date(String(v).trim()); return isNaN(d) ? null : d; };
const signKey = d => d ? `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}` : null;
const parseSignKey = k => { if (!k) return null; const [y, m, dd] = String(k).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };

async function main() {
  const FIELDS = ['Crew_ID_Number', 'Sign_On_Date', 'Onboarding_Status'].join(',');
  let all = [], page = 1, more = true;
  while (more) {
    const r = await fetch(`${PROXY}/recruit/v2/Candidates?fields=${FIELDS}&page=${page}&per_page=200`, { cache: 'no-store' });
    if (r.status === 204) break;
    if (!r.ok) throw new Error('RECRUIT_' + r.status);
    const j = await r.json();
    all = all.concat(j.data || []);
    more = j.info && j.info.more_records === true;
    page++;
    if (all.length > 50000) break;
  }

  // "Today" = current WITA calendar date at midnight, as a UTC-anchored epoch.
  const w = new Date(Date.now() + 8 * 3600000);
  const nowT = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  const EXCL = ['resigned', 'process by mss philippines'];
  const byId = {}, todaySign = {};
  for (const rec of all) {
    const id = String(rec['Crew_ID_Number'] ?? '').trim();
    if (!id) continue;
    if (EXCL.includes(String(rec['Onboarding_Status'] ?? '').trim().toLowerCase())) continue;
    byId[id] = rec;
    const d = parseDate(rec['Sign_On_Date']);
    if (d) todaySign[id] = signKey(d);
  }

  const stateResp = await fetch(`${PROXY}/state/lastmin`, { cache: 'no-store' });
  const state = (await stateResp.json()) || { day: null, signon: {}, flags: {}, reschedFlags: {} };
  let flags = state.flags || {}, reschedFlags = state.reschedFlags || {};
  const dayKey = seafarerDayKey();
  const prev = state.signon || {};

  if (Object.keys(prev).length) {   // skip a first/reset run (empty baseline)
    for (const id of Object.keys(todaySign)) {
      if (prev[id] === todaySign[id]) continue;                 // sign-on unchanged
      const d = parseDate(byId[id]['Sign_On_Date']);
      if (d && d.getTime() >= nowT && d.getTime() < nowT + FOUR_WK) flags[id] = dayKey;
      const pd = parseSignKey(prev[id]);
      if (pd && pd.getTime() >= nowT && pd.getTime() <= nowT + FOUR_DAYS) reschedFlags[id] = dayKey;
    }
  }
  const DONE = ['report to ship', 'rescheduled', 'resigned'];
  for (const id of Object.keys(flags)) {
    const r = byId[id];
    if (!r) { delete flags[id]; continue; }
    const d = parseDate(r['Sign_On_Date']);
    const done = DONE.includes(String(r['Onboarding_Status'] ?? '').trim().toLowerCase());
    if (done || !d || d.getTime() < nowT) delete flags[id];
  }
  for (const id of Object.keys(reschedFlags)) {
    const r = byId[id];
    if (!r) { delete reschedFlags[id]; continue; }
    if (String(r['Onboarding_Status'] ?? '').trim().toLowerCase() === 'report to ship') delete reschedFlags[id];
  }

  const out = { day: dayKey, signon: todaySign, flags, reschedFlags, comparedAt: Date.now() };
  console.log(`records=${all.length} baseline=${Object.keys(prev).length} today=${Object.keys(todaySign).length} ` +
    `assign=${Object.keys(flags).length} resched=${Object.keys(reschedFlags).length} day=${dayKey}`);

  if (process.env.DRY_RUN) { console.log('DRY_RUN — not writing to KV'); return; }
  const put = await fetch(`${PROXY}/state/lastmin`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out),
  });
  if (!put.ok) throw new Error('STATE_PUT_' + put.status);
  console.log('KV updated, PUT', put.status);
}

main().catch(e => { console.error(e); process.exit(1); });

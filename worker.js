// ─────────────────────────────────────────────────────────────
//  CTI Indonesia Monitoring — Zoho proxy Worker
//  Deploy at: https://dash.cloudflare.com → Workers & Pages
//  Worker name suggestion: cti-indo-proxy
//
//  Secrets (Settings → Variables → add as *encrypted*):
//    ZOHO_CLIENT_ID
//    ZOHO_CLIENT_SECRET
//    ZOHO_REFRESH_TOKEN   (must include Recruit + Sheet scopes)
//
//  KV binding:
//    TOKEN_CACHE   (Workers KV namespace, bound as TOKEN_CACHE)
//
//  Refresh-token scopes to request when generating via Self Client:
//    ZohoRecruit.modules.ALL,
//    ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE
// ─────────────────────────────────────────────────────────────

const RECRUIT_BASE = 'https://recruit.zoho.com/recruit/v2';
const SHEET_BASE   = 'https://sheet.zoho.com/api/v2';
const ACCOUNTS     = 'https://accounts.zoho.com';

// Only these page origins may call the proxy from a browser. Add a
// localhost entry here temporarily if you need to test locally.
const ALLOWED_ORIGINS = [
  'https://cti-group-usa.github.io',
];

// Build CORS headers for a given request, echoing the origin only if
// it is allow-listed (so the proxy can't be used by arbitrary sites).
function cors(request) {
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export default {
  async fetch(request, env) {
    const CORS = cors(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Shared app state (KV) — GET/PUT small JSON blobs, no Zoho auth ──
    // Used by the dashboard's "Last Minutes Assignment" so all users share the
    // same daily snapshot. Stored in the existing TOKEN_CACHE KV under a prefix.
    if (path.startsWith('/state/')) {
      const key = 'appstate:' + path.slice('/state/'.length);
      if (request.method === 'GET') {
        const v = await env.TOKEN_CACHE.get(key);
        return new Response(v || 'null', {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        await env.TOKEN_CACHE.put(key, await request.text());
        return json({ ok: true }, 200, CORS);
      }
      return json({ error: 'Method not allowed' }, 405, CORS);
    }

    try {
      const token = await getAccessToken(env);

      // ── Zoho Recruit ──────────────────────────────────────
      if (path.startsWith('/recruit/v2/')) {
        const target = new URL(RECRUIT_BASE + path.replace('/recruit/v2', ''));
        url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
        return proxy(target.toString(), request, token, CORS);
      }

      // ── Zoho Sheet ────────────────────────────────────────
      if (path.startsWith('/sheet/v2/')) {
        const target = SHEET_BASE + path.replace('/sheet/v2', '');
        return proxy(target, request, token, CORS);
      }

      return json({ error: 'Not found' }, 404, CORS);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, CORS);
    }
  },

  // ── Cron: fixed daily "last-minute" comparison at 06:00 WITA ──────────
  // Configured in wrangler.jsonc as "0 22 * * *" (22:00 UTC = 06:00 WITA).
  // Pulls current sign-on dates, compares them to the stored baseline, updates
  // the shared last-minute assignment + reschedule flags, then advances the
  // baseline and stamps comparedAt — so the dashboard shows a stable daily list
  // with a "Last compared" time, independent of who opens it.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyComparison(env));
  },
};

// Seafarer "business day" key (boundary 06:00 WITA); matches the frontend.
function seafarerDayKey(t = Date.now()) {
  return new Date(t + 2 * 3600000).toISOString().slice(0, 10);   // "YYYY-MM-DD"
}

async function runDailyComparison(env) {
  const token = await getAccessToken(env);
  const FIELDS = ['Crew_ID_Number', 'Sign_On_Date', 'Onboarding_Status'].join(',');
  let all = [], page = 1, more = true;
  while (more) {
    const url = `${RECRUIT_BASE}/Candidates?fields=${FIELDS}&page=${page}&per_page=200`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) break;
    if (!r.ok) throw new Error('RECRUIT_' + r.status);
    const j = await r.json();
    all = all.concat(j.data || []);
    more = j.info && j.info.more_records === true;
    page++;
    if (all.length > 50000) break;
  }

  const DAY = 86400000, FOUR_WK = 28 * DAY, FOUR_DAYS = 4 * DAY;
  // "Today" = current WITA calendar date at midnight, as a UTC-anchored epoch.
  const w = new Date(Date.now() + 8 * 3600000);
  const nowT = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  const parseDate = v => { if (v == null || v === '' || v === '—') return null; const d = new Date(String(v).trim()); return isNaN(d) ? null : d; };
  // UTC getters so date-only strings key identically to the WITA frontend.
  const signKey = d => d ? `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}` : null;
  const parseSignKey = k => { if (!k) return null; const [y, m, dd] = String(k).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };

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

  const KEY = 'appstate:lastmin';
  const state = JSON.parse((await env.TOKEN_CACHE.get(KEY)) || 'null') || { day: null, signon: {}, flags: {}, reschedFlags: {} };
  let flags = state.flags || {}, reschedFlags = state.reschedFlags || {};
  const dayKey = seafarerDayKey();
  const prev = state.signon || {};

  if (Object.keys(prev).length) {   // skip first run (empty baseline)
    for (const id of Object.keys(todaySign)) {
      if (prev[id] === todaySign[id]) continue;                 // sign-on unchanged
      const d = parseDate(byId[id]['Sign_On_Date']);
      if (d && d.getTime() >= nowT && d.getTime() < nowT + FOUR_WK) flags[id] = dayKey;
      const pd = parseSignKey(prev[id]);
      if (pd && pd.getTime() >= nowT && pd.getTime() <= nowT + FOUR_DAYS) reschedFlags[id] = dayKey;
    }
  }
  // Assignment flags clear when handled / gone / sign-on passed.
  const DONE = ['report to ship', 'rescheduled', 'resigned'];
  for (const id of Object.keys(flags)) {
    const r = byId[id];
    if (!r) { delete flags[id]; continue; }
    const d = parseDate(r['Sign_On_Date']);
    const done = DONE.includes(String(r['Onboarding_Status'] ?? '').trim().toLowerCase());
    if (done || !d || d.getTime() < nowT) delete flags[id];
  }
  // Reschedule flags clear ONLY once reported to ship (or the record is gone).
  for (const id of Object.keys(reschedFlags)) {
    const r = byId[id];
    if (!r) { delete reschedFlags[id]; continue; }
    if (String(r['Onboarding_Status'] ?? '').trim().toLowerCase() === 'report to ship') delete reschedFlags[id];
  }

  state.signon = todaySign;
  state.day = dayKey;
  state.flags = flags;
  state.reschedFlags = reschedFlags;
  state.comparedAt = Date.now();
  await env.TOKEN_CACHE.put(KEY, JSON.stringify(state));
}

// Forward a request to Zoho with the OAuth header, preserving
// method / body / content-type. Adds CORS to the response.
async function proxy(targetUrl, request, token, CORS) {
  const init = {
    method: request.method,
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ct = request.headers.get('Content-Type');
    if (ct) init.headers['Content-Type'] = ct;
    init.body = await request.text();
  }
  const resp = await fetch(targetUrl, init);
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      ...CORS,
      'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      // Never cache live Zoho data at the browser or any CDN edge.
      'Cache-Control': 'no-store',
    },
  });
}

// Cache the access token in KV for 55 minutes.
async function getAccessToken(env) {
  const cached = await env.TOKEN_CACHE.get('access_token');
  if (cached) return cached;

  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id:     env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const resp = await fetch(`${ACCOUNTS}/oauth/v2/token?${params}`, { method: 'POST' });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('TOKEN_REFRESH_FAILED: ' + JSON.stringify(data));
  }
  await env.TOKEN_CACHE.put('access_token', data.access_token, { expirationTtl: 3300 });
  return data.access_token;
}

function json(obj, status = 200, CORS = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

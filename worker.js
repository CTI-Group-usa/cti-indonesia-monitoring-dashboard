// ─────────────────────────────────────────────────────────────
//  CTI Indonesia Monitoring — Zoho proxy Worker
//  Deploy at: https://dash.cloudflare.com → Workers & Pages
//  Worker name suggestion: cti-indo-proxy
//
//  Secrets (Settings → Variables → add as *encrypted*):
//    ZOHO_CLIENT_ID
//    ZOHO_CLIENT_SECRET
//    ZOHO_REFRESH_TOKEN   (must include Recruit + Sheet scopes)
//    SSO_TENANT_ID        (Azure AD tenant ID — "CTI Indonesia Monitoring" app)
//    SSO_CLIENT_ID        (Azure AD app (client) ID)
//    SSO_CLIENT_SECRET    (Azure AD client secret)
//    AUTOMATION_KEY       (shared secret for the daily-comparison.mjs
//                          GitHub Action — the only non-human caller;
//                          generate any long random string)
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

// ── Microsoft 365 SSO (non-secret constants — the Client Secret/Tenant/
//    Client IDs are Worker secrets, see header above) ─────────────────
const SSO_REDIRECT_URI     = 'https://cti-indo-proxy.putu-astra.workers.dev/api/auth/callback';
const SSO_APP_HOME         = 'https://cti-group-usa.github.io/cti-indonesia-monitoring-dashboard/index.html';
const SSO_LOGIN_PAGE       = 'https://cti-group-usa.github.io/cti-indonesia-monitoring-dashboard/login.html';
const ALLOWED_EMAIL_DOMAIN = 'cti-usa.com';
const SESSION_TTL_SEC      = 7 * 24 * 3600;   // 7 days

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
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Auth-Token,X-Automation-Key',
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

    // ── Microsoft 365 SSO — sign-in flow (public, no session required) ──
    if (path === '/api/auth/login')    return ssoLogin(env, CORS);
    if (path === '/api/auth/callback') return ssoCallback(request, env, CORS);
    if (path === '/api/auth/me')       return ssoMe(request, env, CORS);
    if (path === '/api/auth/logout')   return ssoLogout(request, env, CORS);

    // ── Everything below requires a signed-in session (or the automation
    // key used by the daily-comparison.mjs GitHub Action). Previously these
    // routes had NO server-side auth at all — the local username/password
    // check only gated the frontend, so anyone who knew the Worker URL could
    // query live seafarer data directly (confirmed via curl 2026-08-12).
    // The dashboard's real access control now lives here, not in the browser.
    if (!(await resolveUser(request, env))) {
      return json({ error: 'Unauthorized' }, 401, CORS);
    }

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

  // Guard against an incomplete fetch (dropped page, rate limit, timeout).
  // Seafarers leave the dataset gradually, never in bulk -- so a big drop
  // vs. yesterday's count means THIS fetch is broken, not that hundreds of
  // people vanished. Without this check, the clearing loop below would treat
  // every missing-this-run ID as "record gone" and permanently delete its
  // flag -- indistinguishable from a legitimate clear. Abort without writing
  // so a bad run can never look like ground truth.
  const prevCount = Object.keys(prev).length, todayCount = Object.keys(byId).length;
  if (prevCount > 0 && todayCount < prevCount * 0.9) {
    console.error(`runDailyComparison: aborting, suspicious record-count drop ${prevCount} -> ${todayCount} (possible incomplete fetch)`);
    return;
  }

  if (Object.keys(prev).length) {   // skip first run (empty baseline)
    for (const id of Object.keys(todaySign)) {
      if (prev[id] === todaySign[id]) continue;                 // sign-on unchanged
      const d = parseDate(byId[id]['Sign_On_Date']);
      if (d && d.getTime() >= nowT && d.getTime() < nowT + FOUR_WK) flags[id] = dayKey;
      const pd = parseSignKey(prev[id]);
      if (pd && pd.getTime() >= nowT && pd.getTime() <= nowT + FOUR_DAYS) reschedFlags[id] = dayKey;
    }
  }
  // A flag clears ONLY once onboarding becomes Report to Ship / Rescheduled /
  // Resigned, or the record is gone. A past (or blank) sign-on date does NOT
  // clear it — matches app.js refreshLastMinute() and daily-comparison.mjs.
  const DONE = ['report to ship', 'rescheduled', 'resigned'];
  for (const id of Object.keys(flags)) {
    const r = byId[id];
    if (!r) { delete flags[id]; continue; }
    if (DONE.includes(String(r['Onboarding_Status'] ?? '').trim().toLowerCase())) delete flags[id];
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

// ── Microsoft 365 SSO ──────────────────────────────────────────────
// Server-side OAuth 2.0 authorization-code flow (same pattern as ZeusHire's
// worker.js) — no MSAL/SDK on the frontend. The browser only redirects to
// /api/auth/login and later reads a session token back from the URL
// fragment; Microsoft's own tokens never reach the browser.

async function ssoLogin(env, CORS) {
  const state = crypto.randomUUID();
  await env.TOKEN_CACHE.put('ssostate:' + state, '1', { expirationTtl: 600 });
  const authUrl = `https://login.microsoftonline.com/${env.SSO_TENANT_ID}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: env.SSO_CLIENT_ID, response_type: 'code', redirect_uri: SSO_REDIRECT_URI,
      response_mode: 'query', scope: 'openid profile email', state,
    });
  return new Response(null, { status: 302, headers: { ...CORS, Location: authUrl } });
}

async function ssoCallback(request, env, CORS) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthErr = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (oauthErr) return ssoError(oauthErr, CORS);
  if (!code) return ssoError('No authorization code returned.', CORS);
  if (!state || !(await env.TOKEN_CACHE.get('ssostate:' + state))) {
    return ssoError('Invalid or expired sign-in request. Please try signing in again.', CORS);
  }
  await env.TOKEN_CACHE.delete('ssostate:' + state);

  const tokenRes = await fetch(`https://login.microsoftonline.com/${env.SSO_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SSO_CLIENT_ID, client_secret: env.SSO_CLIENT_SECRET, code,
      redirect_uri: SSO_REDIRECT_URI, grant_type: 'authorization_code', scope: 'openid profile email',
    }),
  });
  const tok = await tokenRes.json();
  if (!tok.id_token) return ssoError('Sign-in failed: ' + (tok.error_description || tok.error || 'unknown error'), CORS);

  let claims;
  try { claims = decodeJwt(tok.id_token); } catch { return ssoError('Invalid identity token.', CORS); }
  if (claims.tid !== env.SSO_TENANT_ID) return ssoError('This sign-in is not from the CTI organization.', CORS);
  const email = String(claims.preferred_username || claims.email || '').toLowerCase();
  if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
    return ssoError(`Only @${ALLOWED_EMAIL_DOMAIN} accounts may sign in to this dashboard.`, CORS);
  }

  const sessionToken = crypto.randomUUID();
  await env.TOKEN_CACHE.put('authsession:' + sessionToken, JSON.stringify({
    email, name: claims.name || email, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_SEC * 1000,
  }), { expirationTtl: SESSION_TTL_SEC });

  // Fragment (not query string) so the session token never hits server logs.
  return new Response(null, { status: 302, headers: { ...CORS, Location: `${SSO_APP_HOME}#authToken=${sessionToken}` } });
}

async function ssoMe(request, env, CORS) {
  const user = await resolveUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, CORS);
  return json({ email: user.email, name: user.name }, 200, CORS);
}

async function ssoLogout(request, env, CORS) {
  const token = request.headers.get('X-Auth-Token');
  if (token) await env.TOKEN_CACHE.delete('authsession:' + token);
  return json({ ok: true }, 200, CORS);
}

// Resolves the caller for every non-auth route: either a valid SSO session
// (X-Auth-Token) or the automation key used by the daily-comparison.mjs
// GitHub Action (X-Automation-Key) — the one legitimate non-human caller.
async function resolveUser(request, env) {
  const autoKey = request.headers.get('X-Automation-Key');
  if (autoKey && env.AUTOMATION_KEY && autoKey === env.AUTOMATION_KEY) {
    return { email: 'automation', name: 'Daily Comparison Job' };
  }
  const token = request.headers.get('X-Auth-Token');
  if (!token) return null;
  const raw = await env.TOKEN_CACHE.get('authsession:' + token);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (session.expiresAt < Date.now()) return null;
  return session;
}

// Decode a JWT payload (id_token from Microsoft's token endpoint — already
// trusted over TLS via our client secret exchange, so no JWKS signature
// check here; same simplification ZeusHire's worker.js makes).
function decodeJwt(jwt) {
  const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function ssoError(msg, CORS) {
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a1a">
<h2>Sign-in failed</h2><p>${esc(msg)}</p><p><a href="${SSO_LOGIN_PAGE}">Back to sign in</a></p></body></html>`;
  return new Response(html, { status: 401, headers: { ...CORS, 'Content-Type': 'text/html' } });
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

  // Cooldown guard (added 2026-08-12): a failed refresh was never cached, so
  // EVERY request while broken (dashboard auto-refresh every 5min, manual
  // reloads, cron, etc.) retried Zoho's token endpoint immediately with zero
  // backoff -- almost certainly what turned one transient Zoho rate-limit
  // ("You have made too many requests continuously") into a self-perpetuating
  // block that never got a clean window to expire. With multiple people using
  // the dashboard concurrently, even a short cooldown gets reset by the next
  // person's request before Zoho's throttle actually clears -- so this is a
  // hard 30-minute block on ANY retry after a failure, regardless of how many
  // users hit the Worker in that window, guaranteeing Zoho gets one real quiet
  // period.
  const cooldownKey = 'token_refresh_cooldown';
  if (await env.TOKEN_CACHE.get(cooldownKey)) {
    throw new Error('TOKEN_REFRESH_COOLDOWN: blocked for 30min after a Zoho rate-limit; not retrying yet.');
  }

  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id:     env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const resp = await fetch(`${ACCOUNTS}/oauth/v2/token?${params}`, { method: 'POST' });
  const data = await resp.json();
  if (!data.access_token) {
    await env.TOKEN_CACHE.put(cooldownKey, '1', { expirationTtl: 1800 });
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
// trigger redeploy 2026-08-12T02:57:47Z

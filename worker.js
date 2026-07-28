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
};

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

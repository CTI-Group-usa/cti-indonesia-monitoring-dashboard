// ─────────────────────────────────────────────────────────────
//  AUTH — Microsoft 365 SSO
//  Server-side OAuth (worker.js /api/auth/*) — no MSAL/SDK here. The
//  browser only redirects to the login endpoint and reads a session
//  token back from the URL fragment after Microsoft signs the user in.
// ─────────────────────────────────────────────────────────────
const Auth = (() => {
  const TOKEN_KEY = 'cti_indo_auth_token';
  let _user = null;   // { email, name } once a session has been validated

  function loginWithMicrosoft() {
    window.location.href = `${CONFIG.PROXY}/api/auth/login`;
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() { return _user; }

  function authHeaders() {
    const t = getToken();
    return t ? { 'X-Auth-Token': t } : {};
  }

  // Captures a token handed back in the URL fragment (right after the
  // Microsoft redirect), or falls back to a previously stored one, then
  // validates it against the Worker. Returns the user object on success,
  // null otherwise (and clears a token that no longer validates).
  async function init() {
    const m = location.hash.match(/authToken=([^&]+)/);
    if (m) {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    const token = getToken();
    if (!token) return null;
    try {
      const resp = await fetch(`${CONFIG.PROXY}/api/auth/me`, { headers: authHeaders(), cache: 'no-store' });
      if (!resp.ok) { localStorage.removeItem(TOKEN_KEY); return null; }
      _user = await resp.json();
      return _user;
    } catch {
      // Network error — treat as "not verified yet" rather than trusting a
      // stale token, but don't wipe it (could just be offline momentarily).
      return null;
    }
  }

  // Guard for index.html: call before rendering the app. Redirects to
  // login.html if there's no valid session; returns the user otherwise.
  async function requireAuth() {
    const user = await init();
    if (!user) { window.location.replace('login.html'); return null; }
    return user;
  }

  async function logout() {
    const token = getToken();
    localStorage.removeItem(TOKEN_KEY);
    if (token) {
      try { await fetch(`${CONFIG.PROXY}/api/auth/logout`, { method: 'POST', headers: { 'X-Auth-Token': token } }); }
      catch { /* ignore — we've already dropped the local token */ }
    }
    window.location.replace('login.html');
  }

  return { loginWithMicrosoft, init, requireAuth, getUser, getToken, authHeaders, logout };
})();

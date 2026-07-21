// ─────────────────────────────────────────────────────────────
//  AUTH — local dashboard session (username/password)
// ─────────────────────────────────────────────────────────────
const Auth = (() => {
  const SESSION_KEY = 'cti_indo_session';

  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function login(username, password) {
    const user = CONFIG.USERS[username.toLowerCase()];
    if (!user) return null;
    const hash = await sha256(password);
    if (hash !== user.hash) return null;
    const session = { user: username.toLowerCase(), role: user.role, loginAt: Date.now() };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return user.role;
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace('login.html');
  }

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
    catch { return null; }
  }

  function requireAuth() {
    if (!getSession()) { window.location.replace('login.html'); return false; }
    return true;
  }

  return { login, logout, getSession, requireAuth };
})();

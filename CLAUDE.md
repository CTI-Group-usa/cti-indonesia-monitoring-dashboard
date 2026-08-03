# CTI Indonesia Monitoring Dashboard — Project Context for Claude

## What This Is
A vanilla JS single-page application (SPA) for CTI Group Worldwide Services, Inc.
to **monitor Indonesia-side records**. It is a **pull-and-push** dashboard:

- **Pull:** live data from the **Zoho Recruit `Candidates` module** (shown in
  Recruit as **"Seafarers"** — maritime crew) + **two Zoho Sheets** merged in
  per seafarer: **Visa Registration Log** and **Cruise Line Deployment Report**.
- **Push:** edits in the UI write back to Zoho Recruit (Seafarer Status =
  `Candidate_Status`). Sheet columns are read-only until `SHEETS[].editable`
  is configured (see zoho.js `updateSheet(record, sheetKey, data)`).

Deployed on **GitHub Pages**. No build tools, no framework — plain HTML/CSS/JS.
Modeled on the J1 Dashboard (`C:\Users\putua\j1-dashboard`).

## Repository
- **GitHub:** `https://github.com/CTI-Group-usa/cti-indonesia-monitoring-dashboard` (org repo, Public)
- **Local path:** `C:\Users\putua\cti-indonesia-monitoring-dashboard\`
- **Branch:** `main` → auto-deploys to GitHub Pages
- **Live URL (after Pages enabled):** `https://cti-group-usa.github.io/cti-indonesia-monitoring-dashboard/`

## File Structure
```
index.html   — SPA shell, sidebar, topbar, edit modal, auth guard
login.html   — Login page (self-contained styles)
app.js       — SPA router + pages (Overview, Records) + edit/push logic
zoho.js      — Zoho Recruit + Zoho Sheet client; merge (pull) + write-back (push)
config.js    — Module/field mappings, Sheet config, users, branding  ← FILL IN
auth.js      — Local username/password auth (SHA-256, sessionStorage)
style.css    — All styles (dark/light via CSS variables)
worker.js    — Cloudflare Worker source (reference; deploy manually)
logo.png     — CTI Group logo
.nojekyll    — disables Jekyll on GitHub Pages
```

## Data Flow
```
Browser → Cloudflare Worker (cti-indo-proxy.*.workers.dev)
        → Zoho Recruit API  (Candidates module, CONFIG.RECRUIT_MODULE)
        → Zoho Sheet  API   (v2 data API, one call per CONFIG.SHEETS[] entry)
```
- `zoho.js → getAllRecords()` pulls Recruit + every sheet in parallel, indexes
  each sheet by its `keyColumn`, and merges rows onto each seafarer by matching
  the record field named in `matchOn` (default `email`). `_sheetRows[key]`
  flags which sheets matched.
- Worker holds the Zoho refresh token as a **secret** and auto-refreshes the
  access token (cached 55 min in KV namespace `TOKEN_CACHE`).
- The browser never handles tokens.
- Recruit + Sheet rows are joined in `zoho.js → getAllRecords()` (see Data Flow).

## Cloudflare Worker (dedicated to this project)
- **Name:** `cti-indo-proxy`
- **Live URL:** `https://cti-indo-proxy.putu-astra.workers.dev` (see `config.js → PROXY`)
- **⚠️ Deploy account:** the **`putu-astra`** Cloudflare account (workers.dev
  subdomain `putu-astra`) — this holds the live worker + Zoho secrets. This is a
  **different** account from `putuastrawijaya@gmail.com` (subdomain
  `putuastrawijaya`); do not deploy there.
- **Auto-deploy:** GitHub Actions (`.github/workflows/deploy-worker.yml`) runs
  `wrangler deploy` on every push to `main` that touches `worker.js`,
  `wrangler.jsonc`, or `package.json`. Config lives in `wrangler.jsonc`.
  Requires GitHub repo secret `CLOUDFLARE_API_TOKEN` (scoped to the `putu-astra`
  account) and the real account ID + `TOKEN_CACHE` KV namespace ID filled into
  `wrangler.jsonc`.
- **Secrets:** `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
  (set on the Worker; preserved across deploys — not in `wrangler.jsonc`).
- **KV binding:** `TOKEN_CACHE`
- **Routes:** `/recruit/v2/*` → Zoho Recruit, `/sheet/v2/*` → Zoho Sheet
- **Refresh-token scopes (generate via Zoho Self Client):**
  `ZohoRecruit.modules.ALL,ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE`

## Zoho Sheets (CONFIG.SHEETS)
Two sheets, merged per seafarer:
- **Visa Registration Log** — resourceId `vpzkvba5ae0adfc1247a8b7383dbef6ea3d8d`
- **Cruise Line Deployment Report** — resourceId `begbjf0b04d7026534b328e36baa0a9d82df7`

Each entry needs (⚠️ still to confirm): `worksheet` (tab name), `matchOn`
(record field: email/seafarerId/name), `keyColumn` (that value's header in the
sheet), and `columns` (app field → exact header text).

## ⚠️ Setup checklist (before it shows live data)
1. `config.js → PROXY` — the deployed worker URL. ← still needed
2. ✅ `config.js → RECRUIT_MODULE` = `Candidates` (Seafarers) — done.
3. ✅ `config.js → FIELDS` — mapped to the Candidates module API names — done.
4. ✅ `config.js → SHEETS[].resourceId` — both sheet IDs set — done.
5. `config.js → SHEETS[].worksheet / matchOn / keyColumn / columns` — confirm tab
   names, join keys, and column headers for both sheets. ← still needed
6. `config.js → USERS` — replace the default `changeme` password hashes. ← still needed
7. ✅ Worker deployed with the three secrets + KV binding (in the `putu-astra` account).
8. Worker auto-deploy (GitHub Actions): add repo secret `CLOUDFLARE_API_TOKEN`
   (putu-astra account) + fill the two IDs in `wrangler.jsonc`. ← still needed

## Pages
| Page | Route | Description |
|------|-------|-------------|
| Overview | `#overview` | Stat cards (Total Seafarers, Visa Logged, Deployed, Active) + By Status / By CTI Office charts |
| Records  | `#records`  | Searchable merged table (Name/email, CTI Office, Position, Seafarer Status, Visa Status, Deployment); **Edit** pushes Seafarer Status to Recruit and shows both sheets' data |

## Key Patterns
- **Merge:** `zoho.js` indexes each sheet by its `keyColumn` and attaches its
  `columns` to matching records; `_sheetRows[key]` flags which sheets matched.
- **Push:** `updateRecruit()` PUTs to the module. `updateSheet(record, sheetKey,
  data)` writes to a named sheet (used once `editable` columns are configured).
- **Auth:** local SHA-256 in `config.js → USERS`, session in `sessionStorage`.
- **Cache busting:** asset URLs use `?v=YYYYMMDD` — bump on each FE change.
- **UI copy:** English only.

## Deployment
```bash
git add -A
git commit -m "Description"
git push
# Frontend (HTML/CSS/JS): GitHub Pages deploys in ~1-2 min.
# Worker (worker.js/wrangler.jsonc): GitHub Actions runs `wrangler deploy`
#   to the putu-astra account automatically (see Cloudflare Worker section).
```

## Credentials & Logins
- Dashboard default login: `admin` / `changeme` (⚠️ change before real use)
- Cloudflare (live worker): **`putu-astra`** account (workers.dev subdomain
  `putu-astra`). NOTE: `putuastrawijaya@gmail.com` is a *separate* account and
  does NOT host this worker.
- GitHub: PutuAstra (repo under org `CTI-Group-usa`)

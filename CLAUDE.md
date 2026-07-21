# CTI Indonesia Monitoring Dashboard — Project Context for Claude

## What This Is
A vanilla JS single-page application (SPA) for CTI Group Worldwide Services, Inc.
to **monitor Indonesia-side records**. It is a **pull-and-push** dashboard:

- **Pull:** live data from a custom **Zoho Recruit** module + supplementary
  monitoring data from a **Zoho Sheet**, merged on a shared key (email).
- **Push:** edits in the UI write back to Zoho Recruit (status) and the Zoho
  Sheet (monitoring status, notes, follow-up, handled-by).

Deployed on **GitHub Pages**. No build tools, no framework — plain HTML/CSS/JS.
Modeled on the J1 Dashboard (`C:\Users\putua\j1-dashboard`).

## Repository
- **GitHub:** `https://github.com/PutuAstra/cti-indonesia-monitoring-dashboard` (create on first push)
- **Local path:** `C:\Users\putua\cti-indonesia-monitoring-dashboard\`
- **Branch:** `main` → auto-deploys to GitHub Pages
- **Live URL (after Pages enabled):** `https://putuastra.github.io/cti-indonesia-monitoring-dashboard/`

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
        → Zoho Recruit API  (custom module, CONFIG.RECRUIT_MODULE)
        → Zoho Sheet  API   (v2 data API, CONFIG.SHEET.resourceId)
```
- Worker holds the Zoho refresh token as a **secret** and auto-refreshes the
  access token (cached 55 min in KV namespace `TOKEN_CACHE`).
- The browser never handles tokens.
- Recruit + Sheet rows are joined in `zoho.js → getAllRecords()` on the email key.

## Cloudflare Worker (dedicated to this project)
- **Suggested name:** `cti-indo-proxy`
- **Source:** `worker.js` in this repo (paste into the dashboard; not auto-deployed).
- **Secrets:** `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- **KV binding:** `TOKEN_CACHE`
- **Routes:** `/recruit/v2/*` → Zoho Recruit, `/sheet/v2/*` → Zoho Sheet
- **Refresh-token scopes (generate via Zoho Self Client):**
  `ZohoRecruit.modules.ALL,ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE`

## ⚠️ Setup checklist (before it shows live data)
1. `config.js → PROXY` — the deployed worker URL.
2. `config.js → RECRUIT_MODULE` — custom module API name.
3. `config.js → FIELDS` — map each app field to its Zoho API field name.
4. `config.js → SHEET.resourceId` — from the Zoho Sheet URL.
5. `config.js → SHEET.worksheet / mergeKey / columns` — worksheet + column headers.
6. `config.js → USERS` — replace the default `changeme` password hashes.
7. Deploy the worker with the three secrets + KV binding above.

## Pages
| Page | Route | Description |
|------|-------|-------------|
| Overview | `#overview` | Stat cards (Total, In Monitoring, Active, Follow-ups) + By Status / By City charts |
| Records  | `#records`  | Searchable merged table; **Edit** opens a modal that pushes to Recruit + Sheet |

## Key Patterns
- **Merge:** `zoho.js` indexes Sheet rows by `SHEET.mergeKey` (case-insensitive)
  and attaches `SHEET.columns` to matching Recruit records; `_hasSheetRow` flags matches.
- **Push:** `updateRecruit()` PUTs to the module; `updateSheet()` updates the matched
  row (or appends one if the record has no Sheet row yet).
- **Auth:** local SHA-256 in `config.js → USERS`, session in `sessionStorage`.
- **Cache busting:** asset URLs use `?v=YYYYMMDD` — bump on each FE change.
- **UI copy:** English only.

## Deployment
```bash
git add -A
git commit -m "Description"
git push
# GitHub Pages deploys in ~1-2 min
```

## Credentials & Logins
- Dashboard default login: `admin` / `changeme` (⚠️ change before real use)
- Cloudflare: account `putuastrawijaya`
- GitHub: PutuAstra

---
name: verify
description: Build/launch/drive recipe for verifying web UI changes in this repo (Next.js web + Fastify API + dockerized postgres)
---

# Verifying changes in this repo

## Launch

- **Postgres:** `docker compose up -d postgres` (needs Docker Desktop: `open -a Docker`, wait for `docker info` to succeed). Containernamnen är projekt-härledda sedan G2 (`dev-postgres-1` m.fl.) — adressera via `docker compose exec postgres …`. DB `erp`/`erp`/`erp_dev_password` on :5432. The dev volume usually already has migrated tables + an admin user (`admin@navet.local`).
- **API:** from `apps/api`:
  `DATABASE_URL="postgresql://erp:erp_dev_password@localhost:5432/erp" JWT_SECRET="dev-secret-change-me" WEB_ORIGIN="http://localhost:3000" npm run dev` → :4000, health at `/health`. Routes are prefixed `/api/v1`.
- **Web:** from `apps/web`: `npm run dev` → :3000.

## Drive / screenshot

No Playwright in the repo, but the Playwright browser cache exists at
`~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
Install `playwright-core` in the scratchpad and `chromium.launch({ executablePath })` with that binary.

- **Auth:** registration is closed once a user exists. Instead sign a session JWT with the API's dev secret (payload `{ sub: <user-uuid>, role: "admin" }`, secret `dev-secret-change-me`, lib `jsonwebtoken` from `apps/api/node_modules`) and set it as the `session` cookie on localhost:3000. Get the user uuid via `docker compose exec postgres psql -U erp -d erp -tc "select id from users limit 1"`.
- **Dark mode:** theme is `data-theme` on `<html>`, set by ThemeToggle from localStorage key `nav-erp-theme`. On pages without the toggle (login/register), set the attribute with `page.evaluate` *after* load — Playwright init scripts run before `documentElement` exists.

## Gotchas

- `apps/web/proxy.ts` redirects (307) every non-exempted path to `/login` when the `session` cookie is missing — remember to extend its `matcher` exclusion list when adding new public/static root-level assets.
- Server Components fetch the API server-side; without the API running, `/` shows a "fetch failed" dev overlay even with a session cookie.

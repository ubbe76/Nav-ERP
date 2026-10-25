---
paths:
  - "apps/api/src/modules/system/**"
  - "apps/api/src/modules/demo/**"
  - "apps/web/app/system/exempeldata/**"
  - "apps/web/app/system/kom-igang/**"
  - "apps/web/components/onboarding/**"
  - "apps/web/components/Favorite*"
  - "apps/web/lib/favorites.ts"
  - "packages/shared/src/user-settings.ts"
  - "scripts/**"
  - "apps/api/test/demo*"
  - "apps/api/test/onboarding*"
  - "apps/api/test/user*"
  - "apps/api/test/backup*"
---

# System: exempeldata, Kom igång, favoriter, backup

## Exempeldata

- Modulen `demo` (`GET/POST /demo-data`, admin) skapar det påhittade storköksföretaget i `demo/service/demo-data.ts` (ren datafil) i EN transaktion under `pg_advisory_xact_lock(hashtext('demo_data'))`, bara när artiklar, kunder, leverantörer och resurser alla är tomma (annars 409 `demo-data-not-available` med `blockers`). Ingen borttagning (append-only lager). Sidan `/system/exempeldata`.
- Grunddata återanvänds: artikelgrupper, betalningsvillkor och enheter vid samma kod ELLER namn (båda är unika), produktionsgrupper vid samma kod, lagerplatser vid samma namn — och lagerplatserna läggs aldrig under reservlagret `***` (på en ny installation det enda lagret) utan under ett eget *Huvudlager*.
- Skrivningen (`demo-data.repository.ts`) går genom de befintliga Tx-hjälparna (`insertArticle`, `insertRoutingOperations`, `insertBomRows`, `replacePriceBreaks`, `resolveStockLocation`, `getNextOrderNumber`). De tillverkade artiklarnas standardpris är kalkylens TVK/st vid antal 1 — `demo-data-flows.test.ts` håller dem i synk, så **en kalkyländring kan kräva nya värden i datafilen**.

## Kom igång (onboarding)

- `system/service/onboarding.ts` är steglistan (nio steg i fyra grupper) och rena `buildOnboarding(facts)`; `onboarding.repository.ts` läser faktan med existensfrågor vid varje anrop — stegens status lagras aldrig, utom `system_settings.onboarding_number_series_reviewed` (**Markera som granskade**, loggas). `GET /onboarding` + `POST /onboarding/number-series-reviewed` är admin. Dölj är användarinställningen `hideOnboarding` (`hide_onboarding`).
- Webben: `components/onboarding/` — Översiktens kort (bara admin, fångar fel; Översikten monterar `ConfirmDialogHost` själv eftersom den saknar AppShell) och `/system/kom-igang`. **Ett nytt steg = en post i `STEPS` + ett faktum i `OnboardingFacts`/repositoryt + manualens lista.**

## Favoriter

- Användarinställningen `favorites` (`user_settings`, `favoriteSchema` i `packages/shared/src/user-settings.ts`, webbspegel `apps/web/lib/favorites.ts`): ordnad lista `{ href, title }`, högst 20, titel ≤ 60, `href` en sökväg inne i Nav (inledande `/`, aldrig `//`/`/\`, inga blanksteg/kontrolltecken), unik per href. `PATCH /me/settings` ersätter hela listan; läsningen (`decodeFavorites`) släpper poster som inte längre klarar schemat.
- Webben: `FavoritesProvider` (AppShell och Översiktens egen ram; listan läses serverside med `loadFavorites`, null vid fel ⇒ allt dolt) köar ändringarna och läser om listan före varje stjärnklick. Gruppen **Favoriter** överst i `Nav.tsx` (ikon ur `hubIconFor`, dold — inte raderad — när `canOpen` säger nej, **Ändra** = `FavoritesEditor`), stjärnan på varje `HubSections`-rad (`favorites={false}` på `/hjalp`) och **Favorit** i ramens övre rad (`FavoriteToggle`, sparar sidan med filter men utan `page`, namnet förifyllt från sidans rubrik).

## Extern backup

- `scripts/offsite-backup.sh` (gpg AES-256 → rclone till `REMOTES` i `~/.config/nav-erp-backup/config`; `daglig/` `DAILY_DAYS`, `manad/` `MONTHLY_YEARS`, `arkiv/ÅÅÅÅ/` raderas aldrig och får SIE 4 via `scripts/lib/export-sie.sh`, som signerar en 5-minuterstoken med `.env`:s `JWT_SECRET`), `scripts/offsite-restore.sh` (lista/hämta/verifiera) och `scripts/offsite-backup-setup.sh` (installation från grunden, behåller befintlig lösenfras). Kompletterar — ersätter inte — den lokala `scripts/backup-db.sh`.

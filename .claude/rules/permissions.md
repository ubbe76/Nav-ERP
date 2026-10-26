---
paths:
  - "apps/api/src/modules/auth/**"
  - "apps/api/src/modules/oauth/**"
  - "apps/api/src/modules/system/middleware/**"
  - "apps/api/src/app.ts"
  - "apps/web/lib/pageAccess.ts"
  - "apps/web/lib/permissions.ts"
  - "apps/web/lib/apiClientScopes.ts"
  - "apps/web/components/PermissionsProvider.tsx"
  - "apps/web/components/ReadOnlyBanner.tsx"
  - "apps/web/components/ui/GatedLink.tsx"
  - "apps/web/components/oauth/**"
  - "apps/web/app/system/behorighetsgrupper/**"
  - "apps/web/app/system/anvandare/**"
  - "apps/web/app/system/integrationer/**"
  - "packages/shared/src/permissions.ts"
  - "packages/shared/src/auth.ts"
  - "packages/shared/src/oauth.ts"
  - "apps/api/test/permission*"
  - "apps/api/test/read-only*"
  - "apps/api/test/page-access*"
  - "apps/api/test/login*"
  - "apps/api/test/auth*"
  - "apps/api/test/oauth*"
  - "apps/api/test/credential*"
  - "apps/api/test/malformed*"
---

# Behörigheter, Endast läsning, inloggning och API-klienter

## Behörighetsgrupper (migration 0096)

- `permission_groups` med en rättighetslista ur den fasta katalogen i `packages/shared/src/permissions.ts` (spegel `apps/web/lib/permissions.ts`, synkad av `permissions.shared.test.ts`): menyerna `artiklar`/`inkop`/`forsaljning`/`tillverkning`/`lager`/`personal` (**Personal & lön**, migration 0137 gav den till varje grupp som hade `tillverkning`)/`kvalitet` (**Kvalitet**, migration 0153 gav den till varje grupp med `forsaljning`, `inkop` eller `tillverkning`; genvägarnas `deviationId` kräver den ovanpå dokumentets regel)/`ekonomi`/`rapporter` och verkstadsrättigheterna `terminal`/`artikeloversikt`/`tillverkningsorder_las`. Implikationerna (`tillverkning` ⇒ TO/terminal-rättigheterna, `artiklar` ⇒ `artikeloversikt`) räknas bara i `effectivePermissions`. `admin` har allt; System är admin-only.
- **API:t:** varje modul registreras med `registerModule(..., { read, write })` i `app.ts` (läs `office` = minst en meny, skriv = modulens meny); enskilda rutter åsidosätter med `config: { access }` (namngivna regler i `auth/middleware/access-rules.ts`; läsundantag innehåller alltid `office`, utom personaldatans `PERSONAL`), och `enforceAccess` nekar en rutt utan regel (fail closed). `permissions-coverage.test.ts` kräver en regel på varje rutt och att varje skrivrutt under `/articles` släpper igenom `artiklar`, oavsett modul — **en ny rutt utanför `registerModule` faller testet**.
- **Personal & lön:** personalregistret (`GET /employees[/:id]`, `POST`/`PATCH /employees`) och arbetsledarens närvarorättning (`PATCH`/`DELETE /attendance-sessions/:id`) har `PERSONAL` (även läsningarna — personaldata är inte kontorsdata); hela payroll-modulen är `{ read: ["personal"], write: ["personal"] }` utom `GET /attendance-deviation-reasons` (`TERMINAL_READ`). Rutternas `requireRole` (admin/arbetsledare; lås och lönekodsregistren admin) gäller ovanpå — rollen arbetsledare räcker inte ensam för Anställda/Attestering/Löneunderlag. Personalkortets Schema- och ATF-flikar skriver register under Tillverkning: undantagen och ATF-borttag har `PERSONNEL_CARD_WRITE` (`personal` eller `tillverkning`), Ta ut ATF `ATF_WITHDRAW` (terminal eller `personal`). Terminalen, Pågående arbete, tidrapporterna, scheman/helgdagar och TO-kortet läser `GET /employees/directory` (bara anställningsnummer, namn och förvalda stationer).
- **Priser är kontorsdata:** `canSeePrices` (`access-rules.ts`, = minst en meny) nollar `standardCost`/`salesPrice` i `GET /articles` och `setupPrice`/`unitPrice` i `GET /manufacturing-orders/:id/operations` för verkstadsprofilen — en ny rutt med prisfält som får ett verkstadsundantag måste göra detsamma.
- **Webben:** `lib/pageAccess.ts` är enda sidregeltabellen (proxyn skickar en nekad sida till `/ingen-behorighet`, `/` till `landingFor`); sidomenyn och hubbarna filtreras på samma tabell (`sectionsForUser`). En ny sida behöver en post där — `page-access.test.ts` faller annars. Sidorna under `/ekonomi` och `/rapporter` använder `canOpen`, inte rollkontroller. Klientkomponenter döljer knappar med `useCan`/`useCanOpen` (`PermissionsProvider` i `AppShell`); länkar till andra moduler går via `components/ui/GatedLink.tsx` — en länk får aldrig leda till en nekad sida.
- Rutter med sidoeffekter i flera moduler snävar in regeln själva: e-postloggens **Skicka om** kräver dokumenttypens modul (`resendAccessRule`, okänd typ ⇒ admin); Konteringsreglerna sparar via `PATCH /settings/posting` (`ekonomi`) medan `PATCH /settings` förblir admin. Kortens **Historik** (`AuditTrailSection`) bara för admin, som händelseloggens API.

## Endast läsning (migration 0128)

- `users.read_only` (CHECK `users_read_only_not_admin`; servicen kastar `ReadOnlyAdminError` → 400 `read-only-admin` på skapa och på resultatet av en ändring) sitter på sessionsanvändaren (`PublicUser.readOnly`, `/auth/me`).
- `readOnlyGuard` (`auth/middleware/auth.middleware.ts`) körs **inne i** `requireAuth` och `requireAuthOrClient` direkt efter att `req.user` satts, så varje autentiserad rutt — även auth-rutternas egna (`/me/settings`, `/auth/users`) — vägrar allt utom GET/HEAD/OPTIONS med 403 `read-only-account` (svenskt meddelande). Undantag bara för rutter som räknar och svarar utan att skriva: `config: { readOnlySafe: true }` eller en predikatfunktion per request (för- och efterkalkylen bara utan `save`) — plus det enda skrivande undantaget `PATCH /me/settings` (kontots egna inställningar, aldrig affärsdata). `read-only-account.test.ts` låser listan — en ny `readOnlySafe` är ett medvetet beslut.
- Webben: `ReadOnlyBanner` i `AppShell`, Översikten och terminalen; skrivknapparna döljs inte (API:t är gränsen).

## Inloggning

- `POST /auth/login` och `POST /oauth/token` räknar misslyckade försök i `createLoginThrottle` (`auth/service/login-throttle.ts`, i minnet, en instans per `buildApp`): 10 per konto/klient ⇒ 15 min spärr (429 `login-throttled` + `Retry-After`, även rätt lösenord avvisas); lyckad inloggning nollar bara kontonyckeln. Per IP (30) bara när `TRUST_PROXY` är satt — webbcontainerns rewrite skickar klientens egen `X-Forwarded-For` orörd.
- Den första registreringen kräver engångskoden ur `auth/service/setup-code.ts` (slumpad per process och utskriven av `server.ts` när inga användare finns, eller `SETUP_CODE`).

## API-klienter (OAuth, migration 0119)

- `api_clients.scopes` (`configurator:read`, `prices:read`, `quotes:create`, `orders:confirm`, `structure:read`; listan och förvalen Hemsida/Återförsäljare/Intern i `packages/shared/src/oauth.ts`, spegel `apps/web/lib/apiClientScopes.ts`) och valfri `customer_id`. `enforceAccess` kräver ruttens `config.clientScope` för klienter (fail closed, 403 `client-scope-missing`); en knuten klient får bara agera på sin kund (403 `client-customer-mismatch`, i rutterna) och bara kundens valuta (403 `client-price-not-allowed`); `confirm: true` kräver `orders:confirm`; rättigheterna läses vid varje anrop.
- En ny rutt i klientscopet behöver en `clientScope` — `permissions-coverage` kräver exakt de sju klientrutterna. Konfiguratorns publicering: `configurator.md`.

---
paths:
  - "apps/api/src/modules/system/**"
  - "apps/api/src/modules/demo/**"
  - "apps/web/app/system/exempeldata/**"
  - "apps/web/app/system/kom-igang/**"
  - "apps/web/components/onboarding/**"
  - "apps/web/components/Favorite*"
  - "apps/web/lib/favorites.ts"
  - "apps/web/app/page.tsx"
  - "apps/web/components/AppShell*"
  - "apps/web/components/AppToolbar*"
  - "apps/web/components/StatusBar*"
  - "apps/web/components/UserMenu*"
  - "apps/web/components/AlertsBell*"
  - "apps/web/components/ui/Nav*"
  - "apps/web/app/globals.css"
  - "apps/web/components/dashboard/**"
  - "apps/web/lib/overviewCard*"
  - "apps/api/test/overview*"
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
- Grunddata återanvänds: Avvikelseorsakerna (åtta, Kvalitet) vid samma kod eller namn, varugrupper, betalningsvillkor och enheter vid samma kod ELLER namn (båda är unika), produktionsgrupper vid samma kod, lagerplatser vid samma namn — och lagerplatserna läggs aldrig under reservlagret `***` (på en ny installation det enda lagret) utan under ett eget *Huvudlager*.
- Skrivningen (`demo-data.repository.ts`) går genom de befintliga Tx-hjälparna (`insertArticle`, `insertRoutingOperations`, `insertBomRows`, `replacePriceBreaks`, `resolveStockLocation`, `getNextOrderNumber`). De tillverkade artiklarnas standardpris är kalkylens TVK/st vid antal 1 — `demo-data-flows.test.ts` håller dem i synk, så **en kalkyländring kan kräva nya värden i datafilen**.

## Kom igång (onboarding)

- `system/service/onboarding.ts` är steglistan (nio steg i fyra grupper) och rena `buildOnboarding(facts)`; `onboarding.repository.ts` läser faktan med existensfrågor vid varje anrop — stegens status lagras aldrig, utom `system_settings.onboarding_number_series_reviewed` (**Markera som granskade**, loggas). `GET /onboarding` + `POST /onboarding/number-series-reviewed` är admin. Dölj är användarinställningen `hideOnboarding` (`hide_onboarding`).
- Webben: `components/onboarding/` — Översiktens kort (bara admin, fångar fel; Översikten monterar `ConfirmDialogHost` själv eftersom den saknar AppShell) och `/system/kom-igang`. **Ett nytt steg = en post i `STEPS` + ett faktum i `OnboardingFacts`/repositoryt + manualens lista.**

## Favoriter

- Användarinställningen `favorites` (`user_settings`, `favoriteSchema` i `packages/shared/src/user-settings.ts`, webbspegel `apps/web/lib/favorites.ts`): ordnad lista `{ href, title }`, högst 20, titel ≤ 60, `href` en sökväg inne i Nav (inledande `/`, aldrig `//`/`/\`, inga blanksteg/kontrolltecken), unik per href. `PATCH /me/settings` ersätter hela listan; läsningen (`decodeFavorites`) släpper poster som inte längre klarar schemat.
- **Var de visas** (`favoritesInSidebar`, `user_settings` `favorites_in_sidebar`, förval true): false döljer gruppen i sidomenyn; Översiktens kort `favorites` (ogrindat, hel bredd, `FavoritesCard`, egen **Ändra**) visar samma lista. Kryssrutan ligger i `FavoritesEditor` och sparas med **Spara** efter listan (`setInSidebar` i providern). Utan kortet och med bocken av syns favoriterna ingenstans — användarens eget val.
- Webben: `FavoritesProvider` (AppShell och Översiktens egen ram; listan och `inSidebar` läses serverside med `loadFavorites` — `{ favorites, inSidebar }`, favorites null vid fel ⇒ allt dolt) köar ändringarna och läser om listan före varje stjärnklick. Gruppen **Favoriter** överst i `Nav.tsx` (ikon ur `hubIconFor`, dold — inte raderad — när `canOpen` säger nej, **Ändra** = `FavoritesEditor`), stjärnan på varje `HubSections`-rad (`favorites={false}` på `/hjalp`) och **Favorit** i ramens övre rad (`FavoriteToggle`, sparar sidan med filter men utan `page`, namnet förifyllt från sidans rubrik).

## Översikten (#17 och fler kort)

Spec `private/superpowers/specs/2026-11-08-oversikten-per-anvandare-design.md`.

- **Korten per användare:** `overviewCards` i `user_settings` (`OVERVIEW_CARDS`/`DEFAULT_OVERVIEW_CARDS` i `packages/shared/src/user-settings.ts`, webbspegel `lib/overviewCards.ts`, `overview-cards-mirror.test.ts`). **null = `DEFAULT_OVERVIEW_CARDS`** (de fyra ursprungliga) — aldrig hela registret, så ett nytt kort syns bara för den som väljer det. Okända nycklar tappas vid läsning.
- **Grinden:** ett nyare kort har en `OVERVIEW_CARD_HREF` (kortets **Se alla**) och erbjuds i **Anpassa** och visas bara när `canOpen(user, href)` (`overviewCardAvailable`) — samma regel som `GatedLink`, så ett kort visar aldrig data som dess lista nekar. De fyra ursprungliga är ogrindade. Ett nytt kort = nyckel i båda registren, etikett, bredd, `href`, en hämtning i `app/page.tsx` som bara görs när kortet visas (`orNull`: ett fel ger "Kunde inte läsa … just nu." i kortet, aldrig en trasig sida) och rader ur rena `lib/overviewCardRows.ts` (typimporter bara — API-sviten laddar den; `ListCardRow` bor där, inte i komponenten, så API:ts typkontroll aldrig når JSX).
- **Hämtningarna:** aviseringskorten (Förfallna kundfakturor, Leverantörsfakturor att betala, Offerter att följa upp) läser `GET /alerts?kinds=` (`alertsQuerySchema`, smalnar av `visibleKinds`, vidgar aldrig) — bara när varken Materialflöde eller Att bevaka visas, annars delar de det fulla svaret (behovsberäkningen körs bara för de två). Leveranser/Inleveranser läser KO-/IO-listan med `deliveryTo` (Nästa leveransdatum ≤ söndagen i ISO-veckan, `endOfIsoWeek`; sena med, odaterade aldrig) och `sort=delivery` (tidigast först, odaterat sist, sedan ordernumret) — samma `nextDeliveryDateSql` som listans kolumn. Beläggning läser `GET /planning/capacity?weeks=1`; Öppna avvikelser två anrop (`overdue=true` först, sedan `status=open`, varje ärende en gång).
- Tester: `overview-cards-mirror.test.ts` (registret, standarden, grinden, layouten, radbyggarna), `overview-cards.route.test.ts` (`?kinds=`, `deliveryTo`/`sort` på båda listorna), `user-settings.route.test.ts`.

## Programramen (Nav som program, punkt 1)

TODO-posten "Nav som program (UI/UX)"; skisserna är privata.

- **Ramen:** sidomenyn (redan `sticky`) + innehållskolumnen `.column` i `AppShell.module.css` = `AppToolbar` (sticky top) → `main` (växer) → `StatusBar` (sticky bottom, dold ≤ 1024 px). Översikten (`app/page.tsx`) använder samma klasser. **Dokumentet scrollar som förut** — ingen inre scrollcontainer (iOS-fällor, alla sidors sticky-element); ramen står still för att den är sticky.
- **Höjderna** `--app-toolbar-height`/`--app-statusbar-height` står i `globals.css` (temaoberoende, inte i `tokens.css`). **Varje klistrigt element på sidan utgår från dem:** `top: var(--app-toolbar-height)` (eller `calc(… + var(--space-4))`), `bottom: var(--app-statusbar-height)` — annars glider det in under remsan. Klistriga huvuden i en egen `overflow: auto`-container (Beläggning, Budget) berörs inte. Mobilens hamburgare (fast) centreras i remsan, remsan håller vänsterkanten fri, och knappen döljs medan menyn är öppen.
- **Remsan:** `FavoriteToggle`, `AlertsBell` (`GET /alerts` efter renderingen och var femte minut när fliken syns; summan av gruppernas `count`, röd om någon rad är röd; dold utan `canOpen("/aviseringar")`; ett fel ger ingen siffra) och `UserMenu` (namn, roll, `ThemeToggle` — dold när temat är låst —, version, Logga ut). Allt ligger inne i `PermissionsProvider`. Sidomenyns sidfot (namn, roll, version) är borta.
- **Statusraden** frågar `GET /auth/me` en gång i minuten (och vid online/offline/synlighet): 200 Ansluten, 401 Sessionen har gått ut (länk Logga in), annat/nätfel Ingen kontakt med servern.
- **Understrykning:** menyposter (`Nav .item`), knapplänkar (`Button.module.css .button`) och kortlänkar (`DashboardCard .link`, understrykning vid hovring) är kontroller och understryks inte; länkar i löptext behåller understrykningen.
- Test: webbtesterna i API-sviten (`theme-tokens`, `page-access` m.fl.) + Playwright; ingen egen enhetstest — komponenterna har ingen logik utöver hämtningen.
- **Sök och kommandon, Ctrl+K (punkt 2):** `CommandPalette` i remsan, logiken i rena `lib/commandPalette.ts` (`command-palette.test.ts`). Sidorna = toppsidorna + modulhubbarna + varje `moduleNav`-post genom `sectionsForUser` (samma regler som menyn; en modul som användaren inte får öppna tas inte med, även om en enskild sida under den vore öppen — Referensränta). Registersökningarna (`PALETTE_SEARCHES`) är listornas egen `search` med `limit=3`, parallellt, från två tecken, debounce 200 ms, grindade på listsidan med `canOpen`; ett sent svar för en äldre text släpps (sekvens). Offerter öppnas på `/forsaljning/offerter/:id` (`documentKind`). **Senast öppnade** sparas i `localStorage` (`nav-erp-recent`, högst 8, sidans `.title` 800 ms efter navigering) — en bekvämlighet per webbläsare, aldrig affärsdata. Bara Ctrl/⌘+K tas från webbläsaren. **Fällor:** dialogen renderas i en portal (remsan är en stacking context, hamburgaren låg annars över), och fältet har `autoFocus` och töms när paletten *stängs* — tömning vid öppning och fokus via `setTimeout` tappade tecken för den som skriver direkt efter Ctrl+K.

## Extern backup

- `scripts/offsite-backup.sh` (gpg AES-256 → rclone till `REMOTES` i `~/.config/nav-erp-backup/config`; `daglig/` `DAILY_DAYS`, `manad/` `MONTHLY_YEARS`, `arkiv/ÅÅÅÅ/` raderas aldrig och får SIE 4 via `scripts/lib/export-sie.sh`, som signerar en 5-minuterstoken med `.env`:s `JWT_SECRET`), `scripts/offsite-restore.sh` (lista/hämta/verifiera) och `scripts/offsite-backup-setup.sh` (installation från grunden, behåller befintlig lösenfras). Kompletterar — ersätter inte — den lokala `scripts/backup-db.sh`.

## Lagringsutrymme

- Alla uppladdade/arkiverade filer ligger i bytea-kolumner. `GET /storage` (admin, sektionen överst på `/system/sakerhetskopiering`) summerar dem per slag via `STORED_FILE_KINDS` i lövet `system/repository/storage.ts` (`octet_length` läser längden ur TOAST-pekaren, filinnehållet hämtas aldrig) plus `pg_database_size`. **En ny bytea-kolumn ska in i listan** — `system-storage.test.ts` jämför den mot `information_schema` och faller annars. Webben påminner när filerna passerar 50 GB (`FILES_GUIDELINE_BYTES` i `StorageSection.tsx`, manualens Lagringsutrymme).
- **Exportera filer** (`GET /storage/export`, admin): `FILE_EXPORT_KINDS` i `system/repository/file-export.ts` (samma nycklar som `STORED_FILE_KINDS`, testat) listar metadata per slag med mappar (artikelnummer, AV-/LF-nummer, verifikatets serie-år-nummer …) och läser bytes tio rader åt gången; `ZipStreamWriter` i rena `service/zip-stream.ts` skriver STORED-poster direkt i strömmen (CRC och storlek i lokala huvudet, UTF-8-namn, ZIP64-poster bara när > 65 535 poster eller offset ≥ 4 GiB, Stockholmstid), `safeSegment`/`UniquePaths` ger säkra och unika sökvägar. Ingen transaktion hålls över nedladdningen — en fil som raderas under tiden hoppas över.


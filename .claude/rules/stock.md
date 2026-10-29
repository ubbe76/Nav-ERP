---
paths:
  - "apps/api/src/modules/stock/**"
  - "apps/web/app/lager/**"
  - "apps/web/components/stock/**"
  - "packages/shared/src/stock.ts"
  - "apps/api/test/stock*"
  - "apps/api/test/moving*"
---

# Lager och lagerplatser

Grundregeln (arkitekturprincip 1): aldrig UPDATE på saldon — allt går via `stock_transactions`, saldot är en aggregering.

- **Lagerplats är obligatorisk** (`location_id` NOT NULL) men löses upp automatiskt av `resolveStockLocation` (`stock/service/location-resolver.ts`, funkar i tx) som **alla** `stock_transactions`-skrivare anropar: angiven plats → artikelns `default_location_id` om platsen är aktiv → reservplatsen `***` (lager + plats, skapas vid behov). Nya artiklar får `***` om ingen väljs; formulärens standardval heter "Artikelns lagerplats".
- **Lagerflytt** (`POST /stock/transfers`, `transferStock` i `stock.repository.ts`): två `stock_transfer`-rader per artikel (− avsändaren, + mottagaren) med gemensamt genererat `reference_id`, hela flytten i en transaktion, överuttag ⇒ 409. En inaktiv **mottagande** plats avvisas (400) — destinationen är ett medvetet val, ett tydligt fel är bättre än att tyst väcka en avställd plats.
- **Tomma platser städas bort:** `deactivateEmptyLocation` (`stock/service/location-lifecycle.ts`, `Db | Tx`) sätter `active = false` när varje artikel på platsen nettar till noll. Hård radering är omöjlig (`ON DELETE restrict`, loggen ska visa var saldot låg); `***` undantas alltid. Den anropas av **alla lagerminskningar** — `createTransaction` (negativ delta), sales `deliverGoods`, manufacturing `consumeLinkedMaterial`/`consumeMaterial`, flyttens avsändarled — och en ny minskning måste också göra det. Artiklar som pekar på en rensad plats får `default_location_id = null` (→ `***`), utom de som flyttades — de följer med till mottagaren.
- **Invariant: en plats med saldo är alltid aktiv** (annars vore saldot osynligt i alla listor), åt båda hållen: `resolveStockLocation` **återaktiverar** en inaktiv plats som anges explicit (så orderrutiner inte failar mitt i när en tidigare rad tömde platsen), och `updateLocation` vägrar inaktivera en plats med saldo (`StockLocationNotEmptyError` → 409, delad `locationHoldsStock`).
- `GET /stock/locations` ger bara aktiva platser; bara lagerplatsregistret skickar `?includeInactive=true`. Saldolistorna (`getBalances`/`balancesForArticles`) filtrerar bort saldo 0.
- **Kostnad på lagerraden** (D0): `stock_transactions.unit_cost` (nullable, SEK) stämplas bara på **inflöden** — inleverans (IO-radens à-pris × orderns växelkurs), TO-inleverans (artikelns standardpris; konfigurerad TO: `configuration.cost.manufacturingCostPerUnit`) och positiv justering (standardpriset vid tillfället). Utflöden, flyttens båda ben (ingen värderingshändelse) och ångrade in-/utleveranser är null; saknad standardkostnad ger null, aldrig 0. Loggen är facit för värdet, så glidande medelpris härleds per datum utan lagrat snittsaldo.
- **Importen av lagersaldon** (`import.md`, #3) är en `stock_transactions`-skrivare som följer samma regler: `resolveStockLocation`, `assertLocationNotUnderCount`, `deactivateEmptyLocation` vid minskning och `unit_cost` bara på ökningen (À-pris, annars standardkostnaden).
- Läsare av `purchase_receipt`-rader som avser *inkommet* gods (inleveransloggen, senaste inköpspris i lagervärderingen, senaste inleveransdatum) filtrerar `quantity_delta > 0` och bort ångrade kvitton (se `purchase.md`).

---
paths:
  - "apps/api/src/modules/register/**"
  - "apps/web/app/register/**"
  - "apps/web/app/grunddata/**"
  - "apps/web/components/documents/TermsFields.tsx"
  - "packages/shared/src/register.ts"
  - "apps/api/test/register*"
---

# Grunddata-registren

- Leveransvillkor (förifyllbara med Combiterms via `POST /delivery-terms/generate-combiterms`), betalningsvillkor och speditörer ligger i `register`-modulen och delas av kunder och leverantörer (FK `restrict`). Förlustorsakerna för offerter (`quote_loss_reasons`: kod + namn + aktiv, skriv `forsaljning`, radera admin med flytt, seedat med fem orsaker) ligger också här.
- **Villkoren på dokumenten:** samma tre villkor ligger på förfrågan/inköpsorder/kundorder — snapshotas från partnern i repositoryts create-transaktion (konvertering förfrågan→IO tar förfrågans villkor), redigeras via header-PATCH (`PATCH /inquiries|purchase-orders|sales-orders/:id`, samma statusregler som radredigeringen, valideras med `validateRegisterRefs`), joinas som kod/namn i detalj-GET:arna och skrivs ut på PDF:erna. Webben delar `TermsFields` (`components/documents/TermsFields.tsx`, med `termsFrom`/`termsPayload`/`termsLabel`) på de tre korten.
- **Avvikelseorsaker** (`deviation_reasons`, Kvalitet, 0153): kod + namn + flaggorna Kund/Leverantör/Intern/Kassation (CHECK minst en) + aktiv, skriv `kvalitet`, listan `TERMINAL_READ` (terminalens kassationsorsak), referenserna `deviations.reason_id` och `mo_operation_scrap.reason_id` (`quality.md`).
- **Radering med kopplingsflytt:** `GET /<register>/:id/usage`, `DELETE /<register>/:id` med valfri `replacementId`. Referenskartan (tabell/kolumn/etikett/FK-constraint per register) är data i `register.repository.ts` och **måste utökas när en ny FK mot en registertabell tillkommer**. De unika kopplingstabellerna (`company_carriers`, `article_units`) har merge-semantik — källraden droppas i stället för att flyttas om mottagarposten redan har en egen rad. `RegisterEntryInUseError` → 409 (radering utan `replacementId` när posten används), `InvalidReplacementError` → 400 (`reason` same/unknown, och registrets egna regler via `forTable(..., beforeReassign)` som körs i raderingstransaktionen före flytten — Avvikelseorsaker: inactive/not-applicable med svensk text, `quality.md`).

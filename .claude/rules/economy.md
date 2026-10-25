---
paths:
  - "apps/api/src/modules/economy/**"
  - "apps/web/app/ekonomi/**"
  - "apps/web/components/economy/**"
  - "apps/web/components/documents/**"
  - "apps/web/lib/verificationRows.ts"
  - "apps/web/lib/splitVat.ts"
  - "apps/web/lib/allocation.ts"
  - "packages/shared/src/economy.ts"
  - "apps/api/test/economy*"
  - "apps/api/test/verification*"
  - "apps/api/test/recurring*"
  - "apps/api/test/sie*"
  - "apps/api/test/financial*"
  - "apps/api/test/bookkeeping*"
  - "apps/api/test/posting*"
  - "apps/api/test/dimensions*"
  - "apps/api/src/modules/reports/**/project-report*"
---

# Ekonomi: bokföring, automatkontering, rapporter, SIE, räkenskapsinformation

Moms: `vat.md`. Valuta: `currency.md`. Reskontra: `ledgers.md`. Anläggningar och bokslut: `year-end.md`. Bank: `banking.md`.

## Grundbokföring och automatkontering (B1/B2)

- `economy`-modulen äger kontoplan, räkenskapsår/perioder (med låsning), manuella verifikat (append-only, egen verifikatserie/årsräknare — inte `number_series`) och den härledda huvudboken.
- `system_settings` bär standardkontona som inte hör till en momskod (`posting_*`: kundfordringar, leverantörsskulder, standardkostnad, bank, påminnelseavgift, öresutjämning, momsredovisning, lager/lagerförändring, kursvinst/-förlust, bankavgift) — alltid populerade på GET, PATCH tar `""` för att återställa till BAS-standard. Intäkts- och momskontona ligger sedan 0142 på momskoderna. Konteringsreglerna sparas via `PATCH /settings/posting` (`ekonomi`, strikt schema), aldrig `PATCH /settings` (admin).
- `posting_rules` (artikelgrupp + momskod, `vat_code_id = null` = "Alla momskoder", unikt per kombination) styr enskilda rader; register-UI `/ekonomi/konteringsregler`.
- **`VerificationPoster`** (`economy/service/verification-poster.ts`, Tx-komponerbar som `resolveStockLocation`/`allocateVerificationNumber`) bokför kundfaktura/leverantörsfaktura direkt som **bokförda** verifikat i serierna **F** respektive **L** (self-healing-skapade med samma ON CONFLICT-mönster som numreraren). Kontot löses: regel (grupp + exakt momskod) → regel (grupp, "Alla momskoder" — bara inhemska koder och IUTV) → momskodens konto (kostnad: standardkostnaden för inhemska koder).
- Postern anropas **inifrån** sales `issueInvoice`/purchase-attestens statusövergångstransaktion, så dokumentet och verifikatet blir en atomär sidoeffekt (arkitekturprincip 2); en makulerad leverantörsfaktura bokför på samma sätt en omföring. Fakturakorten visar **Verifikat F-…**/**L-…**.

## Manuell bokföring (migration 0147)

Spec `private/superpowers/specs/2026-10-24-manuell-bokforing-design.md`.

- Verifikatets rader sparas som **hel mängd** (`PUT /verifications/:id/rows`, replace-the-set under verifikatets `FOR UPDATE`, bara utkast). `POST /verifications` tar rader och `book: true`; **`economyService.createVerificationInTx(tx, input, createdBy, { book })` är den enda implementationen** och delas av Spara och bokför, de återkommande körningarna, SIE-importen och bankens Bokför. `POST /verifications/:id/copy` utelämnar inaktiva konton med varning.
- Webben: delade `VerificationRowsEditor` (kontosök, Tab/Enter/Ctrl+Enter/Esc, motrad med differensen, kolumnen Momskod som delar raden via rena `apps/web/lib/splitVat.ts` — momskoden lagras aldrig, servern ser bara vanliga rader) på verifikatkortet, `/ekonomi/verifikat/nytt` och mallsidan. Sidor: `/ekonomi/verifikatmallar`, `/ekonomi/aterkommande-verifikat`, SIE-sidans flik **Importera verifikat**.
- **Mallar** (`verification_templates` + rader med kontonummer, inte FK; tomma belopp tillåtna; **Spara som mall** `POST /verifications/:id/template`).
- **Återkommande verifikat** (`recurring_verifications`: dag 1–28 eller NULL = sista, `start_month`/`end_month` "YYYY-MM", `draft` förval | `book`; `recurring_verification_runs` unik `(recurring_id, month)`):
  - Reservationsraden skrivs i verifikatets egen transaktion, så en samtidig körning blockeras på indexet och rullar tillbaka sitt verifikat och nummer.
  - Jobbet `recurring_verifications` i `server.ts` (en gång i timmen) skapar förfallna månader (Stockholmsdagar, rena `recurring-schedule.ts`). Ett fel blir `failed` med svensk orsak (okänt ⇒ `UNEXPECTED_RUN_ERROR`, det riktiga felet bara i serverloggen) och försöks **inte** om automatiskt — bara **Kör nu** (`POST …/:id/run`, även pausad post). Skapa kör ikapp direkt.
  - **Aktivera** (`active false → true`) skriver `skipped`-rader för månaderna som förföll under pausen i samma transaktion (vyn bär `skippedOnActivate`, PATCH-svaret `skippedMonths`). Borttag raderar posten och `failed`-/`skipped`-rader; körningar med verifikat blir kvar med `recurring_id = null`.
  - **Fördela över perioder** (`POST /recurring-verifications/allocation`) = egen mall + post i läge `book`, dag "sista", `schedule_amounts` (avrundat **nedåt** per månad, sista tar resten; webbens `lib/allocation.ts` speglar `allocationAmounts`, testat). Aviseringen `recurring_verification_failed`.

## Ekonomirapporter (B6a)

- Rent härledda — inget lagrat saldo. Intervalltabellen i `economy/service/bas-report-lines.ts` täcker **0000–9999 exakt en gång** så `classifyAccount` är total (testat över alla 10 000 nummer) — annars försvinner en bokning på ett oklassat konto tyst i stället för att hamna under "Ej klassificerade konton".
- `account-balances.ts`s `readAccountBalances` är den enda aggregeringen (balans-, resultaträkning, SIE) — medvetet **utan** `vat_settlements`-undantagen som `vat-account-movements.ts` har; momsomföringarna är riktiga rader och utan dem balanserar inte balansräkningen. Balansräkningen lägger klass 3–8:s netto som en **beräknad** eget kapital-rad; resultaträkningen är strikt periodbunden. Huvudbokens IB för resultatkonton räknas från början av räkenskapsåret `from` ligger i (balanskonton kumulativt).
- PDF:erna via mail-modulens A4-mall (`renderFinancialStatement`/`renderGeneralLedger`/`renderVerificationList`) med `formatNumber` — exporterad just för WinAnsi-fällan där `sv-SE`:s minustecken (U+2212) saknar glyf i Helvetica.

## SIE (B6b)

- Rena lövfiler: `sie-encoding.ts` (handrullad **CP437** — specen tillåter bara `#FORMAT PC8`, Node saknar encodern), `sie-format.ts` (`sieText` citerar ALLTID textfält, `sieField` bara vid behov; belopp med punkt/max 2 dec/minus för kredit; datum `YYYYMMDD`), `sie-export.ts` (`buildSieFile`, ren, CP437-bytes; `#KTYP` härleds ur `classifyAccount` så SIE och balansräkningen aldrig tycker olika), `sie-parse.ts` (IB-importen läser bara `#RAR`/`#KONTO`/`#IB`; accepterar CP437 och UTF-8 eftersom verkliga exportörer skickar båda).
- `sie.service.ts`: export `#SIETYP 4` per räkenskapsår med `#RAR -1` när det finns. **Import av IB** bokför ETT verifikat i serie **I** via `postOpeningBalances`, i en transaktion som också skapar saknade konton. Vakterna (egna felklasser): räkenskapsåret måste matcha, balanserna summera till noll (ingen påhittad motpost), en import per år, och `SiePriorBookkeepingError` när det finns bokförda verifikat före årets start (då härleds IB redan ur bokföringen).
- **Import av verifikat:** `parseSieDocument` läser `#VER`/`#TRANS` (hoppar `#RTRANS`/`#BTRANS`, sparar objektlistan). `POST /sie/verifications/preview` + `/import` (multipart): allt i EN transaktion; blockers (obalans, låst period/stängt år, saknat konto utan Skapa saknade konton, saknat konto som inte är fyra siffror, utanför räkenskapsår, underlag > 500 MB — varning över 50 MB, `underlagSizeProblem`) ⇒ inget importeras. Filen blir underlag på varje verifikat, serien **LÖ** "Lönejournal" self-healing, dubblettspärren `sie_verification_imports` (sha256 unik, 409 `sie-file-already-imported`).

## Kostnadsställen och projekt (migration 0149)

Spec `private/superpowers/specs/2026-10-24-kostnadsstallen-budget-ranta-design.md` (Del A), kontrakt `…/2026-10-25-etapp5a-kontrakt.md`.

- Två fasta dimensioner — `cost_centers` (SIE 1) och `projects` (SIE 6) — registren i `economy/{repository,service,routes}/dimension.*` (`registerModule` läs `office`, skriv `ekonomi`; kod unik ⇒ 409 `cost-center-code-taken`/`project-code-taken`). Alla FK-kolumner är nullable `ON DELETE restrict`; **radering med kopplingsflytt** följer register-mönstret med egen referenskarta i `dimension.repository.ts` (**utöka den vid varje ny FK mot `cost_centers`/`projects`**). Ett objekt på **bokförda** verifikatrader kan aldrig raderas (0095-spärren gör raderna oföränderliga) ⇒ 409 `dimension-booked`, bara inaktivera/stänga; utkastrader flyttas som allt annat.
- **En regel för alla skrivare:** `resolveDimensions` i lövet `dimension-check.ts` (`Db | Tx`; sales/purchase/article/banking/fixed-asset anropar den via sina repositories). Källan avgör strängheten: användarens val (`input`) vägras om objektet saknas (404) eller är inaktivt/stängt (400 `cost-center-inactive`/`project-closed`); ett **behållet** värde (samma id som raden redan bär, eller utelämnat vid PATCH) kontrolleras aldrig; ett **förval** (`fallback`: orderhuvud, artikelgrupp, leverantör, IO:ns projekt, bankregel) som inte längre går igenom släpps **tyst**. `omittedKeepsExisting: false` för hela-raden-skrivningar (verifikatradens PATCH är en full rad: utelämnat = inget).
- **Förvalskedjor:** kundfakturarad = kopplad orderrads huvud (`sales_orders.cost_center_id/project_id`) → artikelgruppens `default_cost_center_id`; kreditfaktura kopierar källradens objekt orörda. Leverantörsfakturans huvud = `suppliers.default_cost_center_id` + IO:ns `project_id` (vid skapande; header-PATCH tar IO:ns projekt bara när fakturan saknar projekt och PATCH:en inte sätter något — "manuellt vinner"); raden = artikelgruppens förval, `null` = följer huvudet. Postern lägger objekten på **intäkts-/kostnadsraden** (restraden tar huvudets), aldrig på fordran/skuld/moms; ackumulatorn nycklar på `(konto, kostnadsställe, projekt)` så två rader på samma konto med olika objekt blir två verifikatrader. Avskrivningsraden tar `fixed_asset_categories.default_cost_center_id`; omföringar speglar objekten.
- **Kräver kostnadsställe** (`accounts.cost_center_required`): femte in-tx-kontrollen i `bookVerificationInTx` ⇒ 409 `cost-center-required` med `accounts` — gäller allt som bokför via `createVerificationInTx` (manuellt, bankens Bokför, SIE-import i läge Bokför, återkommande i läge `book`), **aldrig postern** (dokument fälls inte). Varningen `warnings` på verifikatkortet och aviseringen `cost_center_missing` är **härledda vid läsning** (`costCenterWarnings`, `verificationsMissingCostCenter`) — inget lagras, flaggan av ⇒ allt försvinner.
- **Rapporterna:** `readAccountBalances(db, range, filter)` och `readAccountBalancesGrouped` (en dimension) är enda aggregeringen; `buildGroupedIncomeStatement` (ren) ger `columns` + `amounts[]` där summan över kolumnerna = det ogrupperade beloppet och **Utan** bara finns när en resultatkontorad saknar objekt. Huvudbokens filter gäller IB, rader och före-året-korrigeringen lika; verifikationslistan filtrerar på verifikat med minst en rad på objektet men visar alla rader. PDF:erna skriver objekten i textkolumnen (`[100 Verkstad · P1 Storkök]`), per objekt en sektion per kolumn; CSV:erna har alltid kolumnerna Kostnadsställe/Projekt.
- **SIE:** `#DIM 1/6` + `#OBJEKT` skrivs bara när registren har poster (alla, även inaktiva, så varje kod i `#TRANS` är deklarerad); `{1 "kod" 6 "kod"}` via `sieObjectList`. Importen mappar dimension 1/6 på kod och ignorerar övriga; `missingObjects` i förhandsgranskningen, **Skapa saknade konton och objekt** skapar dem (`ON CONFLICT` på koden); inaktivt kostnadsställe/stängt projekt är en blocker.
- Tester: `dimensions-register.test.ts`, `dimensions-posting.test.ts`, `dimensions-reports.test.ts`, `dimensions-bank-rules.test.ts`, `sie-dimensions.test.ts`, `dimensions.route.test.ts`.

## Räkenskapsinformation (bokföringslagen 5 kap 6 §, 7 kap)

- Underlag och utfärdade dokument lagras som bytea i Postgres (följer med varje backup) med SHA-256 vid lagring, `ON DELETE restrict` och listningar som **aldrig selectar `data`**.
- **`supplier_invoice_files`** (0092, `/supplier-invoices/:id/files`) och **`verification_files`** (0094, `/verifications/:id/files`) kan läggas till i alla statusar men **bara tas bort i draft** — statuskontroll + DELETE i samma tx under dokumentets `FOR UPDATE` (attest/bokföring tar samma lås), annars 409 (`…FileLockedError`). Upload/borttag loggas (`file_added`/`file_deleted`). Webben: `components/documents/UnderlagSection.tsx` (+ `uploadUnderlag`).
- **`invoice_documents`** (0093) är **insert-only**: kundfakturans/kreditfakturans PDF arkiveras direkt efter `issue` (utanför issue-tx; misslyckas det arkiverar första `renderPdf`/`sendEmail` med `ON CONFLICT DO NOTHING` + läs tillbaka = first writer wins) och **varje utskrift/e-post serverar de arkiverade bytes** — omrendering skulle följa live-företagsdata. Påminnelsens PDF arkiveras i samma tx som påminnelseraden (`ReminderWrite.document`, `GET /invoices/:id/reminders/:reminderId/pdf`). Ett raderat verifikatutkast tar sina filer med sig.
- **Databasspärren (migration 0095)** gäller alla skrivare: triggers vägrar UPDATE/DELETE på bokförda `verifications`, alla radändringar på bokförda verifikats `verification_rows`, borttag av underlag på bokfört verifikat/attesterad leverantörsfaktura och all UPDATE/DELETE på `invoice_documents` — SQLSTATE `NV001`, som `isBookkeepingLockViolation` gör till 409 `bookkeeping-record-locked`. Enda undantaget: ett verifikat som bokförs i **samma transaktion** får sina rader (triggern stämplar `booked_at := now()` = transaktionsstart; raderna är låsta när `booked_at` ≠ `now()`, så undantaget går inte att förfalska senare). Tillåtet på låsta rader: bara FK-nollningen `created_by`/`booked_by`/`uploaded_by`. `TRUNCATE` påverkas inte; ett test som simulerar äldre data stänger av triggern explicit. **Ändra aldrig dessa tabeller till att tillåta UPDATE/DELETE av låsta rader.**

---
paths:
  - "apps/api/src/modules/timereport/**"
  - "apps/api/src/modules/payroll/**"
  - "apps/web/app/tillverkning/terminal/**"
  - "apps/web/app/tillverkning/tidrapporter/**"
  - "apps/web/app/tillverkning/pagaende/**"
  - "apps/web/app/tillverkning/scheman/**"
  - "apps/web/app/personal/**"
  - "apps/web/components/timereport/**"
  - "apps/web/components/payroll/**"
  - "apps/web/lib/stampSessions.ts"
  - "packages/shared/src/timereport.ts"
  - "packages/shared/src/payroll.ts"
  - "apps/api/test/attendance*"
  - "apps/api/test/stamp*"
  - "apps/api/test/timereport*"
  - "apps/api/test/payroll*"
  - "apps/api/test/atf*"
  - "apps/api/test/employee*"
  - "apps/api/test/schedule*"
---

# Närvaro, stämpling och lön

Behörigheterna för Personal & lön: `permissions.md`. TO-rapporteringen som stämplingen skriver: `manufacturing.md`.

## Närvaro och arbete

- **Gå hem** pausar öppna arbeten och närvaroinstämplingen återupptar dem (även efter dagar); **en instämpling på arbete utan närvaro stämplar in närvaron** (`stampIn` → `beginAttendance`). Frånvarandes arbeten stängs aldrig automatiskt.
- Lövfilen `timereport/repository/stamp-close.ts` (`Db | Tx`, bara schemaimporter) äger tidsuträkningen **`stampedHours`** (enda implementationen — terminalen, arbetsledarens **Sluttid**, den automatiska utstämplingen) och `closeStampSessionsInTx`: när en operation blir klar (`reportOperationQuantitiesInTx`) eller ordern blir klar (sista operationens inleverans, **Slutför order**) stämplas andras öppna/pausade stämplingar ut i **samma transaktion**, 0/0, vid pausens start eller nu, med tidrapport daterad på sluttidens dag (idag om dagen är löneperiodlåst) och en `mo_reports`-rad `source = 'auto_close'` (migration 0120) som ångras som en vanlig utstämpling.
- `closeStampSession` är villkorad, så en egen utstämpling som förlorar kapplöpningen tar bort sin tidrapport (`deleteTimeReport`) och svarar 409. `stoppedAt` på `POST /stamp-sessions/:id/stop` är admin/arbetsledare (403 annars).
- Attesteringens närvarorättning följer med till arbetena (`correctAttendanceWithWork`: stängd öppen närvaro pausar, flyttad sluttid flyttar pausen med 2 s tolerans). En öppen närvaro från en tidigare dag ger 409 `attendance-open-from-earlier-day` tills terminalen skickar `forgottenStoppedAt` (`closeForgottenAndBegin`, en transaktion som bara stänger en närvaro som fortfarande är öppen — en gammal andra inskickning ger 409 `already-present`).
- `absentToday` i `GET /stamp-sessions` bara för admin/arbetsledare (frånvaro = hälsodata).
- **Dagarna är Stockholmsdagar** (`localDateOf`); `docker-compose.yml` sätter `TZ: Europe/Stockholm` eftersom lönemotorn (`clockToMs`/`dayBounds`) gör om schemaklockslag med serverns lokala tid.

## Radera eller anonymisera en anställd (GDPR, #2, migration 0170)

Spec `private/superpowers/specs/2026-10-29-radera-anonymisera-anstalld-design.md`.

- **Regeln** är rena `timereport/service/employee-erasure-plan.ts` (`erasurePlan`): ingen historik ⇒ `delete`, historik ⇒ `anonymize`, `anonymized_at` satt ⇒ `anonymized`; spärrar `active`, `open-session`, `open-period` (månader med historik vars löneperiod inte är låst). **Historik** = rad i `time_reports`, `stamp_sessions`, `attendance_sessions`, `absences`, `atf_transactions`, `overtime_dispositions`, `payroll_attestations`, eller med i en låst periods `summary` — SQL:en bor i lövet `timereport/repository/employee-erasure.ts` (sessionernas månader är Stockholmsdagar för både start och stopp).
- **Skrivningen** (`repo.eraseEmployee`) låser den anställdes rad `FOR UPDATE`, läser fakta igen och låter servicens `decide` välja eller kasta — förhandsvisningen (`GET /employees/:id/erasure`) är bara information. Anonymiseringen: personfälten null, namnet `ANONYMIZED_NAME`, `active = false`, `anonymized_at`; fritexten (närvarons `start_note`/`stop_note`, tidrapporternas, frånvarons och ATF:s `note`) null även i låsta perioder; namnet ersätts i låsta periodernas `summary`; nycklarna `note`/`startNote`/`stopNote` tas bort på alla nivåer i `audit_log.detail` för poster med `detail.employeeId` (`withoutFreeText`). **Anställningsnumret behålls** (användarbeslut — avstämning mot lönesystemet). Händelseloggen: `employee` / `deleted`|`anonymized` med `employeeNumber`, aldrig namnet.
- **Frysning i databasen:** triggern `nav_employee_anonymized_guard` vägrar UPDATE/DELETE av en anonymiserad anställd och INSERT i tid-, närvaro-, stämplings-, frånvaro-, ATF-, övertids-, schemaöverstyrnings- och stationstabellerna för en (SQLSTATE **NV002** → 409 `employee-anonymized` i den globala felhanteraren, `isEmployeeAnonymizedViolation`). Anonymiseringen uppdaterar `employees` **först** och sedan bara UPDATE:ar på historiken, som triggrarna släpper. `updateEmployee` kollar själv först (snyggare fel). En ny tabell med `employee_id` som tar nya rader ska få samma trigger.
- **Bara admin** (`PERSONAL` + `requireRole("admin")`) på `GET …/erasure`, `DELETE /employees/:id`, `POST …/anonymize`. Webben: `EmployeeErasureSection` på Allmänt (bara admin), anonymiserad ⇒ `EmployeeTabs` visar bara en banner. Tester: `employee-erasure.route.test.ts`.

## Avvikelser vid närvarostämpling (migration 0136)

Spec `private/superpowers/specs/2026-10-22-narvaroavvikelser-design.md`.

- **Inställningarna** `attendance_reason_required` (**Kräv anledning vid sen ankomst och tidig hemgång**), `attendance_reason_tolerance_minutes` (**Marginal (minuter)**, förval 5) och `terminal_overtime_choice` (**Fråga om övertidsersättning i terminalen**), av som förval, i panelen Lön & PAXml och i `GET /settings/terminal`. Av ⇒ dagens beteende. `createTimeReportService`s sista parameter `deviations` är valfri (utelämnad ⇒ inga kontroller, fixturerna oförändrade).
- **Registret Avvikelseorsaker** (`attendance_deviation_reasons`; schemat i `timereport.ts` för att undvika importcykeln, rutterna i payroll-modulen: läs `TERMINAL_READ`, skriv admin, ingen radering — bara inaktivering) är en flik på Lönekoder. Anledning + kommentar sparas på sessionen (`attendance_sessions.start_reason_id`/`start_note`/`stop_reason_id`/`stop_note`). Anledningen påverkar aldrig lönen och registrerar ingen frånvaro.
- **Minuterna lagras aldrig** utan härleds ur schemat (`lateMinutesOf`/`earlyLeaveMinutesOf` i `payroll-day.ts`, enda aritmetiken; `computeEmployeeDay` ger `lateMinutes`/`earlyLeaveMinutes`) och mäts **bara på närvarosegment som överlappar schemafönstret** (`overlapsScheduleWindow`, positiv överlappning, halvöppna intervall): första sådana segmentets start, sista sådanas slut. Ett nattpass 00:00–02:00 före 07:00 döljer alltså varken förseningen eller blir 14 h tidig hemgång, och inget segment i fönstret = ingen avvikelse. Avvikelser-kolumnen (`measuredSessionsOf`) och dagvyns per-session-minuter (`lateMinutes`/`earlyLeaveMinutes` på sessionerna i `getEmployeePeriodDays`) pekar ut samma sessioner.
- **Policyn** är rena `timereport/service/attendance-deviation.ts` med samma regel:
  - En instämpling (även via `stampIn`) är sen bara när den börjar före fönstrets slut och ingen tidigare närvaro redan överlappar fönstret (`repo.hasAttendanceInWindow`; den glömda närvaron som `closeForgottenAndBegin` stänger bedöms med sin nya sluttid).
  - Gå hem är tidig bara när passet överlappar fönstret och startade **samma Stockholmsdag** (en närvaro öppen sedan en tidigare dag frågas varken om anledning eller övertid).
  - Bara schemalagda dagar och bara när avvikelsen är **större än** marginalen; den glömda utstämplingens tid frågas aldrig. Ett **ATF-uttag samma Stockholmsdag** (`repo.hasAtfWithdrawalOnDay`, samma regel som `atfMinutes`) undantar tidig hemgång; `atfTransactionId` valideras fortfarande (annat uttag ⇒ 400 `atf-transaction-mismatch`).
  - Kontrollen fäller aldrig en stämpling: ett fel i schema-/inställnings-/förhandsvisningsläsningen loggas (`deps.log`, `app.log` i `app.ts`) och frågan hoppas över.
- **Övertidsfrågan vid Gå hem** räknar dagen med lönens egen motor (`payrollService.previewDay` med den öppna sessionen stängd vid samma `at`), aldrig en klockjämförelse, och skrivs i `overtime_dispositions` i **samma transaktion** som den villkorade stängningen och pausningen (`repo.stopAttendance`, `upsertOvertimeDispositionInTx`). Låst löneperiod ⇒ ingen fråga och inget skrivet.
- Saknad input ⇒ 409 `attendance-input-required` med `reason`/`overtime` (båda kan krävas); okänd/inaktiv orsak ⇒ 400 `attendance-reason-invalid`. **Terminalen räknar aldrig själv** utan visar 409-kroppen och skickar om: behåller redan givna svar och skickar alltid med dem, hämtar orsakerna vid varje fråga (och efter 400), skickar `forgottenStoppedAt` tillsammans med anledningen när den glömda utstämplingen leder till en sen-ankomstfråga, går tillbaka till operationslistan med bara de misslyckade markerade när en omsänd Stämpla in misslyckas, och efter Ta ut ATF stämplar **Avbryt**/tidsgränsen ut närvaron med dagens förvalda övertidsval.
- **Attesteringen** visar **Avvikelser** (`deviationDays`/`missingReasonDays`) och anledningarna per session; arbetsledarens PATCH rättar dem, skriver bara ändrade kolumner och är villkorad på den lästa sluttiden (`correctAttendanceWithWork(id, patch, expectedStoppedAt, effect)`, millisekundjämförelse), så en Gå hem emellan ger 409 `attendance-session-changed` i stället för att öppna närvaron igen.

## Utjämning: ATF och inarbetning i veckoschemat (migration 0166)

Spec `private/superpowers/specs/2026-10-28-atf-i-veckoschemat-design.md`.

- **Inställningen** `schedule_balancing` (**Tillåt ATF-uttag via schemat**, av som förval, i `GET`/`PATCH /settings`). Av ⇒ lagrade fält ignoreras och upplösningen blir exakt som före funktionen; att spara `ordinaryMinutesPerWeek` ≠ null ger 400 `schedule-balancing-off` (att nolla är alltid tillåtet). Webben läser `/settings` (systemmodulens läsrätt är `office`).
- **Veckoschemat** bär regeln (`week_schedules.ordinary_minutes_per_week`, null = ingen utjämning, och `atf_minutes_per_week`), inte dagsschemat — den korta dagen flyttar (röd fredag ⇒ torsdag), så ATF och inarbetning hör till veckan. Dagsschemat ger bara formen (start och raster).
- **Den rena filen** `timereport/service/schedule-balancing.ts` (inga DB-importer) är **enda implementationen**: andelar = ordinarie/ATF delat på veckoschemats arbetsdagar (nettotid > 0); arbetsdagar minus helgdagar (**hela och halvdagar**); mål = arbetsdagar × (ordinarie − ATF) + förlorad ATF; sista arbetsdagen = mål − övriga arbetsdagars nettotid, avrundat **en gång**; sluttiden går framåt från dagsschemats start genom obetalda raster och vidare efter dess sluttid. `findBalancingProblem` prövar alla helgdagskombinationer (≤ 2⁷) — sista dagen > 0 utan frånvaro och före 24:00 med frånvarons värsta fall — och används av veckoschemats sparande, `updateDaySchedule` (för varje utjämnat veckoschema som använder dagen) och förhandsvisningen (`POST /week-schedules/preview`, `readOnlySafe`). Felen är `ScheduleBalancingInvalidError` ⊂ `InvalidScheduleError` (400 `schedule-balancing-invalid`) med **svenskt** meddelande som visas som det är.
- **Förlorad ATF:** `absence_types.earns_atf` (**Tjänar in ATF**; false för SJK/VAB/FPE/TJL i migrationen och i `STANDARD_ABSENCE_TYPES`). Bara dagar **före** sista arbetsdagen räknas, proportionellt (andel × frånvarominuter / dagens nettotid, högst en andel). Sista arbetsdagens egen frånvaro räknas aldrig — annars blir Heldag cirkulär (registreringen skulle göra dagen längre än frånvaron). Frånvaro som registreras i efterhand flyttar sista dagen bakåt; det syns som Ofördelat, med flit.
- **`resolveEmployeeCalendar` är enda stället som räknar** — lönen (schemalagd tid, Ofördelat, övertid, schemafönstret), avvikelsepolicyn, `measuredSessionsOf` och Heldag läser `daySchedule.netMinutes`/`endTime` och följer med utan egen kod. Dagsschemats egna värden ligger i `scheduleNetMinutes`/`scheduleEndTime`, och sista dagen har `balance` (syskon till `daySchedule`). **Fälla:** upplösningen hämtar helgdagar och frånvaro för **hela ISO-veckorna** runt intervallet — terminalen frågar om en enda dag. Dagöverstyrningar deltar inte i räkningen; en dagöverstyrning **på** sista dagen vinner (`source = "day-override"`). Veckoöverstyrning använder det veckoschemats fält.
- **Frånvaro är hälsodata:** `GET /employees/:id/schedule-calendar` skickar `includeAbsence` bara för admin/arbetsledare (som `absentToday`); övriga — kontorsanvändare och terminalen — får kalendern som om ingen frånvaro fanns (ingen `lostAtfMinutes`, ingen förlängd sista dag), så den förskjutna sluttiden inte röjer sjuk/VAB. Lönen och terminalens avvikelsefråga anropar tjänsten direkt och räknar alltid med frånvaron. Testet ligger i `.route.test.ts`.
- **Av = ingen validering:** `updateDaySchedule`/`updateWeekSchedule` prövar lagrade fält bara när inställningen är på — annars kunde ett dolt, ogiltigt fält stoppa vanliga schemaändringar. Slås inställningen på igen med fält som inte går ihop skyddar upplösningens clamp lönemotorn tills formuläret sparas om. Validering och skrivning sker inte i samma transaktion (två samtidiga ändringar kan spara en kombination som aldrig prövats — clampen skyddar).
- **Beroendena är valfria:** `createScheduleService(repo, employees, locks, { settings, absences })` — utan fjärde argumentet ingen utjämning, så befintliga fixturer är oförändrade. Frånvaroläsaren är payroll-repositoryt, injicerat direkt (det byggs före schematjänsten i `app.ts`). Utelämnade fält i `createWeekSchedule` (fixturer, exempeldata) betyder ingen utjämning.
- **Inget dras från Navs ATF-saldo** och inget skickas i löneunderlaget — kontot förs i lönesystemet. Resursernas kapacitet läser veckoscheman direkt och ignorerar utjämningen (några minuter i korta veckor).
- Tester: `schedule-balancing.test.ts` (regeln), `.service.test.ts` (sparande, förhandsvisning, upplösning inkl. endagsanrop), `.route.test.ts` (inställning, felkoder), `.payroll.test.ts` (lönen och terminalens fråga följer med).

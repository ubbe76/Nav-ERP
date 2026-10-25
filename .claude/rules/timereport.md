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

---
paths:
  - "apps/api/src/modules/alerts/**"
  - "apps/web/app/aviseringar/**"
  - "apps/web/components/alerts/**"
  - "apps/web/components/dashboard/**"
  - "apps/web/lib/alerts.ts"
  - "packages/shared/src/alerts.ts"
  - "apps/api/test/alert*"
---

# Aviseringar (migration 0134)

Spec `docs/superpowers/specs/2026-10-21-aviseringar-design.md`.

- Aviseringarna räknas fram ur nuläget vid varje anrop — **inget lagras och inget kvitteras**; en avisering försvinner när orsaken åtgärdas.
- Rena katalogen `alerts/service/alert-kinds.ts` (`ALERT_KIND_CATALOG`, spegel `packages/shared/src/alerts.ts` och `apps/web/lib/alerts.ts`) är enda stället där en typs rubrik, allvar, rättighet och listsida står; `visibleKinds(user)` filtrerar på behörighetsgrupperna.
- En läsare per typ i `alerts.repository.ts` som **återanvänder systemets egna definitioner**:
  - `stock_negative` (totalsaldo < 0)
  - `sales_order_late`/`purchase_order_late` (rad med rest vars `salesRowDeliveryDate`/`purchaseRowArrivalDate` < i dag; offerter och levererade ordrar räknas aldrig)
  - `manufacturing_order_late` (`orderPlanSummaries().late` = TO-listans **Sen**)
  - `purchase_needed`/`manufacture_needed` (behovsberäkningens förslag via `planningService.requirementProposals()`, genom 60 s-cachen, aldrig refresh)
  - `customer_invoice_overdue` (`openAmountSql`)
  - `supplier_invoice_due` (attesterad, öppen, förfallodatum — lagrat annars `computeDueDate` — ≤ i dag + `alert_supplier_invoice_days`; röd när förfallen; fakturor i en levande betalningsomgång utesluts)
  - `einvoice_failed` (senaste **produktions**sändning failed/rejected utan levande sändning)
  - `email_failed` (admin, 14 dagar, utan senare lyckat utskick av samma dokument; för `document_id` null samma mottagare)
  - `quote_followup` (**Offerter att följa upp**: quote med giltighetsdatum ≤ i dag + `alert_quote_followup_days`, röd när utgången), `recurring_verification_failed`, `bank_unreconciled`
- Ett fel i en läsare ger gruppen `error: true` och en generisk text (felet loggas, går aldrig ut). `GET /alerts` (läsregel `office`, tillåten för Endast läsning). Webben: `/aviseringar` (sidomenyn under Översikt i `Nav.tsx`) och Översiktens **Att bevaka**, som läser samma svar — flödesremsans försenade/negativa siffror också.
- **Daglig sammanställning:** opt-in per användare (`user_settings` `alertDigest`/`alertDigestKinds`, null = alla synliga typer). Jobbet `alert_digest` i `server.ts`:s lista skickar efter `alert_digest_time` (Stockholmstid) på arbetsdagar (heldagshelger lediga), räknar typerna EN gång per körning och filtrerar per mottagare, reserverar `(user_id, digest_date)` i `alert_digest_runs` med `INSERT … ON CONFLICT DO NOTHING` **före** sändning (aldrig två mejl, inget nytt försök samma dag, ingen ikappkörning); tom lista ⇒ `empty` utan mejl. Mejlet (`alert-digest-mail.ts`, rent, HTML-escapat) länkar via systeminställningen `public_base_url` (**Navs adress**; tom ⇒ inga länkar). Dokumenttypen `alert_digest` (**Daglig sammanställning**) kan inte skickas om (409 `alert-digest-resend`).

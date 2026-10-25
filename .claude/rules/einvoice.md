---
paths:
  - "apps/api/src/modules/einvoice/**"
  - "apps/web/app/system/e-faktura/**"
  - "apps/web/components/einvoice/**"
  - "apps/web/lib/einvoice.ts"
  - "packages/shared/src/einvoice.ts"
  - "apps/api/test/einvoice*"
  - "apps/api/test/ubl*"
  - "apps/api/test/peppol*"
  - "apps/api/test/b2brouter*"
---

# E-faktura via Peppol (etapp 1, migration 0133)

Spec `docs/superpowers/specs/2026-10-21-e-faktura-peppol-design.md`. Etapp 2 (mottagning, webhooks, utland/valuta, automatik vid Utfärda) står i specen §7.

- Modulen bygger kundfakturan/kreditfakturan som **UBL enligt Peppol BIS Billing 3** själv och använder accesspunkten bara som transport. `EInvoiceProvider` (`einvoice-provider.ts`) är sömmen och `b2brouter-provider.ts` enda filen som känner till B2Brouter (samma bas-URL för sandlåda och produktion — nyckeln styr: `test_` sandlåda, `prod_` produktion). Aldrig `err.message` från transportfel i loggar/svar. Tester injicerar `test/helpers/fake-einvoice-provider.ts`.
- **Byggaren är ren** (`einvoice/service/ubl/`, kontraktet `ubl-types.ts`, handskriven XML i schemaordning på bankfilernas `xml-writer.ts`):
  - Navs lagrade radbelopp är facit (`LineExtensionAmount` = `line_amount`, kategorins moms = summan av radernas `vat_amount`, inom schematronens ±1).
  - Rabatten är en **rad-AllowanceCharge**, därför är `Price/PriceAmount` **bruttopriset** (nettopris + avdrag vore dubbelt).
  - Kreditfakturans belopp är positiva; 25/12/6 % ⇒ kategori S, 0 % ⇒ E ("Undantagen från mervärdesskatt"), OB ⇒ AE; F-skatt som en andra `PartyTaxScheme` (SE-R-005); bankgiro/plusgiro kod 30 med `SE:BANKGIRO`/`SE:PLUSGIRO`, IBAN kod 58; betalningsuppgifterna valfria.
  - `ubl-check.ts` (`checkUblInput`) stoppar före sändning (400 `einvoice-document-invalid`). Golden-filerna i `test/fixtures/ubl/` valideras mot OASIS UBL 2.1-XSD:erna (`test/helpers/ubl-xsd.ts`) och har godkänts av B2Brouters schematron.
- **Bara svenska kunder och SEK, manuell knapp:** `einvoiceService.send` vägrar utkast, privatperson, utländsk kund, annan valuta, saknat orgnr/momsnr hos företaget och saknad mottagare (`EinvoiceNotAllowedError` 409 med `reason`). Mottagaren är `customers.peppol_id` (`schema:värde`) eller `0007:` + organisationsnumret.
- **Sändningsloggen** `einvoice_transmissions` är append-only (NV001-trigger på dokumentet/identiteten, statuskolumnerna uppdateras); dokumentet lagras exakt som det skickades (bytea + sha256). Partiella unika indexet `einvoice_transmissions_live` på **`(invoice_id, environment)`** ger en levande sändning (`sending|sent|delivered`) per faktura **och miljö** — en sandlådesändning spärrar aldrig den skarpa.
- **Inga DB-transaktioner över HTTP:** raden skrivs `sending` före anropet, `submit(doc, { onImported })` sparar B2Brouters id direkt efter importen, och ett misslyckat `send_invoice` efter importen avgörs av B2Brouters tillstånd (`new`/`error` = inget skickat ⇒ `failed`, annat ⇒ skickat, oläsbart ⇒ kvar som `sending`) så ett omförsök aldrig ger en dubblett hos kunden.
- **Statusjobbet** (`einvoice-status.service.ts`, `runStatusIfDue` i `server.ts`:s jobblista; lease `einvoice_status_lease_until` 15 min, intervall `einvoice_status_interval_minutes`) pollar `sending`/`sent` yngre än 30 dagar, skriver villkorat på läst status och mappar tillstånden i `einvoice-status.ts` (okänt ⇒ `sending`, aldrig levererat; `delivered` är slutligt — betalt styrs av reskontran). `sending` utan provider-id, kvar i `new` efter 10 min, eller ett dokument B2Brouter inte längre hittar ⇒ `failed` så omsändning blir möjlig.
- Inställningarna är `einvoice_*`-nycklar (API-nyckeln write-only; **Testa anslutning** sparar inget, **Spara** tar konto-id + namn). `/system/e-faktura` varnar när B2Brouter-kontots momsnummer skiljer sig från Företagsuppgifter (B2Brouter vägrar då importen).
- Webben: fakturakortets **E-faktura** (`EInvoiceSection`), kundkortets **Fakturaleverans**/**Peppol-id**/**Kontrollera** (`PeppolFields`, katalogfrågan lagras aldrig) och fakturalistans kolumn (`einvoiceStatus` föredrar senaste produktionssändningen). Aviseringen `einvoice_failed`.
- **Sandlådetestet** `einvoice-b2brouter.sandbox.test.ts` körs bara med `B2BROUTER_SANDBOX_API_KEY` (testmottagare i schema 0088). Kontot behöver en Peppol-transport i sandlådan, annars svarar `send_invoice` 422 "To use Peppol Network you need to configure this connection": webbens Peppol-aktivering gäller bara produktion, sandlådan behöver `POST /accounts/{id}/transports` med `{ transport: { code: "peppol", reception: false, pin_scheme: "0007", pin_value: <orgnr> } }` och `test_`-nyckeln (kontrollera med GET). Verifierat grönt 2026-10-21.

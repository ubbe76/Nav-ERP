// Swedish translations for the API's machine-readable error codes.
//
// The authority for which codes exist is packages/shared/src/error-codes.ts
// (ERROR_CODES) — the web can't import @navet/shared (Turbopack chokes on
// the package's .js-suffixed imports, see apps/web/lib/units.ts's own
// duplication note), so the code STRINGS are duplicated here as plain
// literals instead of re-exporting that module. Keep this dictionary's keys
// in sync with ERROR_CODES by hand; apps/api/test/error-codes.test.ts pins
// the API side (class name -> code derivation) so a class rename fails loudly
// there rather than silently breaking the mapping this file relies on.
import type { ApiError } from "./api";

// Which registers keep System → Exempeldata from running, in prose.
export const DEMO_BLOCKER_LABELS: Record<string, string> = {
  articles: "artiklar",
  customers: "kunder",
  suppliers: "leverantörer",
  workCenters: "resurser",
};

export function demoBlockersText(blockers: string[]): string {
  const words = blockers.map((b) => DEMO_BLOCKER_LABELS[b] ?? b);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} och ${words.at(-1)}`;
}

type MessageEntry = string | ((err: ApiError) => string);

// For codes whose API message is already Swedish AND names the specific rule
// or document (which shipment, which freight rule) — a dictionary string
// would only hide that. The fallback covers an empty server message.
const serverMessage =
  (fallback: string): MessageEntry =>
  (err) =>
    err.message || fallback;

// "1 234,56" for a number (or numeric string) in an error body, else null.
const moneyOrNull = (value: unknown): string | null =>
  typeof value === "number" || (typeof value === "string" && value !== "" && Number.isFinite(Number(value)))
    ? Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null;

const MESSAGES: Record<string, MessageEntry> = {
  // article register (inline editing)
  "base-unit-locked": "Standardenheten kan inte ändras så länge artikeln har alternativa enheter.",
  "invalid-unit": "Enheten finns inte eller hör inte till artikeln.",
  "invalid-reference": "Ett valt värde finns inte längre — ladda om sidan.",
  "article-copy-part-not-allowed":
    "Beredning kopieras bara till tillverkade artiklar och Inköp bara till köpta artiklar och tjänster.",

  // payroll / timereport
  "unfinished-attendance": "Medarbetaren har en öppen närvarostämpling — åtgärda i detaljvyn först.",
  "already-attested": "Medarbetaren är redan attesterad.",
  "attestation-not-found": "Ingen attestering hittades.",
  "article-not-found": "Artikeln hittades inte.",
  // The server names the template ("63000 är en mall — välj en variant").
  "article-is-template": serverMessage("Artikeln är en mall — välj en variant."),
  "payroll-period-locked": "Perioden är låst.",
  "period-not-ended": "Perioden kan låsas först när månaden är slut.",
  "unattested-employees": (err) => {
    const body = err.body as { names?: unknown } | undefined;
    const names = Array.isArray(body?.names) ? (body!.names as string[]) : [];
    return `Alla medarbetare måste attesteras innan perioden kan låsas: ${names.join(", ")}`;
  },
  "material-shortage": (err) =>
    `Det finns inte tillräckligt med ingående delar: ${shortageList(err)}.`,
  "period-not-locked": "Perioden är inte låst.",
  "invalid-attendance-interval": "Sluttiden måste vara efter starttiden",
  "already-present": "Medarbetaren är redan instämplad",
  "attendance-open-from-earlier-day": "Närvaron har stått öppen sedan en tidigare dag — ange när du gick hem.",
  "attendance-input-required": "Ange anledning eller hur övertiden ska ersättas innan stämplingen sparas.",
  "attendance-reason-invalid": "Anledningen finns inte eller är inaktiv — välj en annan.",
  "atf-transaction-mismatch": "ATF-uttaget hör inte till den här medarbetaren i dag.",
  "attendance-session-changed":
    "Närvaron ändrades under tiden (till exempel stämplades den ut i terminalen). Öppna den igen och gör om ändringen.",
  "invalid-stop-time": "Sluttiden måste vara efter instämplingen och inte i framtiden.",
  "stamp-session-already-stopped":
    "Stämplingen är redan utstämplad — operationen kan ha blivit klar. Rapportera antalet på tillverkningsordern.",
  "stop-time-not-allowed": "Bara arbetsledare och administratörer kan ange sluttid.",
  "duplicate-absence": "Frånvaro med samma kod finns redan på det datumet",
  "duplicate-payroll-code": "Koden eller namnet finns redan",
  "invalid-ob-window": "Sluttiden måste vara efter starttiden",
  // economy
  "overlapping-fiscal-year": "Räkenskapsåret överlappar ett befintligt räkenskapsår",
  "fiscal-year-before-closed-year": "Räkenskapsåret ligger före ett stängt räkenskapsår — ett år kan inte läggas upp före ett stängt år",
  "vat-period-not-covered": "Intervallet täcker inte hela redovisningsperioder.",
  "vat-period-already-settled": "Perioden är redan deklarerad — omför momsomföringen först.",
  "vat-accounts-not-distinct":
    "Redovisningskontot för moms eller Öres- och kronutjämning har en momsruta som momsomföringen tömmer — välj ett konto utan momsruta under Konteringsregler.",
  "accounting-period-locked": "Perioden för det här datumet är låst för bokföring",
  "zero-amount-posting": "Ingen moms att omföra i perioden.",
  "no-accounting-period": "Ingen period täcker det valda datumet",
  "no-accounting-period-for-posting": "Ingen period täcker det valda datumet",
  "missing-posting-account": "Ett konto saknas eller är inaktivt i kontoplanen — kontrollera standardkontona eller anläggningsgruppens konton.",
  "account-not-found": "Kontot hittades inte",
  "duplicate-account-number": "Ett konto med det numret finns redan",
  "no-fiscal-year-for-date": "Inget räkenskapsår täcker det valda datumet",
  "verification-series-not-found": "Vald serie hittades inte",
  "unbalanced-verification": "Verifikatet balanserar inte — kontrollera raderna",
  "too-few-verification-rows": "Verifikatet behöver minst två rader för att bokföras",
  "inactive-account": "Ett av kontona på raderna är inaktivt",
  "already-reversed": "Verifikatet är redan omfört",
  "invalid-verification-state": "Verifikatet är i fel status för åtgärden",
  "duplicate-posting-rule": "Det finns redan en regel för den artikelgruppen och momskoden",
  "posting-rule-no-accounts": "Minst ett konto (intäkt eller kostnad) måste anges",
  // momskoder
  "vat-code-not-found": "Momskoden hittades inte — ladda om sidan.",
  "vat-code-slot-not-used": "Momskoden använder inte den kontoroll du angav.",
  "vat-code-account-invalid": "Kontot finns inte i kontoplanen eller är inaktivt.",
  "vat-code-account-conflict":
    "Momskoden använder samma konto för två roller — bokföringen skulle ta ut sig själv. Välj olika konton.",
  "posting-rule-vat-code": "Importmomskoder kan inte ha en konteringsregel — de används bara för importmomsen.",
  "import-vat-code": "Varje rad måste ha en aktiv importmomskod (Importmoms 25, 12 eller 6 %).",
  "vat-file-org-number-missing":
    "Företagets organisationsnummer saknas eller har inte tio siffror — ange det under Företagsuppgifter.",
  "vat-code-amount-mismatch":
    "Fakturaraden har moms trots att momskoden är momsfri, eller en annan sats än momskoden — rätta raden.",
  "vat-code-not-applicable": "Momskoden kan inte användas på den här typen av dokument.",
  "vat-code-required": "Momskoden används när Nav väljer momskod automatiskt och kan inte inaktiveras.",
  "invalid-vat-code": "Momskoden finns inte, är inaktiv eller kan inte användas här — välj en annan momskod.",
  // The server's sentence names which rule failed (missing number, wrong
  // country prefix, not SE + ten digits + 01) — it is Swedish already.
  "vat-number-required": serverMessage(
    "Kunden saknar ett giltigt momsregistreringsnummer — det krävs för EU-försäljning och omvänd betalningsskyldighet."
  ),
  // Periodisk sammanställning
  "periodic-summary-period-invalid": "Perioden måste vara exakt en kalendermånad eller ett kalenderkvartal.",
  "periodic-summary-reporter-incomplete":
    "Uppgifter saknas för filen — företagets momsregistreringsnummer (Företagsuppgifter) samt kontaktpersonens namn och telefonnummer måste vara ifyllda.",
  "periodic-summary-amount-too-large":
    "Ett belopp är för stort för filen (högst 12 tecken inklusive minustecken) — kontrollera fakturorna i perioden.",
  "periodic-summary-empty": "Ingen EU-försäljning i perioden — ingen periodisk sammanställning ska lämnas.",
  "periodic-summary-no-valid-rows": "Alla EU-fakturor i perioden saknar giltigt momsnummer — rätta kunderna.",
  // The server's sentence says which rule failed (name or phone) — Swedish already.
  "vat-reporting-contact-invalid": serverMessage(
    "Kontaktpersonens namn eller telefonnummer går inte att skriva i Skatteverkets fil — kontrollera uppgifterna."
  ),
  "supplier-invoice-vat-code":
    "Fakturan har moms, men momskoden tar ingen debiterad moms (omvänd moms, momsfritt eller import) — välj en svensk momskod eller ange momsbelopp 0.",
  // Valuta
  // The server names the currency and day ("Ingen kurs för EUR 2026-10-24 —
  // ange kursen själv").
  "exchange-rate-unavailable": serverMessage("Ingen kurs hittades — ange kursen själv."),
  "riksbank-unavailable": (err) => {
    const reason = (err.body as { reason?: string } | undefined)?.reason;
    if (reason === "rate_limited") return "Riksbanken tar inte emot fler anrop just nu — försök igen om en minut eller ange kursen själv.";
    if (reason === "unauthorized") return "Riksbanken godkände inte API-nyckeln — kontrollera den under Ekonomi → Valutakurser.";
    if (reason === "unexpected") return "Riksbanken gav ett oväntat svar — försök igen eller ange kursen själv.";
    return "Riksbanken svarar inte — försök igen eller ange kursen själv.";
  },
  "supplier-invoice-exchange-rate": "En faktura i SEK har alltid kurs 1.",
  "supplier-invoice-exchange-rate-missing":
    "Fakturan är i utländsk valuta men saknar kurs — ange kursen innan fakturan godkänns.",
  "payment-mixed-currencies": (err) => {
    const currencies = (err.body as { currencies?: unknown } | undefined)?.currencies;
    const list = Array.isArray(currencies) ? ` (${(currencies as string[]).join(", ")})` : "";
    return `En betalning kan inte blanda valutor${list} — välj bara fakturor i samma valuta.`;
  },
  "supplier-payment-amount-sek": (err) => {
    const body = err.body as { reason?: string; currency?: string } | undefined;
    switch (body?.reason) {
      case "required":
        return `En betalning i ${body.currency ?? "utländsk valuta"} behöver beloppet i SEK som drogs från kontot.`;
      case "sign":
        return "Beloppet i SEK måste vara skilt från 0 och ha samma tecken som betalningen.";
      case "fee":
        return "Bankavgiften kan inte vara större än beloppet i SEK.";
      case "kvittning":
        return "En kvittning flyttar inga pengar — den har varken belopp i SEK eller bankavgift.";
      case "sek":
        return "En betalning i SEK drar exakt sitt belopp och har ingen separat bankavgift.";
      default:
        return "Beloppet i SEK eller bankavgiften passar inte betalningen.";
    }
  },
  // Valuta: försäljning
  "sales-order-currency-locked": "Valutan kan inte ändras när ordern har rader — ta bort raderna först.",
  "sales-order-exchange-rate": "En order i SEK har alltid kursen 1.",
  "sales-order-currency-changed": (err) => {
    const body = err.body as { pricedIn?: string; currency?: string } | undefined;
    return body?.pricedIn && body.currency
      ? `Orderns valuta ändrades till ${body.currency} medan raden prissattes i ${body.pricedIn} — lägg till raden igen.`
      : "Orderns valuta ändrades medan raden prissattes — lägg till raden igen.";
  },
  "price-list-currency-locked": "Valutan kan inte ändras när prislistan har rader.",
  "invoice-row-currency-mismatch": (err) => {
    const body = err.body as { rowCurrency?: string; invoiceCurrency?: string } | undefined;
    return body?.rowCurrency && body.invoiceCurrency
      ? `Raden är i ${body.rowCurrency} men fakturan är i ${body.invoiceCurrency} — en faktura har en valuta. Fakturera ordrar i olika valutor på var sin faktura.`
      : "Raden har en annan valuta än fakturan — en faktura har en valuta.";
  },
  "invoice-exchange-rate": (err) =>
    (err.body as { reason?: string } | undefined)?.reason === "credit"
      ? "En kreditfaktura har alltid den krediterade fakturans kurs."
      : "En faktura i SEK har alltid kursen 1.",
  "reminder-fee-currency": (err) => {
    const currency = (err.body as { currency?: string } | undefined)?.currency;
    return `Påminnelseavgift kan bara tas ut på fakturor i SEK${currency ? ` — fakturan är i ${currency}` : ""}. Skicka påminnelsen utan avgift.`;
  },
  // Dröjsmålsränta och förseningsersättning
  "late-interest-disabled":
    "Dröjsmålsränta är avstängd — slå på Debitera dröjsmålsränta under Ekonomi → Konteringsregler.",
  "late-interest-already-charged": (err) => {
    const ids = (err.body as { invoiceIds?: unknown } | undefined)?.invoiceIds;
    const n = Array.isArray(ids) ? ids.length : 0;
    return n > 0
      ? `Ränta eller förseningsersättning har redan debiterats på ${n} ${n === 1 ? "faktura" : "fakturor"} sedan listan hämtades — uppdatera listan och försök igen.`
      : "Ränta eller förseningsersättning har redan debiterats sedan listan hämtades — uppdatera listan och försök igen.";
  },
  "late-interest-future-date": "T.o.m. datum kan inte ligga efter dagens datum — ränta debiteras bara för dagar som har passerat.",
  "reminder-fee-after-late-fee":
    "Förseningsersättning är debiterad på fakturan — påminnelseavgiften ryms i ersättningen. Skicka påminnelsen utan avgift.",
  "reference-rate-riksbank":
    "Räntan är hämtad från Riksbanken och kan inte tas bort — lägg in en egen ränta för halvåret om den ska ersättas.",
  // Fakturaskanning
  "invoice-scan-duplicate": (err) => {
    const existing = (err.body as { existing?: { scanNumber?: string } } | undefined)?.existing;
    return `Samma fil finns redan i fakturainkorgen${existing?.scanNumber ? ` (${existing.scanNumber})` : ""}.`;
  },
  "invoice-scan-ai-not-configured":
    "AI-tolkning är inte inställd — välj läge och ange API-nyckel under System → Fakturaskanning.",
  "supplier-invoice-file-from-scan":
    "Underlaget kom från fakturainkorgen och är den mottagna fakturan — det kan inte tas bort.",
  "invoice-scan-not-found": "Fakturan finns inte i fakturainkorgen längre — ladda om sidan.",
  "invoice-scan-busy": "En AI-tolkning av filen pågår redan — vänta tills den är klar och försök igen.",
  // Reklamationer och avvikelser (Kvalitet)
  "deviation-not-found": "Avvikelsen finns inte längre — ladda om sidan.",
  // The server names the field and the document (Swedish).
  "deviation-link-mismatch": serverMessage("Kopplingarna hör inte ihop — kontrollera kund/leverantör, order, rad och artikel."),
  "deviation-link-not-allowed": serverMessage("Dokumentet kan inte kopplas till avvikelsen."),
  "deviation-reason-not-applicable": serverMessage("Orsaken gäller inte den här typen av avvikelse."),
  "deviation-close-requirements": serverMessage("Fyll i Åtgärd (och Beslut) innan avvikelsen avslutas."),
  "deviation-not-editable": "Avvikelsen är avslutad eller makulerad — öppna den igen för att ändra.",
  "deviation-cost-not-found": "Kostnadsraden finns inte längre — ladda om sidan.",
  "deviation-link-not-found": "Kopplingen finns inte längre — ladda om sidan.",
  "deviation-file-not-found": "Filen finns inte längre — ladda om sidan.",
  "invalid-deviation-file-type": "Filtypen stöds inte — ladda upp PDF, JPEG eller PNG.",
  "deviation-file-too-large": "Filen är för stor — max 20 MB.",
  "scrap-reason-required": serverMessage("Välj en kassationsorsak."),
  "scrap-reason-invalid": "Kassationsorsaken finns inte, är inaktiv eller gäller inte kassation — välj en annan.",
  // The server names what went wrong with the key / the mailbox.
  "invoice-scan-ai-test-failed": serverMessage("AI-tjänsten svarade inte med den här nyckeln och modellen."),
  "invoice-scan-mail-test-failed": serverMessage("Kunde inte ansluta till e-postlådan."),
  "invoice-scan-mail-password-required":
    "Skriv in lösenordet igen när server eller användare ändras — det sparade lösenordet skickas inte till en annan server eller användare.",
  "invoice-scan-mail-folders-equal": "Mapp för inlästa får inte vara samma mapp som den som läses.",
  "customer-payment-amount-sek": (err) => {
    const body = err.body as { reason?: string; currency?: string } | undefined;
    switch (body?.reason) {
      case "required":
        return `En betalning i ${body.currency ?? "utländsk valuta"} behöver beloppet i SEK som kom in på kontot.`;
      case "sign":
        return "Beloppet i SEK måste vara skilt från 0 och ha samma tecken som betalningen.";
      case "fee":
        return "Bankavgiften kan inte vara större än beloppet i SEK.";
      case "kvittning":
        return "En kvittning flyttar inga pengar — den har varken belopp i SEK eller bankavgift.";
      case "sek":
        return "En betalning i SEK har beloppet självt i SEK och ingen egen bankavgift.";
      default:
        return "Beloppet i SEK eller bankavgiften passar inte betalningen.";
    }
  },
  "fiscal-year-closed": "Räkenskapsåret är stängt — öppna det igen under Bokslut",
  "year-end-closing-not-found": "Bokslutet hittades inte",
  "year-end-closing-exists": "Räkenskapsåret har redan ett bokslut",
  "invalid-closing-date": "Bokslutsdatumet måste ligga i räkenskapsårets sista period",
  "closing-date-locked": "Bokslutsdatumet kan inte ändras efter att ett steg bokförts",
  "year-end-closing-closed": "Bokslutet är stängt — öppna året igen först",
  "year-end-closing-verification": "Verifikatet hör till bokslutet — gör om steget i bokslutsguiden",
  "year-end-blocked": "Bokslutet är spärrat — se Kontroller i guiden",
  "inventory-account-conflict": "Lager och Lagerförändring kan inte vara samma konto — ändra under Konteringsregler",
  "invalid-accrual-account": "Kontot passar inte för den typen av periodisering — balanskontot ska ligga på rätt sida och resultatkontot i klass 3–8",
  "next-fiscal-year-missing": "Nästa räkenskapsår kunde inte skapas automatiskt — lägg upp det under Räkenskapsår",
  "year-end-step-order":
    "Gör stegen Lagerförändring, Avskrivningar och Periodiseringar — och Valutaomvärdering när det finns öppna fakturor i annan valuta — före resultatöverföringen",
  // The server names the currencies and the day: body.currencies (ISO codes),
  // body.date (the closing date).
  "fx-revaluation-rate-missing": (err) => {
    const body = err.body as { currencies?: unknown; date?: unknown } | undefined;
    const currencies = Array.isArray(body?.currencies) ? (body!.currencies as string[]) : [];
    const date = typeof body?.date === "string" ? ` per ${body.date}` : "";
    return currencies.length > 0
      ? `Kurs saknas för ${currencies.join(", ")}${date} — skriv kursen i fältet Kurs i steget Valutaomvärdering.`
      : "Kurs saknas — skriv kursen i fältet Kurs i steget Valutaomvärdering.";
  },
  "year-end-closing-not-closed": "Bokslutet är inte stängt",
  "next-fiscal-year-closed": "Nästa räkenskapsår är stängt — öppna det först",
  "profit-disposition-active": "Vinstdispositionen är bokförd — ångra den först",
  "invalid-agm-date": "Stämmodatumet måste ligga efter räkenskapsårets slut och får inte vara i framtiden",
  "profit-disposition-exists": "Vinstdispositionen är redan bokförd — ångra den först",
  "nothing-to-dispose": "Konto 2099 har inget saldo att disponera",
  "profit-disposition-not-found": "Det finns ingen bokförd vinstdisposition att ångra",
  // anläggningsregister
  "fixed-asset-not-found": "Anläggningen hittades inte",
  "fixed-asset-category-not-found": "Anläggningsgruppen hittades inte",
  "supplier-invoice-not-found": "Leverantörsfakturan hittades inte",
  "depreciation-run-not-found": "Avskrivningskörningen hittades inte",
  "duplicate-fixed-asset-category-name": "En grupp med det namnet finns redan",
  "fixed-asset-category-in-use": "Gruppen har anläggningar och kan inte tas bort",
  "fixed-asset-category-accounts-not-distinct": "Tillgångskonto, ack-konto och kostnadskonto måste vara tre olika konton",
  "fixed-asset-category-accounts-locked": "Tillgångskonto, ack-konto och kostnadskonto är låsta — gruppen har bokförd eller ingående avskrivning",
  "fixed-asset-bas-account-missing": "Ett BAS-konto saknas — kör Förifyll BAS-urval i kontoplanen först",
  "fixed-asset-field-locked": "Fältet är låst — avskrivning är bokförd på anläggningen",
  "fixed-asset-not-active": "Anläggningen är avyttrad",
  "fixed-asset-has-depreciation": "Anläggningen har bokförda avskrivningar och kan inte tas bort",
  "fixed-asset-life-too-short": "Nyttjandetiden kan inte vara kortare än de månader som redan bokförts",
  "invalid-fixed-asset-values": "Ogiltiga värden för anläggningen",
  "invalid-opening-depreciation": "Ogiltig ingående avskrivning — beloppet får inte överstiga anskaffningsvärde minus restvärde, och månaden måste vara en passerad månad inom nyttjandetiden, inte före avskrivningsstart",
  "depreciation-month-in-future": "Månaden har inte passerat — avskrivningar förbokas inte",
  "nothing-to-depreciate": "Inget att bokföra — alla månader t.o.m. vald månad är redan avskrivna",
  "depreciation-run-not-latest": "Bara den senaste körningen kan ångras",
  "disposal-run-not-undoable": "Körningen hör till en avyttring och kan inte ångras",
  "run-precedes-disposal": "Körningen har avskrivningar på en avyttrad anläggning och kan inte ångras — avyttringen är slutgiltig",
  "invalid-disposal-date": "Ogiltigt avyttringsdatum",
  "fixed-asset-verification": "Verifikatet hör till anläggningsregistret — ångra via Anläggningsregistret",
  "fixed-asset-plan-year-not-found": "Räkenskapsåret hittades inte",
  // sales / purchase
  "sales-order-row-not-found": "Orderraden hittades inte — den kan ha tagits bort.",
  "over-delivery": "Levererat antal skulle överskrida beställt antal på raden.",
  "row-has-receipts": "Raden har redan inleveranser och kan inte tas bort.",
  // A goods receipt carries the system setting Tillåten överleverans it broke
  // (allowedPercent > 0 ⇒ name it); a row edit below the received quantity
  // and a receipt at 0 % read the plain sentence.
  "over-receipt": (err) => {
    const body = err.body as { allowedPercent?: unknown } | undefined;
    const percent = typeof body?.allowedPercent === "number" ? body.allowedPercent : 0;
    return percent > 0
      ? `Mottaget antal skulle överskrida beställt antal med mer än tillåten överleverans (${percent.toLocaleString("sv-SE")} %) på raden.`
      : "Mottaget antal skulle överskrida beställt antal på raden.";
  },
  "price-list-in-use": "Prislistan används av en kund och kan inte tas bort.",
  "duplicate-price-list-row": "Prislistan har redan en rad för artikeln vid den mängdgränsen.",
  "invalid-ocr": "Ogiltigt OCR-nummer — ingen öppen post hittades.",
  "payment-exceeds-open-amount": "Beloppet överstiger fakturans öppna belopp.",
  "verification-already-reversed": "Verifikatet har redan en omföring.",
  "supplier-payment-already-cancelled": "Betalningen är redan makulerad.",
  "collective-invoicing-customer": "Kunden har Samlingsfaktura — fakturera via Försäljning → Samlingsfakturering.",
  "invalid-shipment-invoice-row": serverMessage(
    "Fraktraden är ogiltig — försändelsen måste vara bokad, tillhöra kunden och faktureras med antal 1."
  ),
  "shipment-already-invoiced": "Frakten för försändelsen är redan fakturerad.",
  "freight-already-invoiced": serverMessage("Frakten för ordern är redan fakturerad via en försändelse — ingen fraktrad läggs till."),
  "shipment-on-draft-invoice": serverMessage(
    "Frakten ligger på ett fakturautkast — ta bort fraktraden från utkastet innan du avbokar."
  ),
  "register-entry-in-use": "Posten används och kan inte tas bort utan att kopplingarna flyttas till en annan post.",
  "invalid-replacement": "Ogiltig ersättningspost — välj en annan post i samma register.",
  // article / manufacturing
  // lego (Etapp G)
  "not-subcontract-operation": "Legofält (leverantör, priser, ritning) kräver en legoresurs som resurs.",
  "work-center-supplier-not-found": "Leverantören hittades inte.",
  "operation-file-not-found": "Operationen har ingen ritning.",
  "invalid-operation-file-type": "Filtypen stöds inte — bara PDF, JPEG och PNG.",
  "mo-operation-not-found": "Tillverkningsorderns operation hittades inte.",
  "operation-has-linked-material":
    "Operationen har material kopplat till sig och kan inte märkas Kalkyl — ta bort operationskopplingen på strukturraden först.",
  "costing-only-operation-link": "Operationen är en kalkyloperation och kan inte dra material.",
  "duplicate-bom-component":
    "Komponenten ligger redan i artikelns struktur — ändra den befintliga raden i stället.",
  "duplicate-inquiry-row": "Artikeln finns redan på förfrågan — lägg operationen på en egen förfrågan.",
  // system
  "series-exhausted": "Nummerserien är full — kontrollera nummerserien under System.",
  "duplicate-number-series-name": "Det finns redan en nummerserie med det namnet.",
  "built-in-number-series": "Den inbyggda nummerserien kan inte byta namn eller tas bort.",
  "order-register-too-large": "Urvalet har fler än 10 000 orderrader — avgränsa med datum, status eller kund/leverantör.",
  "quote-followup-too-large": "Urvalet har fler än 10 000 offerter — korta ned perioden eller välj en kund.",
  "quote-loss-reason-invalid": "Förlustorsaken finns inte eller är inaktiv — välj en annan orsak.",
  "unknown-theme": "Temat finns inte längre — välj ett annat tema.",
  "theme-invalid": "Temat innehåller fel eller klarar inte kontrastkravet (4,5:1) och kan inte sparas.",
  "theme-name-taken": "Det finns redan ett tema med det namnet — välj ett annat namn.",
  "theme-is-default": "Temat är företagets förvalda tema — välj ett annat förval innan det tas bort.",
  "theme-limit": "Det får finnas högst 50 egna teman — ta bort ett innan du lägger till ett nytt.",
  "plugin-not-found": "Tillägget finns inte (längre).",
  "plugin-manifest-invalid": "Manifestet innehåller fel — se listan.",
  "plugin-manifest-unreachable": "Manifestet kunde inte hämtas från tilläggets adress.",
  "plugin-key-taken": "Ett tillägg med samma nyckel är redan installerat.",
  "plugin-same-host":
    "Tillägget måste köras på en annan värd än Nav — samma värd med en annan port räcker inte, eftersom inloggningen då skulle följa med till tillägget.",
  "plugin-invalid-address": "Adressen måste vara en http- eller https-adress utan användarnamn, frågedel eller fragment.",
  "plugin-delivery-not-found": "Leveransen finns inte (längre).",
  "plugin-delivery-not-retryable": "Bara misslyckade leveranser kan skickas igen.",
  "plugin-access-denied": "Du har inte behörighet till den här delen av tillägget.",
  "plugin-route-forbidden": "Tilläggets API-nyckel kan inte användas mot den här adressen.",
  "plugin-key-with-session": "En tilläggsnyckel kan inte skickas tillsammans med en inloggning.",
  "plugin-user-managed": "Tilläggets användare hanteras under System → Tillägg.",
  "cross-site-request": "Anropet kom från en annan webbplats och vägrades. Öppna Nav direkt och försök igen.",
  "permission-group-owned-by-plugin": "Behörighetsgruppen hör till ett tillägg och ändras under System → Tillägg.",
  "demo-data-not-available": (err) => {
    const blockers = (err.body as { blockers?: string[] } | undefined)?.blockers ?? [];
    return blockers.length
      ? `Exempeldata kan bara skapas på en tom installation — det finns redan ${demoBlockersText(blockers)}.`
      : "Exempeldata kan bara skapas på en tom installation.";
  },
  // auth
  forbidden: "Du saknar behörighet för den här åtgärden.",
  "invalid-credentials": "Fel e-postadress eller lösenord.",
  "client-scope-missing": "API-klienten saknar behörighet för det här anropet.",
  "client-customer-mismatch": "API-klienten är knuten till en annan kund.",
  "client-price-not-allowed": "En API-klient som är knuten till en kund kan inte sätta egna priser.",
  "api-client-customer-not-found": "Kunden finns inte.",
  "invalid-setup-code":
    "Fel eller saknad engångskod. Koden skrivs i API:ts logg när det startar — kör docker compose logs api på servern.",
  "registration-closed": "Det första kontot är redan skapat. Logga in, eller be en administratör skapa ett konto åt dig.",
  "login-throttled": (err) => {
    const seconds = (err.body as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    const minutes = seconds ? Math.max(1, Math.ceil(seconds / 60)) : null;
    return minutes
      ? `För många misslyckade inloggningsförsök — försök igen om ${minutes} min.`
      : "För många misslyckade inloggningsförsök — försök igen om en stund.";
  },
  "self-delete": "Du kan inte ta bort ditt eget konto.",
  "permission-group-in-use": "Gruppen används av användare — välj en grupp att flytta dem till.",
  "duplicate-permission-group-code": "Det finns redan en behörighetsgrupp med den koden.",
  // Endast läsning
  "read-only-account": "Kontot kan bara läsa — ändringar är avstängda.",
  "read-only-admin": "En administratör kan inte ha Endast läsning — välj rollen Användare eller Arbetsledare och en behörighetsgrupp.",
  // bankfiler
  "invalid-supplier-payment-details": serverMessage("Betalningsuppgifterna är ogiltiga."),
  "supplier-invoice-reserved": "Fakturan ingår i en betalfil och betalas när banken bekräftat betalningen.",
  "supplier-invoice-in-payment-batch": (err) =>
    `Fakturan ingår i betalfil ${/payment batch (\S+)/.exec(err.message)?.[1] ?? ""} — ta bort den ur omgången eller markera betalningen som avvisad först.`,
  "bank-file-parse": serverMessage("Filen kunde inte läsas som XML."),
  "unsupported-bank-message": "Filen är inte en camt.054 (version 001.02). Hämta debiterings- eller kreditavin i det formatet i internetbanken.",
  "bank-settings-incomplete": (err) => `Bankinställningarna är inte klara: ${err.message}. Be en administratör fylla i Bank under System.`,
  "invalid-bank-setting": serverMessage("Inställningen kunde inte sparas."),
  "payment-batch-not-found": "Betalfilen hittades inte.",
  "payment-batch-item-not-found": "Posten hittades inte i betalfilen.",
  "supplier-invoices-not-payable": serverMessage("Några fakturor kan inte läggas i en betalfil."),
  "invalid-payment-batch-item": serverMessage("Posten kunde inte ändras."),
  "payment-batch-item-not-confirmable": "Posten väntar inte längre på banken — den är redan bekräftad, avvisad eller makulerad.",
  "invalid-payment-date": serverMessage("Datumet går inte att använda."),
  "payment-file-invalid": serverMessage("Betalfilen skulle inte godkännas av banken."),
  "bank-file-not-found": "Bankfilen hittades inte.",
  "bank-entry-not-found": "Posten hittades inte i bankfilen.",
  "bank-entry-already-booked": "Posten är redan bokförd eller hanterad.",
  "bank-entry-amount-mismatch": "Fördelningen ska bli exakt postens belopp.",
  "bank-entry-direction": serverMessage("Posten hör till den andra riktningen."),
  "bank-entry-not-matched": "Posten hör inte till någon betalfil — markera den som Hanterad utanför Nav om den är bokförd på annat sätt.",
  "bank-entry-amount-differs":
    "Bankens belopp skiljer sig från betalfilens (en betalning i utländsk valuta jämförs på beloppet i fakturans valuta, och avin måste ange det). Kontrollera i internetbanken och hantera posten manuellt.",
  // Per-row booking results (bank files / Bekräfta utförd) carry the code of
  // whatever refused that row; these are not in ERROR_CODES because no route
  // maps them to a standalone response in this feature.
  "supplier-invoice-not-open": "Fakturan är inte längre en öppen, attesterad post — kontrollera Öppna poster.",
  "invoice-not-open": "Fakturan är inte längre en öppen post — den kan ha betalats på annat sätt sedan förhandsgranskningen.",
  "invalid-status-transition": "Åtgärden går inte att göra i det här läget — ladda om sidan.",
  "bank-return-before-payment":
    "Returen är bokförd av banken före utbetalningens datum. Kontrollera betalningsdatumet och makulera utbetalningen manuellt under Betalningar.",
  // Valuta steg 2: the bank returned a payment in another currency with another
  // SEK amount than it took (the rate moved in between).
  "bank-return-sek-differs":
    "Returen gäller ett annat belopp i kronor än utbetalningen tog från kontot. Makulera utbetalningen manuellt under Betalningar och bokför skillnaden för hand.",
  // configurator — the server's messages are Swedish and name the code, rule
  // or type that has to change, so they are shown as they are.
  "configurator-template-not-found": "Artikeln är inte konfigurerbar.",
  "configurator-template-exists": "Artikeln är redan konfigurerbar — ladda om sidan.",
  "configurator-group-not-found": "Valgruppen finns inte längre — ladda om sidan.",
  "configurator-value-not-found": "Alternativet finns inte längre — ladda om sidan.",
  "configurator-rule-not-found": "Regeln finns inte längre — ladda om sidan.",
  "configurator-code-taken": serverMessage("Koden används redan."),
  "configurator-reference-in-use": serverMessage("Används av regler, strukturrader eller operationer — ändra eller ta bort dem först."),
  "invalid-configurator-rule": serverMessage("Regeln passar inte konfiguratorn."),
  "invalid-configurator-group": serverMessage("Valgruppen kunde inte sparas."),
  "configurator-mode-not-allowed": serverMessage("Artikelns typ tillåter inte det läget."),
  "invalid-configurator-formula": serverMessage("Formeln är inte giltig."),
  "invalid-configurator-line": serverMessage("Strukturraden passar inte konfiguratorn."),
  "invalid-configurator-operation": serverMessage("Operationen passar inte konfiguratorn."),
  "configurator-sequence-taken": serverMessage("Operationsnumret används redan."),
  "configurator-line-not-found": "Strukturraden finns inte längre — ladda om sidan.",
  "configurator-operation-not-found": "Operationen finns inte längre — ladda om sidan.",
  "configurator-too-many-combinations": serverMessage("För många kombinationer — begränsa urvalet."),
  "invalid-configurator-variant-set": serverMessage("Urvalet för varianterna är inte giltigt."),
  "configurator-not-variant-mode": "Mallen är inte i läget Variantartiklar.",
  "configurator-template-has-variants": "Mallen har varianter och kan inte byta läge eller tas bort.",
  "configurator-variant-not-template": "En variant kan inte göras till mall.",
  "configurator-code-locked": serverMessage("Koden används av varianter och kan inte ändras."),
  "configurator-variant-number-race": "Artikelnumret togs under tiden — försök igen.",
  "configurator-variant-not-found": "Artikeln är ingen variant.",
  "configurator-invalid-configuration": serverMessage("Konfigurationen är inte giltig."),
  "configurator-variant-number-taken": serverMessage("Artikelnumret används redan av en annan artikel."),
  "configurator-variant-too-long": serverMessage("Artikelnumret eller benämningen blir för lång."),
  "configurator-variant-not-derivable":
    "Kombinationen kan inte tillverkas — förhandsgranska varianterna på mallens artikelkort för att se vad i strukturen som saknas.",
  "configurator-not-to-order-mode": "Mallen är inte i läget Beställningsvara.",
  "configurator-not-published": "Mallen är inte publicerad för API:t.",
  "configuration-required": serverMessage("Artikeln är en beställningsvara — konfigurera den."),
  "configuration-not-allowed": serverMessage("Artikeln är inte en beställningsvara."),
  // The server's message says which: a check needs an open order, a
  // reservation (Skapa tillverkningsordrar) a confirmed one.
  "sales-order-not-open": serverMessage(
    "Leveranstiden kan bara kontrolleras för en offert, en bekräftad order eller en order under tillverkning."
  ),
  "row-configuration-locked": serverMessage("Konfigurationen kan inte ändras — raden har gått vidare."),
  "row-configuration-changed":
    "Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration.",
  "row-variant-exists": serverMessage("Varianten ligger redan som rad på ordern."),
  "work-center-not-found": "Resursen finns inte.",
  // Ångra rapportering / Makulera order (TO)
  "mo-report-not-found": "Rapporteringen finns inte — ladda om sidan.",
  "report-has-no-pallet-card": "Rapporten har inget pallkort — bara en operationsrapport som inte är ångrad kan skrivas ut.",
  "mo-report-already-undone": "Rapporteringen är redan ångrad — ladda om sidan.",
  "mo-report-from-purchase-receipt": "Rapporteringen kommer från en inleverans på inköpsordern och kan inte ångras här.",
  "mo-report-stock-missing": serverMessage("De inlevererade varorna finns inte kvar på lagerplatsen."),
  // Ångra inleverans (IO card). The stock message names both quantities.
  "purchase-receipt-not-found": "Inleveransen finns inte — ladda om sidan.",
  "purchase-receipt-already-undone": "Inleveransen är redan ångrad — ladda om sidan.",
  "purchase-receipt-stock-missing": serverMessage("De inlevererade varorna finns inte kvar på lagerplatsen."),
  "purchase-receipt-manufacturing-order-locked":
    "Tillverkningsordern som legoraden hör till är inte längre öppen — inleveransen kan inte ångras.",
  // Ångra utleverans
  "delivery-not-found": "Följesedeln finns inte — ladda om sidan.",
  "delivery-row-not-found": "Följesedelsraden finns inte — ladda om sidan.",
  "delivery-row-already-undone": "Raden är redan ångrad — ladda om sidan.",
  "delivery-row-not-undoable": "Leveransen gjordes innan Nav sparade lagerplatsen och kan inte ångras.",
  "delivery-on-shipment": serverMessage("Följesedeln ligger på en försändelse — ta bort den därifrån eller avboka först."),
  "delivery-row-invoiced": serverMessage("Raden är fakturerad — kreditera fakturan eller ta bort fakturautkastet först."),
  "delivery-undone": "Följesedeln är ångrad — pallkort kan inte skrivas ut.",
  "shipment-delivery-undone": serverMessage("Följesedeln är ångrad och kan inte ligga på en försändelse."),
  "location-under-stock-count": serverMessage("Lagerplatsen är under inventering — försök igen när inventeringen är klar."),
  // Produktionsplanering (Flytta / Lås upp)
  "operation-not-found": "Operationen finns inte — ladda om beläggningen.",
  "operation-not-plannable": serverMessage("Operationen kan inte planeras — den är klar, en legooperation, utan tid eller ordern är inte öppen."),
  "plan-week-in-past": "Veckan har passerat — välj innevarande vecka eller en senare.",
  // Reservationen från Leveranstidskontrollen (the 409 body carries the new result).
  "delivery-time-changed": "Läget har ändrats sedan kontrollen — se det nya datumet och försök igen.",
  "nothing-to-reserve": "Kontrollen fann inget att tillverka — det som saknas köps in eller finns redan på väg.",
  "mo-report-time-locked": "Stämplingens tid ligger i en låst löneperiod — rapporteringen kan inte ångras.",
  "manufacturing-order-has-reports": "Ordern har rapporteringar — ångra dem först under Rapporteringar.",
  "manufacturing-order-stamped-in": "Någon är instämplad på ordern — stämpla ut först.",
  // Ändra material och operationer på en skapad tillverkningsorder
  "manufacturing-order-not-editable": "Ordern kan bara ändras när den är frisläppt eller pågår.",
  "mo-material-consumed": "Materialet är redan förbrukat — det går inte att ta bort raden eller byta artikel. Ändra antalet i stället.",
  "mo-material-duplicate": "Komponenten finns redan på ordern för den operationen — ändra den raden i stället.",
  "mo-material-own-article": "Orderns egen artikel kan inte vara material på ordern.",
  "mo-material-phantom": "En fantomartikel lagerhålls aldrig — lägg till dess komponenter i stället.",
  "mo-operation-not-on-order": "Operationen hör inte till ordern.",
  "mo-operation-sequence-taken": "Sekvensnumret används redan av en annan operation på ordern.",
  "mo-operation-done": "Operationen är klar och kan inte ändras.",
  "mo-operation-stamped": "Någon är instämplad på operationen — stämpla ut först.",
  "mo-operation-linked-purchase": "En inköpsorder eller förfrågan pekar på operationen — ta bort den raden först.",
  "mo-operation-reported": "Något är redan rapporterat på operationen — den går inte att ta bort eller byta typ av resurs på.",
  "last-operation-locked": "Varor är redan inlevererade — ändringen skulle byta vilken operation som är sist. Behåll den sista operationen.",
  // E-faktura (Peppol via B2Brouter). einvoice-not-allowed's message is the
  // Swedish sentence for the blocked reason; document-invalid and
  // provider-rejected get their problem lists appended by einvoiceErrorText.
  "einvoice-not-configured": (err) => {
    const reason = (err.body as { reason?: string } | undefined)?.reason;
    if (reason === "disabled") return "E-faktura är inte aktiverat — slå på det under System → E-faktura.";
    if (reason === "no-key") return "E-faktura saknar API-nyckel — lägg in den under System → E-faktura.";
    if (reason === "no-account") return "E-faktura saknar konto — kör Testa anslutning under System → E-faktura och spara.";
    return "E-faktura är inte konfigurerat — se System → E-faktura.";
  },
  "einvoice-not-allowed": serverMessage("Fakturan kan inte skickas som e-faktura."),
  "einvoice-already-sent": "Fakturan har redan en pågående eller godkänd e-fakturasändning.",
  "einvoice-document-invalid": "E-fakturan klarade inte Navs egen kontroll och skickades inte",
  "einvoice-provider-rejected": "Mottagande tjänst (B2Brouter) avvisade e-fakturan",
  "einvoice-provider-unauthorized": "B2Brouter nekade åtkomst — kontrollera API-nyckeln och miljön under System → E-faktura.",
  "einvoice-provider-unavailable": "B2Brouter svarar inte just nu — försök igen om en stund.",
  "einvoice-transmission-not-found": "Sändningen finns inte — ladda om sidan.",
  // Snabbare manuell bokföring: verifikatmallar, återkommande verifikat, SIE-import av verifikat
  "verification-template-not-found": "Mallen finns inte — ladda om sidan.",
  "verification-template-name-taken": "Det finns redan en mall med det namnet — välj ett annat namn.",
  "verification-template-account-missing": (err) => {
    const body = err.body as { accounts?: unknown } | undefined;
    const accounts = Array.isArray(body?.accounts)
      ? body!.accounts.map((a) => (a && typeof a === "object" && "number" in a ? String((a as { number: unknown }).number) : String(a)))
      : [];
    return accounts.length > 0
      ? `Konton som inte finns i kontoplanen: ${accounts.join(", ")}.`
      : "Ett konto finns inte i kontoplanen.";
  },
  "verification-template-in-use":
    "Mallen används av en återkommande post och kan inte tas bort — ta bort den återkommande posten först, eller inaktivera mallen.",
  "recurring-verification-not-found": "Den återkommande posten finns inte — ladda om sidan.",
  // The server's sentence says which rule failed (a row without amount, or a template that does not balance).
  "recurring-template-incomplete": serverMessage(
    "Mallen måste ha belopp på alla rader och balansera för att kunna användas som återkommande post."
  ),
  "sie-file-already-imported": (err) => {
    const body = err.body as { importedAt?: unknown; importedBy?: unknown } | undefined;
    const when =
      typeof body?.importedAt === "string" && !Number.isNaN(Date.parse(body.importedAt))
        ? new Date(body.importedAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })
        : null;
    const who = typeof body?.importedBy === "string" && body.importedBy ? body.importedBy : null;
    return `Filen har redan importerats${when ? ` ${when}` : ""}${who ? ` av ${who}` : ""}.`;
  },
  "sie-invalid-account-number": serverMessage("Ett konto i filen har inte fyra siffror och kan inte skapas."),
  "sie-verification-import-blocked": (err) => {
    const body = err.body as { blockers?: unknown } | undefined;
    const blockers = Array.isArray(body?.blockers) ? body!.blockers.map(String) : [];
    return blockers.length > 0
      ? `Ingenting importerades: ${blockers.join(" ")}`
      : "Ingenting importerades — filen har fel som måste rättas först.";
  },
  // Bankavstämning (bankkonton, kontoutdrag, matchning, Bokför på en post,
  // bankregler, Avstämd t.o.m.) — mirrors banking.errors.ts's etapp 4 block.
  "bank-account-not-found": "Bankkontot hittades inte — ladda om sidan.",
  "bank-account-identifier-taken": "Ett bankkonto med den IBAN eller det kontonumret finns redan.",
  "bank-account-ledger-missing": "Huvudbokskontot finns inte i kontoplanen eller är inaktivt — välj ett befintligt konto.",
  "bank-account-required": "Välj vilket bankkonto kontoutdraget gäller.",
  "bank-statement-format": "Filen är inte ett kontoutdrag i camt.053 (version 001.02). En camt.054-avi läses in under Bankfiler.",
  "bank-statement-csv-mapping": serverMessage("CSV-filen kunde inte läsas med kolumnmappningen — kontrollera avgränsare, rader att hoppa över och kolumnerna."),
  "bank-statement-account-unknown": (err) => {
    const body = err.body as { identifiers?: unknown } | undefined;
    const ids = Array.isArray(body?.identifiers) ? body!.identifiers.map(String).filter(Boolean) : [];
    return ids.length > 0
      ? `Kontoutdraget gäller ett konto som inte finns under Bankkonton (${ids.join(", ")}) — lägg upp det eller välj vilket bankkonto det är.`
      : "Kontoutdraget gäller ett konto som inte finns under Bankkonton — lägg upp det eller välj vilket bankkonto det är.";
  },
  "bank-statement-account-mismatch": "Kontoutdragets konto hör till ett annat bankkonto än det valda.",
  "bank-statement-currency": "Kontoutdraget är i en annan valuta än bankkontot.",
  "bank-statement-entry-not-found": "Posten på kontoutdraget hittades inte — ladda om sidan.",
  "bank-match-not-found": "Matchningen hittades inte — ladda om sidan.",
  "bank-match-sum-mismatch": (err) => {
    const body = err.body as { entriesSum?: unknown; rowsSum?: unknown } | undefined;
    const entries = moneyOrNull(body?.entriesSum);
    const rows = moneyOrNull(body?.rowsSum);
    return entries !== null && rows !== null
      ? `Summorna är olika: posterna på kontoutdraget ${entries} kr, raderna i bokföringen ${rows} kr. En matchning kräver lika summor.`
      : "Posterna på kontoutdraget och raderna i bokföringen har olika summor — en matchning kräver lika summor.";
  },
  "bank-match-already-matched": "En av posterna eller raderna är redan matchad — ladda om sidan.",
  "bank-match-wrong-account": "Posterna och raderna hör inte till det här bankkontot, eller så är verifikatet inte bokfört.",
  "bank-match-already-undone": "Matchningen är redan ångrad — ladda om sidan.",
  "bank-entry-book-mismatch":
    "Verifikatet ska ha en rad på bankkontots huvudbokskonto med exakt postens belopp, på rätt sida (debet för en inbetalning, kredit för en utbetalning).",
  // kostnadsställen och projekt
  "cost-center-code-taken": "Koden används redan av ett annat kostnadsställe — välj en annan kod.",
  "project-code-taken": "Koden används redan av ett annat projekt — välj en annan kod.",
  "project-closed": "Projektet är stängt och kan inte väljas på nya rader — öppna projektet igen eller välj ett annat.",
  "cost-center-inactive": serverMessage("Kostnadsstället är inaktivt och kan inte väljas på nya rader — välj ett annat."),
  "cost-center-not-found": "Kostnadsstället hittades inte — ladda om sidan.",
  "project-not-found": "Projektet hittades inte — ladda om sidan.",
  "project-customer-not-found": "Kunden som projektet kopplats till hittades inte — ladda om sidan.",
  "project-dates": "Slutdatum kan inte vara före startdatum.",
  // The server names the object ("Kostnadsstället 100 används på bokförda verifikat …").
  "dimension-booked": serverMessage("Objektet används på bokförda verifikat och kan inte tas bort — inaktivera det i stället."),
  "cost-center-required": (err) => {
    const accounts = (err.body as { accounts?: unknown } | undefined)?.accounts;
    const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === "string") : [];
    return list.length > 0
      ? `${list.length === 1 ? "Konto" : "Konton"} ${list.join(", ")} kräver kostnadsställe — välj kostnadsställe på raderna.`
      : "Ett konto på verifikatet kräver kostnadsställe — välj kostnadsställe på raderna.";
  },
  // budget
  "budget-not-found": "Budgeten hittades inte — ladda om sidan.",
  "budget-name-taken": "Det finns redan en budget med det namnet för räkenskapsåret — välj ett annat namn.",
  "budget-account-invalid": (err) => {
    const accounts = (err.body as { accounts?: unknown } | undefined)?.accounts;
    const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === "string") : [];
    return list.length > 0
      ? `${list.length === 1 ? "Konto" : "Konton"} ${list.join(", ")} kan inte budgeteras — det finns inte i kontoplanen eller ligger utanför kontoklass 3–8.`
      : "Ett konto kan inte budgeteras — det finns inte i kontoplanen eller ligger utanför kontoklass 3–8.";
  },
  "budget-month-invalid": "Budgeten har ett annat antal månader än räkenskapsåret — ladda om sidan.",
  "budget-duplicate-account": "Samma konto förekommer på flera rader — slå ihop dem.",
  "budget-no-previous-year": "Det finns inget föregående räkenskapsår att hämta utfall från — välj ett källår.",
  "budget-not-combinable": "Budget kan inte kombineras med Projekt eller Per kostnadsställe/Per projekt.",
  "budget-range-outside-year": "Perioden ligger utanför budgetens räkenskapsår — välj datum inom samma år.",
  "bank-rule-not-found": "Bankregeln hittades inte — ladda om sidan.",
  "bank-rule-missing": "Ingen aktiv bankregel känner igen posten — bokför den med Bokför i stället.",
  "bank-rule-ambiguous": (err) => {
    const ids = (err.body as { ruleIds?: unknown } | undefined)?.ruleIds;
    const n = Array.isArray(ids) ? ids.length : 0;
    return n > 1
      ? `${n} bankregler träffar posten — bokför den med Bokför och välj konto själv, eller gör reglerna entydiga.`
      : "Flera bankregler träffar posten — bokför den med Bokför och välj konto själv, eller gör reglerna entydiga.";
  },
  "bank-rule-account-missing": (err) => {
    const number = (err.body as { accountNumber?: unknown } | undefined)?.accountNumber;
    return typeof number === "string" && number !== ""
      ? `Konto ${number} finns inte i kontoplanen eller är inaktivt — rätta regeln eller kontot.`
      : "Regelns konto (eller momskodens momskonto) finns inte i kontoplanen eller är inaktivt — rätta regeln eller kontot.";
  },
  "bank-reconciliation-incomplete": (err) => {
    const body = err.body as { reason?: unknown; count?: unknown; statementBalance?: unknown; ledgerBalance?: unknown } | undefined;
    const count = typeof body?.count === "number" ? body.count : null;
    switch (body?.reason) {
      case "no-statement-balance":
        return "Kontoutdragets saldo saknas för det datumet — importera ett kontoutdrag som sträcker sig till datumet.";
      case "unmatched-entries":
        return count !== null
          ? `${count} ${count === 1 ? "post" : "poster"} på kontoutdraget till och med datumet är omatchade — matcha eller bokför dem först.`
          : "Det finns omatchade poster på kontoutdraget till och med datumet — matcha eller bokför dem först.";
      case "unmatched-rows":
        return count !== null
          ? `${count} ${count === 1 ? "rad" : "rader"} i bokföringen till och med datumet är omatchade — matcha dem först.`
          : "Det finns omatchade rader i bokföringen till och med datumet — matcha dem först.";
      case "balance-mismatch": {
        const statement = moneyOrNull(body?.statementBalance);
        const ledger = moneyOrNull(body?.ledgerBalance);
        const transit = typeof (body as { inTransit?: unknown } | undefined)?.inTransit === "number" ? ((body as { inTransit: number }).inTransit) : 0;
        const transitText = transit !== 0 ? ` (varav ${moneyOrNull(transit)} kr i transit — matchningar som korsar datumet)` : "";
        return statement !== null && ledger !== null
          ? `Kontoutdragets saldo ${statement} kr stämmer inte med bokföringens saldo ${ledger} kr per datumet${transitText}.`
          : "Kontoutdragets saldo stämmer inte med bokföringens saldo per datumet.";
      }
      default:
        return "Allt till och med datumet måste vara matchat och kontoutdragets saldo måste stämma med bokföringens innan perioden kan markeras som avstämd.";
    }
  },
  "bank-opening-balance-mismatch": (err) => {
    const body = err.body as { statementBalance?: unknown; ledgerBalance?: unknown } | undefined;
    const statement = moneyOrNull(body?.statementBalance);
    const ledger = moneyOrNull(body?.ledgerBalance);
    return statement !== null && ledger !== null
      ? `Kontoutdragets saldo ${statement} kr stämmer inte med bokföringens saldo ${ledger} kr per startdatumet. Bokför skillnaden först, eller kontrollera saldot och datumet.`
      : "Kontoutdragets saldo stämmer inte med bokföringens saldo per startdatumet — bokför skillnaden först.";
  },
  "bank-opening-not-allowed": (err) => {
    const reason = (err.body as { reason?: unknown } | undefined)?.reason;
    return reason === "later-mark"
      ? "Startpunkten kan inte ångras — en senare avstämning bygger på den."
      : "Bankkontot är redan avstämt — en startpunkt kan bara skapas innan den första avstämningen.";
  },
  "bank-account-in-use": (err) => {
    const field = (err.body as { field?: unknown } | undefined)?.field;
    return field === "currency"
      ? "Valutan kan inte ändras — bankkontot har importerade poster eller matchningar."
      : "Huvudbokskontot kan inte ändras — bankkontot har importerade poster eller matchningar. Lägg upp ett nytt bankkonto i stället.";
  },
  "bank-account-identifier-locked": (err) => {
    const body = err.body as { accountName?: unknown; identifier?: unknown; fileIdentifier?: unknown } | undefined;
    return typeof body?.accountName === "string" && typeof body?.fileIdentifier === "string"
      ? `Bankkontot ${body.accountName} har redan importerade poster under ${String(body.identifier ?? "sin identifierare")} — filens konto ${body.fileIdentifier} kan inte tas över. Lägg upp ett eget bankkonto för det.`
      : "Bankkontot har redan importerade poster under en annan identifierare — lägg upp ett eget bankkonto för filens konto.";
  },
  // generic (thrown by the zod/body-parsing layer, not a named domain error)
  "validation-failed": "Ogiltiga uppgifter — kontrollera fälten.",
  "invalid-request-body": "Ogiltig förfrågan.",
  "internal-server-error": "Ett oväntat fel inträffade.",
  "bookkeeping-record-locked": "Bokförd räkenskapsinformation kan inte ändras eller raderas — rätta med en omföring.",
};

// Chain: mapped Swedish text for err.code -> the API's own (English) message
// -> the caller's fallback. Only ApiError carries a `code`; any other thrown
// value (a plain Error, a non-Error throw) falls straight through to its
// message or the fallback.
// "Plåt 2 mm (behöver 8 st, tillgängligt 3 st), …" from a material-shortage body.
export function shortageList(err: ApiError): string {
  const body = err.body as { shortages?: unknown } | undefined;
  const shortages = Array.isArray(body?.shortages)
    ? (body!.shortages as Array<{
        articleName: string;
        unitCode: string;
        required: number;
        available: number;
      }>)
    : [];
  const fmt = (n: number) => Number(n).toLocaleString("sv-SE");
  return shortages
    .map((s) => `${s.articleName} (behöver ${fmt(s.required)} ${s.unitCode}, tillgängligt ${fmt(s.available)} ${s.unitCode})`)
    .join(", ");
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "code" in err) {
    const apiErr = err as ApiError;
    const entry = apiErr.code ? MESSAGES[apiErr.code] : undefined;
    if (entry) return typeof entry === "function" ? entry(apiErr) : entry;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

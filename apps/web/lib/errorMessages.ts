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
import { ApiError } from "./api";
import { formatStockholmDateTime } from "./date";

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

// The anläggningsgrupp's account roles, in prose (the form's labels are
// Tillgångskonto, Ack. avskrivningar, Avskrivningskostnad, Vinst/Förlust vid avyttring).
const FIXED_ASSET_ROLE_LABELS: Record<string, string> = {
  asset: "tillgångskonto",
  accumulated: "konto för ack. avskrivningar",
  expense: "konto för avskrivningskostnad",
  gain: "konto för vinst vid avyttring",
  loss: "konto för förlust vid avyttring",
};

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
  "employee-erasure-blocked":
    "Den anställde kan inte raderas eller anonymiseras än — markera som inaktiv, stäng öppna stämplingar och lås löneperioderna först.",
  "employee-has-history": "Den anställde har tid eller lön i systemet och kan bara anonymiseras, inte raderas.",
  "employee-anonymized": "Den anställde är anonymiserad och kan inte ändras.",
  "already-attested": "Medarbetaren är redan attesterad.",
  "attestation-not-found": "Ingen attestering hittades.",
  "article-not-found": "Artikeln hittades inte.",
  "duplicate-article-barcode": "En annan artikel har redan den streckkoden (EAN).",
  "invalid-file-type": "Filen måste vara en PDF, JPEG eller PNG.",
  // Företagsinfo's logo upload.
  "logo-file-missing": "Välj en bildfil att ladda upp.",
  "invalid-logo-file-type": "Logotypen måste vara en bild (PNG, JPEG …).",
  "article-unit-not-found": "Enheten finns inte längre på artikeln — ladda om sidan.",
  "article-file-not-found": "Filen finns inte längre.",
  "article-revision-not-found": "Revisionen finns inte längre — ladda om sidan.",
  "article-drawing-not-found": "Ritningen finns inte längre — ladda om sidan.",
  "article-group-not-found": "Varugruppen finns inte längre — ladda om sidan.",
  "stock-location-not-found": "Lagerplatsen finns inte längre — ladda om sidan.",
  "article-supplier-not-found": "Leverantörsraden finns inte längre på artikeln — ladda om sidan.",
  "supplier-not-found": "Leverantören finns inte längre.",
  "bom-cycle": "Komponenten skulle skapa en cirkulär struktur — en artikel kan inte ingå i sig själv.",
  // Fliken Revisioner (artikelrevisioner, ritningsnummer och ritningsrevisioner).
  "duplicate-revision": "Den revisionen finns redan.",
  "duplicate-drawing-number": "Artikeln har redan det ritningsnumret.",
  "drawing-file-not-loose": "Filen hör redan till en annan ritningsrevision.",
  "routing-drawing-invalid": "En vald ritning hör inte till artikeln.",
  "routing-file-invalid": "En vald fil hör inte till artikeln eller hör redan till en ritningsrevision.",
  "manufacturing-order-file-not-found": "Filen finns inte längre.",
  // The server names the template ("63000 är en mall — välj en variant").
  "article-is-template": serverMessage("Artikeln är en mall — välj en variant."),
  // Typbyte till Tjänst (tjänster lagerförs inte).
  "article-has-stock": "Artikeln har lagersaldo — justera saldot till 0 innan den görs till tjänst.",
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
  "stamp-work-center-changed":
    "Operationen har flyttats till en annan resurs sedan listan hämtades — välj den i den uppdaterade listan.",
  "attendance-open-from-earlier-day": "Närvaron har stått öppen sedan en tidigare dag — ange när du gick hem.",
  "attendance-input-required": "Ange anledning eller hur övertiden ska ersättas innan stämplingen sparas.",
  "attendance-reason-invalid": "Anledningen finns inte eller är inaktiv — välj en annan.",
  "atf-transaction-mismatch": "ATF-uttaget hör inte till den här medarbetaren i dag.",
  "schedule-balancing-off":
    "Ordinarie arbetstid och ATF på veckoschemat kräver att Tillåt ATF-uttag via schemat är på under Personal & lön → Lön, PAXml & schema.",
  "attendance-session-changed":
    "Närvaron ändrades under tiden (till exempel stämplades den ut i terminalen). Öppna den igen och gör om ändringen.",
  "attendance-start-in-future": "Starttiden kan inte ligga i framtiden.",
  "attendance-session-open": "Närvaron pågår — sätt en sluttid innan du tar bort den.",
  "duplicate-employee-number": "Anställningsnumret används redan av en annan anställd.",
  "invalid-stop-time": "Sluttiden måste vara efter instämplingen och inte i framtiden.",
  "stamp-session-already-stopped":
    "Stämplingen är redan utstämplad — operationen kan ha blivit klar. Rapportera antalet på tillverkningsordern.",
  "stop-time-not-allowed": "Bara arbetsledare och administratörer kan ange sluttid.",
  "duplicate-absence": "Frånvaro med samma kod finns redan på det datumet",
  "duplicate-payroll-code": "Koden eller namnet finns redan",
  "invalid-ob-window": "Sluttiden måste vara efter starttiden (00:00 betyder midnatt)",
  // economy
  "overlapping-fiscal-year": "Räkenskapsåret överlappar ett befintligt räkenskapsår",
  "fiscal-year-before-closed-year": "Räkenskapsåret ligger före ett stängt räkenskapsår — ett år kan inte läggas upp före ett stängt år",
  "vat-period-not-covered": "Intervallet täcker inte hela redovisningsperioder.",
  "vat-period-already-settled": "Perioden är redan deklarerad — omför momsomföringen först.",
  "vat-accounts-not-distinct":
    "Redovisningskontot för moms eller Öres- och kronutjämning har en momsruta som momsomföringen tömmer — välj ett konto utan momsruta under Konteringsregler.",
  "accounting-period-locked": "Perioden för det här datumet är låst för bokföring",
  // Thrown by many postings (momsomföring, fakturor och betalningar med belopp 0, avgifter) — one text for all.
  "zero-amount-posting": "Det finns inget belopp att bokföra — kontrollera beloppen eller att perioden har något att omföra.",
  "unknown-vat-rate": "En rad har en momssats som saknar momskonto — använd 25, 12, 6 eller 0 procent.",
  "supplier-invoice-amount-mismatch":
    "Netto + moms stämmer inte med brutto — kontrollera beloppen på leverantörsfakturan.",
  "po-match-mismatch": "Raden stämmer inte med inköpsordern den pekar på — kontrollera ordern och raden.",
  "no-accounting-period": "Ingen period täcker det valda datumet",
  "no-accounting-period-for-posting": "Ingen period täcker det valda datumet",
  "missing-posting-account": "Ett konto saknas eller är inaktivt i kontoplanen — kontrollera standardkontona eller anläggningsgruppens konton.",
  "account-not-found": "Kontot hittades inte",
  "duplicate-account-number": "Ett konto med det numret finns redan",
  "no-fiscal-year-for-date": "Inget räkenskapsår täcker det valda datumet",
  "verification-series-not-found": "Vald serie hittades inte",
  "verification-not-found": "Verifikatet finns inte längre — ladda om sidan.",
  "posting-rule-not-found": "Konteringsregeln finns inte längre — ladda om sidan.",
  "fiscal-year-not-found": "Räkenskapsåret finns inte längre — ladda om sidan.",
  "accounting-period-not-found": "Perioden finns inte längre — ladda om sidan.",
  "unbalanced-verification": "Verifikatet balanserar inte — kontrollera raderna",
  "too-few-verification-rows": "Verifikatet behöver minst två rader för att bokföras",
  "inactive-account": "Ett av kontona på raderna är inaktivt",
  "already-reversed": "Verifikatet är redan omfört",
  "reversal-rows-locked": "Raderna på en omföring speglar originalet och kan inte ändras — ändra datum eller beskrivning, bokför eller ta bort utkastet",
  "verification-is-reversal": "Verifikatet är en omföring och kan inte omföras — kopiera originalverifikatet om bokningen ska göras igen",
  "invalid-verification-state": "Verifikatet är i fel status för åtgärden",
  "duplicate-posting-rule": "Det finns redan en regel för den varugruppen och momskoden",
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
  // Påslag på offert och order
  "markup-repricing-not-confirmed": "Påslagen räknar om à-priset på rader — bekräfta omräkningen.",
  "markup-repricing-conflict": "Raderna på ordern ändrades medan påslagen sparades — ordern har lästs om, försök igen.",
  "sales-order-markups-changed": "Orderns påslag ändrades medan raden prissattes — ordern har lästs om, spara raden igen.",
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
      ? `Ränta eller förseningsersättning har redan debiterats eller ändrats på ${n} ${n === 1 ? "faktura" : "fakturor"} sedan listan hämtades — uppdatera listan och försök igen.`
      : "Ränta eller förseningsersättning har redan debiterats eller ändrats sedan listan hämtades — uppdatera listan och försök igen.";
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
  // Förbruka: manual consumption has a ceiling at the row's planned quantity.
  "over-consumption":
    "Det är mer än vad som är planerat för materialraden — höj planerat antal med Ändra på materialraden först.",
  // Spärrade lagerplatser
  "stock-location-already-blocked": "Lagerplatsen är redan spärrad — ladda om sidan.",
  "stock-location-not-blocked": "Lagerplatsen är inte spärrad — ladda om sidan.",
  "fallback-location-not-blockable": "Reservplatsen *** kan inte spärras — resten av ett uttag med Automatiskt hamnar där.",
  "stock-location-name-reserved": "Namnet *** är reserverat för reservplatsen — välj ett annat namn",
  "service-article-not-stocked": "Artikeln är en tjänst — tjänster lagerförs inte",
  // The server names the place (Swedish).
  "stock-location-blocked": serverMessage("Lagerplatsen är spärrad — välj en annan plats eller Automatiskt."),
  "forecast-month-outside-horizon": "Månaden ligger utanför prognoshorisonten — bara månader i horisonten kan få ett eget antal.",
  "default-location-blocked": "Lagerplatsen är spärrad och kan inte väljas som artikelns lagerplats — välj en annan.",
  // Lager-flikens Lagerplatser: the server names the place and the rule (Swedish).
  "article-location-invalid": serverMessage("Lagerplatserna kunde inte sparas — kontrollera huvudplatsen och de alternativa platserna."),
  // Kopierat (#28): the server names the count and the cap (Swedish).
  "copied-articles-too-many": serverMessage("Kopierat rymmer högst 5 000 artiklar — ta bort några eller ersätt listan."),
  // Prisåterföring from an efterkalkyl: per st is divided by the received
  // quantity, so a preliminary one or one with nothing received gives none.
  "cost-calculation-not-final": serverMessage("Efterkalkylen ger inget pris per styck — tillverkningsordern är inte klar eller inget är inlevererat."),
  // Förkalkylera flera (#27): the server names the count and the cap (Swedish).
  "pre-calculation-batch-too-large": serverMessage("Urvalet är för stort — högst 500 artiklar kan förkalkyleras åt gången. Snäva in urvalet med ett artikelnummerintervall, en varugrupp eller en artikelkod."),
  // Efterkalkylera flera (#34): the server names the count and the cap (Swedish).
  "post-calculation-batch-too-large": serverMessage("Urvalet är för stort — högst 500 tillverkningsordrar kan efterkalkyleras åt gången. Snäva in urvalet med datum, artikel eller varugrupp."),
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
  "fiscal-year-last-period-missing": "Räkenskapsåret saknar en period för sin sista dag — lägg upp perioderna under Räkenskapsår",
  // The server names the step that is missing (body.step, its Swedish name).
  "year-end-step-order": (err) => {
    const step = (err.body as { step?: unknown } | undefined)?.step;
    return typeof step === "string" && step !== ""
      ? `Gör steget ${step} före resultatöverföringen`
      : "Gör stegen Lagerförändring, Avskrivningar och Periodiseringar — och Produkter i arbete och Valutaomvärdering när de har något att bokföra — före resultatöverföringen";
  },
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
  "fixed-asset-category-account-role-conflict": (err) => {
    const body = err.body as { accountNumber?: unknown; role?: unknown; categoryName?: unknown; otherRole?: unknown } | undefined;
    const label = (role: unknown) => (typeof role === "string" ? FIXED_ASSET_ROLE_LABELS[role] : undefined);
    const own = label(body?.role);
    const other = label(body?.otherRole);
    return typeof body?.accountNumber === "string" && typeof body.categoryName === "string" && own && other
      ? `Konto ${body.accountNumber} är redan ${other} i gruppen ${body.categoryName} och kan inte vara ${own} — ett tillgångs- eller ack-konto får bara ha en roll i anläggningsregistret, annars stämmer avstämningen per konto inte.`
      : "Ett tillgångs- eller ack-konto används redan i en annan roll i en grupp — välj ett annat konto.";
  },
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
  // A delivery carries the order's Tillåten överleverans it broke (#24,
  // allowedPercent > 0 ⇒ name it); a row edit below the delivered quantity
  // and a delivery at 0 % read the plain sentence.
  "over-delivery": (err) => {
    const body = err.body as { allowedPercent?: unknown } | undefined;
    const percent = typeof body?.allowedPercent === "number" ? body.allowedPercent : 0;
    return percent > 0
      ? `Levererat antal skulle överskrida beställt antal med mer än tillåten överleverans (${percent.toLocaleString("sv-SE")} %) på raden.`
      : "Levererat antal skulle överskrida beställt antal på raden.";
  },
  "row-has-receipts": "Raden har redan inleveranser och kan inte tas bort.",
  // Kundorderraden: leveranser räknas även när de är ångrade, och en faktura
  // även när den är makulerad eller krediterad — historiken ligger kvar.
  "row-has-deliveries": "Raden har leveranser (även ångrade) och kan inte tas bort.",
  "row-has-invoice-rows": "Raden finns på en faktura (även makulerad eller krediterad) och kan inte tas bort.",
  "credit-exceeds-invoice": "Kreditfakturorna skulle överstiga beloppet på fakturan de krediterar.",
  "purchase-order-exchange-rate": "En inköpsorder i SEK har alltid kursen 1.",
  "inquiry-not-found": "Förfrågan hittades inte",
  "inquiry-row-not-found": "Förfrågningsraden hittades inte",
  "lego-operation-not-found": "Legooperationen hittades inte",
  "stock-count-not-found": "Inventeringen hittades inte",
  "stock-count-row-not-found": "Inventeringsraden hittades inte",
  "supplier-payment-row-mismatch":
    "En betalningsrad stämmer inte — raden reglerar ingenting, fakturan tillhör en annan leverantör eller beloppet pekar åt fel håll.",
  "lego-operation-article-mismatch": "Legooperationen tillhör en annan artikel än raden.",
  "not-lego-operation": "Operationen ligger inte på en legoresurs.",
  "lego-operation-closed": "Legooperationen är inte öppen — den är klar eller tillverkningsordern är inte frisläppt eller pågående.",
  "purchase-order-row-has-dispatches": "Raden har en avsändning till legoleverantören — ångra avsändningen först.",
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
  "duplicate-customer-article-number": "Kunden har redan ett artikelnummer för den här artikeln.",
  "customer-article-number-not-found": "Kundens artikelnummer finns inte längre.",
  "duplicate-price-list-row": "Prislistan har redan en rad för artikeln vid den mängdgränsen.",
  "invalid-ocr": "Ogiltigt OCR-nummer — ingen öppen post hittades.",
  "open-invoice-not-found-by-ocr": "Ingen öppen faktura har det OCR-numret.",
  "empty-invoice": "Fakturan har inga rader.",
  "over-invoicing": "Fakturerat antal skulle överstiga levererat antal på orderraden.",
  "over-credit": "Krediterat antal skulle överstiga fakturerat antal på orderraden.",
  "nothing-to-remind": "Fakturan har inget öppet belopp att påminna om.",
  "reminder-fee-already-charged": "Påminnelseavgift är redan debiterad på fakturan.",
  "smtp-not-configured": "E-post är inte inställt — ange e-postservern under Systeminställningar.",
  "mail-send": "E-postmeddelandet kunde inte skickas. Försök igen eller kontrollera e-postinställningarna.",
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
  // system
  "series-exhausted": "Nummerserien är full — kontrollera nummerserien under System.",
  "duplicate-number-series-name": "Det finns redan en nummerserie med det namnet.",
  "built-in-number-series": "Den inbyggda nummerserien kan inte byta namn eller tas bort.",
  "number-series-too-long":
    "Nästa nummer blir längre än 20 tecken med prefixet och antalet siffror — korta prefixet eller minska antalet siffror.",
  "number-series-number-taken": "Nästa nummer finns redan på ett dokument — välj ett nästa nummer efter de som redan används.",
  "document-number-taken":
    "Numret som nummerserien gav finns redan på ett annat dokument — ändra Nästa nummer under System → Nummerserier och försök igen.",
  "order-register-too-large": "Urvalet har fler än 10 000 orderrader — avgränsa med datum, status eller kund/leverantör.",
  "quote-followup-too-large": "Urvalet har fler än 10 000 offerter — korta ned perioden eller välj en kund.",
  "setup-charge-article-not-found": "Artikeln finns inte — välj en annan ställkostnadsartikel.",
  "quote-loss-reason-invalid": "Förlustorsaken finns inte eller är inaktiv — välj en annan orsak.",
  "quote-already-ordered": "Offerten har redan gett en kundorder och kan inte byta status — skapa fler ordrar med Skapa kundorder.",
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
  "configurator-mode-changed": "Artikelns konfiguratorläge ändrades medan tillverkningsordern skapades — försök igen.",
  "configurator-not-published": serverMessage("Mallen är inte publicerad för API:t."),
  "configuration-required": serverMessage("Artikeln är en beställningsvara — konfigurera den."),
  "configuration-not-allowed": serverMessage("Artikeln är inte en beställningsvara."),
  // The derivation's own messages (structure lines, operations) ride along as
  // details for a session — they say what to fix in the template.
  "configuration-not-derivable": (err) => {
    const details = (err.body as { details?: unknown } | undefined)?.details;
    const list = Array.isArray(details) ? details.filter((d): d is string => typeof d === "string") : [];
    return `Kombinationen kan inte tillverkas — åtgärda mallens struktur på artikelkortet.${
      list.length > 0 ? ` ${list.join("; ")}` : ""
    }`;
  },
  // The server's message says which: a check needs an open order, a
  // reservation (Skapa tillverkningsordrar) a confirmed one.
  "sales-order-not-open": serverMessage(
    "Leveranstiden kan bara kontrolleras för en offert, en bekräftad order eller en order under tillverkning."
  ),
  "row-configuration-locked": serverMessage("Konfigurationen kan inte ändras — raden har gått vidare."),
  "row-configuration-outdated":
    "Mallen har ändrats sedan raden konfigurerades — öppna Ändra konfiguration och spara valen innan antalet ändras.",
  "row-configuration-changed":
    "Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration.",
  "work-center-not-found": "Resursen finns inte.",
  // Alternativa resurser (#15): the API's text names the resource and the rule
  // in Swedish, so it is shown as it is.
  "routing-alternative-invalid": (err) => err.message || "Alternativen är inte giltiga.",
  "routing-operation-has-alternatives": (err) =>
    err.message || "Operationen har alternativa resurser — ta bort dem först.",
  "work-center-in-alternatives":
    "Resursen ingår i alternativa resurser — i en beredning eller på en öppen tillverkningsorder — och kan inte bli en legoresurs. Ta bort den som alternativ först.",
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
  // Avsändning lego
  "purchase-dispatch-row-not-lego": "Bara legorader kan skickas till leverantören — raden är inte kopplad till en operation.",
  "purchase-dispatch-not-found": "Avsändningen finns inte — ladda om sidan.",
  "purchase-dispatch-already-undone": "Avsändningen är redan ångrad — ladda om sidan.",
  "purchase-dispatch-undone": "Avsändningen är ångrad och har inget pallkort.",
  "purchase-order-not-found": "Inköpsordern finns inte — ladda om sidan.",
  "purchase-order-row-not-found": "Orderraden finns inte — ladda om sidan.",
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
  "plan-week-no-capacity": serverMessage("Resursen har ingen kapacitet den veckan — välj en annan vecka."),
  // Reservationen från Leveranstidskontrollen (the 409 body carries the new result).
  "delivery-time-changed": "Läget har ändrats sedan kontrollen — se det nya datumet och försök igen.",
  "nothing-to-reserve": "Kontrollen fann inget att tillverka — det som saknas köps in eller finns redan på väg.",
  // Flytta halvfabrikaten (pegging #9): the dialog's dates are stale
  "component-move-changed": "Färdigdatumet har ändrats sedan dialogen öppnades — ladda om och försök igen.",
  // Skapa saknade halvfabrikat (pegging #9): the 409 body carries the new preview
  "missing-components-changed": "Läget har ändrats sedan förhandsvisningen — se de nya tillverkningsordrarna och försök igen.",
  "nothing-to-create": "Det finns inga saknade halvfabrikat att skapa tillverkningsordrar för.",
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
  "mo-operation-resource-changed":
    "Operationen har bytt resurs eller flyttats sedan förslaget visades — inget ändrades. Ladda om sidan för att se det nya läget.",
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
  "einvoice-other-environment": serverMessage("Raden hör till den andra miljön — välj den miljön under System → E-faktura för att hantera den."),
  "einvoice-key-environment-mismatch": serverMessage("Nyckeln hör inte till vald miljö — välj samma miljö som nyckeln."),
  "einvoice-document-invalid": "E-fakturan klarade inte Navs egen kontroll och skickades inte",
  "einvoice-provider-rejected": "Mottagande tjänst (B2Brouter) avvisade e-fakturan",
  "einvoice-provider-unauthorized": "B2Brouter nekade åtkomst — kontrollera API-nyckeln och miljön under System → E-faktura.",
  "einvoice-provider-unavailable": "B2Brouter svarar inte just nu — försök igen om en stund.",
  "einvoice-reception-registered-elsewhere": serverMessage(
    "Organisationsnumret tar redan emot e-fakturor hos en annan leverantör. Ange migreringskoden därifrån."
  ),
  "einvoice-receive-busy": "En hämtning pågår redan — försök igen om en stund.",
  "invoice-scan-einvoice-no-ai": "En e-faktura är redan tolkad ur XML-filen och kan inte tolkas med AI.",
  "invoice-scan-einvoice-original-not-found": "E-fakturans originalfil finns inte längre.",
  "einvoice-transmission-not-found": "Sändningen finns inte — ladda om sidan.",
  "einvoice-webhook-public-url": "Ange Navs adress med https under System → Inställningar innan statusbesked kan slås på.",
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
        ? formatStockholmDateTime(body.importedAt)
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
  "bank-statement-entry-ignored": "Posten är ignorerad och kan varken matchas eller bokföras — ångra ignoreringen först, eller ladda om sidan.",
  "bank-statement-entry-matched": "En matchad post kan inte ignoreras — ångra matchningen först, eller ladda om sidan.",
  "bank-statement-entries-mixed-accounts": "Posterna hör till olika bankkonton — ignorera ett bankkonto i taget.",
  "bank-reconciliation-future-date": (err) => {
    const today = (err.body as { today?: unknown } | undefined)?.today;
    return typeof today === "string" ? `Avstämd t.o.m. kan inte ligga i framtiden — välj senast ${today}.` : "Avstämd t.o.m. kan inte ligga i framtiden.";
  },
  // Dubbletter och "används redan" (granskningen 2026-11-11). API:ts felkropp
  // bär bara koden och den engelska texten, så numret/namnet nämns inte här.
  "duplicate-article-number": "Artikelnumret används redan av en annan artikel.",
  "duplicate-customer-number": "Kundnumret används redan av en annan kund.",
  "duplicate-supplier-number": "Leverantörsnumret används redan av en annan leverantör.",
  "duplicate-supplier-invoice-number": "Leverantören har redan en faktura med det fakturanumret.",
  "duplicate-email": "E-postadressen används redan av en annan användare.",
  "last-admin": "Den sista aktiva administratören kan inte degraderas, stängas av eller tas bort.",
  "duplicate-work-center-code": "Resurskoden används redan av en annan resurs.",
  "duplicate-sequence-no": "Artikelns beredning har redan en operation med det operationsnumret.",
  "duplicate-price-list": "Det finns redan en prislista med den koden eller det namnet.",
  "duplicate-customer-price": "Kunden har redan ett pris för den artikeln eller varugruppen från den kvantiteten.",
  "duplicate-article-supplier": "Leverantören finns redan på artikelns leverantörslista.",
  "duplicate-article-group": "Det finns redan en artikelgrupp med den koden eller det namnet.",
  "duplicate-article-unit": "Artikeln har redan den alternativa enheten.",
  "duplicate-company-carrier": "Fraktbolaget finns redan i företagets lista.",
  "duplicate-fiscal-year-label": "Det finns redan ett räkenskapsår med den beteckningen.",
  "duplicate-holiday-date": "Det finns redan en röd dag på det datumet.",
  "duplicate-production-group-code": "Produktionsgruppens kod används redan.",
  "duplicate-register-entry": "Det finns redan en post med den koden eller det namnet.",
  "duplicate-schedule-code": "Det finns redan ett schema med den koden.",
  // Scheman: the plain InvalidScheduleError carries an English message; the balancing variant a Swedish one.
  "invalid-schedule": "Schemat går inte ihop — kontrollera klockslagen (sluttiden måste vara efter starten och rasterna ligga inom dagen utan att överlappa).",
  "schedule-balancing-invalid": serverMessage("Veckoschemat med utjämning går inte ihop."),
  "employee-not-found": "Den anställde finns inte längre — ladda om sidan.",
  "day-schedule-not-found": "Dagsschemat finns inte längre — ladda om sidan.",
  "week-schedule-not-found": "Veckoschemat finns inte längre — ladda om sidan.",
  "holiday-not-found": "Helgdagen finns inte längre — ladda om sidan.",
  "schedule-override-not-found": "Avvikelsen finns inte längre — ladda om sidan.",
  "duplicate-verification-series": "Det finns redan en verifikationsserie med den koden.",
  "base-unit-conflict": "Standardenheten kan inte läggas till som alternativ enhet.",
  "article-unit-in-use": "Enheten är artikelns inköps- eller försäljningsenhet och kan inte tas bort.",
  "series-code-locked": "Serien har verifikat och koden kan inte längre ändras.",
  "period-already-locked": "Perioden är redan låst.",
  // Leverantörsreskontra / fakturor
  "supplier-payment-exceeds-open-amount":
    "Betalningen är större än fakturans öppna belopp (utöver betalningstoleransen).",
  "supplier-invoice-has-payments": "Fakturan har registrerade betalningar — ångra dem först.",
  "supplier-inactive": "Leverantören är inaktiv.",
  "payment-already-cancelled": "Betalningen är redan ångrad — ladda om sidan.",
  "not-creditable": "Bara en utfärdad eller betald faktura kan krediteras, och inte en kreditfaktura.",
  "row-has-manufacturing-orders": "Raden har kopplade tillverkningsorder och kan inte tas bort.",
  "post-calculation-locked": "En efterkalkyl kan inte raderas.",
  // Terminalen / närvaro
  "already-stamped-in": "Medarbetaren är redan instämplad på operationen.",
  "inactive-employee": "Medarbetaren är inaktiv och kan inte stämpla in.",
  "attendance-session-already-stopped": "Närvaron är redan avslutad — ladda om sidan.",
  "stamp-session-not-found": "Stämplingen finns inte längre — ladda om listan.",
  "inactive-absence-type": "Frånvarotypen är inaktiv — välj en annan.",
  // generic (thrown by the zod/body-parsing layer, not a named domain error)
  "validation-failed": "Ogiltiga uppgifter — kontrollera fälten.",
  "invalid-request-body": "Ogiltig förfrågan.",
  "internal-server-error": "Ett oväntat fel inträffade.",
  "work-in-progress-account-conflict":
    "Kontot för produkter i arbete eller dess förändringskonto krockar med lagrets konton eller med varandra — välj olika konton under Ekonomi → Konteringsregler.",
  "bookkeeping-record-locked": "Bokförd räkenskapsinformation kan inte ändras eller raderas — rätta med en omföring.",
  "number-out-of-range": "Ett tal är för stort för sitt fält — kontrollera antal, priser och tider.",

  // Not-found and state codes from the sales, invoice and payment services.
  "customer-not-found": "Kunden finns inte längre — ladda om sidan.",
  "contact-not-found": "Kontaktpersonen finns inte längre — ladda om sidan.",
  "delivery-address-not-found": "Leveransadressen finns inte längre — ladda om sidan.",
  "sales-order-not-found": "Kundordern finns inte längre — ladda om sidan.",
  "delivery-row-not-in-delivery": "Raden hör inte till den här följesedeln — ladda om sidan.",
  "archived-reminder-not-found": "Påminnelsens arkiverade PDF finns inte.",
  "invoice-not-found": "Fakturan finns inte längre — ladda om sidan.",
  "invoice-row-not-found": "Fakturaraden finns inte längre — ladda om sidan.",
  "sales-order-row-mismatch":
    "Orderraden som fakturaraden pekar på finns inte, tillhör en annan kund eller gäller en annan artikel — välj en annan orderrad.",
  "not-collective-customer": "Kunden är inte markerad för samlingsfaktura.",
  "price-list-not-found": "Prislistan finns inte längre — ladda om sidan.",
  "price-list-row-not-found": "Prislistraden finns inte längre — ladda om sidan.",
  "price-not-found": "Det finns inget pris för artikeln.",
  "customer-price-not-found": "Kundpriset finns inte längre — ladda om sidan.",
  "sales-order-rows-locked": "Rader kan inte läggas till på en order med den här statusen.",
  "payment-not-found": "Betalningen finns inte längre — ladda om sidan.",
  "payment-row-mismatch":
    "Betalningens rader stämmer inte — varje faktura får förekomma en gång, beloppen får inte vara noll och raderna ska summera till betalningens belopp.",
  "freight-row-delivered": serverMessage("Fraktraden är redan levererad och kan inte ändras."),
  "invalid-freight-product": serverMessage("Fraktprodukten finns inte."),
  "shipment-not-billable": serverMessage("Försändelsen avbokas eller är avbokad och kan inte faktureras."),
  // Internal race and guard markers from the sales and purchase repositories (normally translated by the service before they reach the client).
  "issue-race": "Fakturan ändrades samtidigt av någon annan — ladda om sidan och försök igen.",
  "commit-over-invoicing": "Fakturan skulle fakturera mer än det levererade antalet på en orderrad.",
  "commit-over-crediting": "Krediten skulle kreditera mer än det fakturerade antalet på en orderrad.",
  "commit-credit-exceeds-invoice": "Kreditfakturorna skulle tillsammans överstiga den ursprungliga fakturan.",
  "reminder-guard": "Påminnelsen kan inte sparas — fakturan har ändrats sedan den skickades. Ladda om sidan.",
  "payment-guard": "Betalningen kan inte sparas — fakturan har ändrats. Ladda om sidan och försök igen.",
  "cancel-guard": "Betalningen kan inte avbokas — den är redan avbokad eller finns inte längre.",
  "batch-order-not-found": "Kundordern finns inte längre — ladda om sidan.",
  "batch-invalid-status": "Kundordern kan inte levereras med den här statusen.",
  "batch-row-not-found": "Orderraden finns inte längre — ladda om sidan.",
  "batch-over-delivery": "Det går inte att leverera mer än det som är kvar på orderraden.",
  "transition-race": "Fakturan ändrades samtidigt av någon annan — ladda om sidan och försök igen.",
  "has-payments": "Fakturan har betalningar och kan inte ändras.",
  "exchange-rate-missing": "Växelkurs saknas — ange kursen och försök igen.",
  "in-payment-batch": "Fakturan ligger redan i en betalfil.",
  "supplier-payment-guard":
    "Betalningen kan inte sparas — leverantörsfakturan har ändrats. Ladda om sidan och försök igen.",
  "purchase-receipt-undone": serverMessage("Inleveransen ångrades innan operationen hann rapporteras."),
  // Not-found codes from the purchase, supplier invoice and mail services.
  "inquiry-row-price-not-applicable": serverMessage("Priset kan inte föras över från den här raden."),
  "purchase-dispatch-row-not-in-dispatch": "Raden hör inte till den här avsändningen — ladda om sidan.",
  "supplier-payment-not-found": "Betalningen finns inte längre — ladda om sidan.",
  "supplier-invoice-row-not-found": "Fakturaraden finns inte längre — ladda om sidan.",
  "supplier-invoice-file-not-found": "Underlaget finns inte längre — ladda om sidan.",
  "invalid-supplier-invoice-file-type": serverMessage("Filtypen stöds inte — ladda upp PDF, JPEG eller PNG."),
  "supplier-invoice-file-locked": serverMessage("Underlaget kan bara tas bort medan fakturan är ett utkast."),
  "email-log-entry-not-found": "Meddelandet finns inte längre i e-postloggen — ladda om sidan.",
  // Manufacturing, costing and planning.
  "manufacturing-order-not-found": "Tillverkningsordern finns inte längre — ladda om sidan.",
  "reserved-plan-mismatch":
    "Tillverkningsordens operationer stämmer inte längre med reservationens plan — planera om.",
  "cost-calculation-not-found": "Kalkylen finns inte längre — ladda om sidan.",
  "invalid-calculation-quantity": "Kalkylen saknar ett användbart antal.",
  "trial-sales-price-not-allowed":
    "Kalkylen använder prövade påslag — du behöver behörigheten Artiklar för att föra över försäljningspriset.",
  "routing-operation-not-found": "Operationen finns inte längre — ladda om sidan.",
  "production-group-not-found": "Produktionsgruppen finns inte längre — ladda om sidan.",
  "mo-material-consumption-not-found": "Materialuttaget finns inte längre — ladda om sidan.",
  "linked-row-not-found": "Orderraden finns inte längre — ladda om sidan.",
  "linked-row-article-mismatch": "Artikeln stämmer inte med den länkade orderraden.",
  "linked-row-not-manufactured": "Den länkade orderradens artikel är inte en tillverkad artikel.",
  "linked-order-status":
    "Det går inte att skapa en kopplad tillverkningsorder för en order med den här statusen.",
  "configured-row-already-covered":
    serverMessage("Raden har redan tillverkningsordrar för hela antalet — uppdatera behovsberäkningen."),
  "nothing-left-to-manufacture": "Det finns inget kvar att tillverka för orderraden.",
  "purchase-order-not-editable": "Inköpsordern kan inte ändras med den här statusen.",
  "routing-operation-mismatch": "Operationen hör inte till artikeln.",
  "bom-component-not-found": "Strukturraden finns inte längre — ladda om sidan.",
  // Import files (csv.ts, import.service.ts).
  "import-file": serverMessage("Importfilen kunde inte läsas."),
  "import-register-conflict": serverMessage("Importen krockar med en befintlig post i registret."),
  "import-mapping": serverMessage("Importen innehåller fel — inget har importerats."),
  "import-validation": serverMessage("Importen innehåller fel — inget har importerats."),
  "import-conflict":
    serverMessage("En post med samma nummer skapades samtidigt av någon annan — försök igen."),
  "csv-row-limit": serverMessage("Filen är för stor — max 10 000 rader."),
  "empty-csv": serverMessage("Filen är tom eller saknar rubrikrad."),
  "unreadable-import-file":
    serverMessage("Filen kunde inte läsas som Excel-fil (.xlsx) — spara om den i Excel eller exportera som CSV."),
  "utf16-import-file": serverMessage("Filen är sparad som UTF-16 — spara om den som CSV UTF-8 eller .xlsx."),
  "xlsx-too-large": serverMessage("Excel-filen är för stor uppackad — dela upp den eller exportera som CSV."),
  "legacy-excel-file":
    serverMessage("Gamla Excel-filer (.xls) stöds inte — spara om filen som .xlsx eller CSV."),
  // Fakturaskanning: PDF, AI-tolkning and mailbox.
  "pdf-unreadable": "PDF-filen kunde inte läsas.",
  "invoice-interpreter": "AI-tolkningen misslyckades — försök igen eller registrera fakturan manuellt.",
  "invoice-mailbox": "E-postlådan kunde inte läsas — kontrollera inställningarna under Fakturainkorgen.",
  "mail-parse": "Brevet kunde inte läsas.",
  // Economy: booking guards, verification files, SIE, recurring verifications.
  "book-race": "Verifikatet ändrades samtidigt av någon annan — ladda om sidan och försök igen.",
  "too-few-rows-at-booking": "Ett verifikat måste ha minst två rader.",
  "unbalanced-at-booking": "Verifikatet balanserar inte — debet och kredit måste vara lika.",
  "inactive-account-at-booking": "Verifikatet använder ett inaktivt konto.",
  "locked-period-at-booking": "Perioden är låst — datumet kan inte bokföras.",
  "no-period-at-booking": "Det finns ingen räkenskapsperiod för datumet.",
  "closed-year-at-booking": "Räkenskapsåret är avslutat — datumet kan inte bokföras.",
  "cost-center-required-at-booking":
    "Ett konto på verifikatet kräver kostnadsställe — ange det och försök igen.",
  "payment-amount-mismatch": "Bankbeloppet stämmer inte med summan av de reglerade posterna.",
  "payment-bank-account-conflict":
    "Kontot som valts upphäver betalningens egna rader — välj ett annat konto.",
  "verification-file-not-found": "Underlaget finns inte längre — ladda om sidan.",
  "verification-row-not-found": "Verifikatraden finns inte längre — ladda om sidan.",
  "invalid-verification-file-type": serverMessage("Filtypen stöds inte — ladda upp PDF, JPEG eller PNG."),
  "verification-file-locked": serverMessage("Underlaget kan bara tas bort medan verifikatet är ett utkast."),
  "report-fiscal-year-not-found": serverMessage("Inget räkenskapsår täcker datumet."),
  "allocation-too-small": serverMessage("Beloppet är för litet för att fördelas på så många månader."),
  "sie-parse": serverMessage("SIE-filen kunde inte läsas."),
  "sie-fiscal-year-not-found": serverMessage("Räkenskapsåret hittades inte."),
  "sie-fiscal-year-mismatch": serverMessage("Filens räkenskapsår stämmer inte med det valda."),
  "sie-unbalanced": serverMessage("De ingående balanserna summerar inte till noll."),
  "sie-prior-bookkeeping": serverMessage("Det finns redan bokförda verifikat före räkenskapsårets start."),
  "sie-already-imported": serverMessage("Ingående balanser är redan importerade för räkenskapsåret."),
  "run-claimed": "Körningen pågår redan — vänta en stund och ladda om sidan.",
  // Configurator: variants and formulas.
  "rates-not-prefetched": "Växelkurser saknas — försök igen.",
  "variant-set": serverMessage("Variantvalet är ogiltigt."),
  "too-many-combinations": "Det blir för många kombinationer — begränsa valen.",
  "formula-syntax": serverMessage("Formeln har ett syntaxfel."),
  "formula-validation": serverMessage("Formeln är ogiltig."),
  "formula-evaluation": serverMessage("Formeln kunde inte beräknas."),
  "configurator-reorder-mismatch":
    serverMessage("Ordningen ska innehålla exakt de befintliga posterna, var och en en gång."),
  // Stock.
  "warehouse-not-found": "Lagret finns inte längre — ladda om sidan.",
  "inactive-stock-location": serverMessage("Lagerplatsen är inaktiv och kan inte ta emot saldo."),
  "stock-location-not-empty":
    serverMessage("Lagerplatsen har saldo kvar och kan inte inaktiveras — flytta eller nolla saldot först."),
  "insufficient-stock": serverMessage("Otillräckligt lagersaldo."),
  "stock-count-not-open":
    serverMessage("Inventeringen är redan registrerad eller avbruten och kan inte ändras."),
  "stock-count-backdate-refused": serverMessage("Inventeringen kan inte bokföras per det datumet."),
  "stock-count-already-open": serverMessage("Lagerplatsen har redan en pågående inventering."),
  "duplicate-stock-count-row": serverMessage("Artikeln finns redan i inventeringen."),
  // System, register, permissions and API clients.
  "register-entry-not-found": "Posten finns inte längre — ladda om sidan.",
  "user-not-found": "Användaren finns inte längre — ladda om sidan.",
  "permission-group-not-found": "Behörighetsgruppen finns inte längre — ladda om sidan.",
  "invalid-client-credentials": "Klient-id eller hemlighet är fel.",
  "api-client-not-found": "API-klienten finns inte längre — ladda om sidan.",
  "theme-not-found": "Temat finns inte längre — ladda om sidan.",
  "xml-parse": serverMessage("XML-filen kunde inte läsas."),
  "number-series-not-found": "Nummerserien finns inte.",
  "number-series-not-configured": "Nummerserien är inte inställd — ställ in den under System.",
  "carrier-not-found": "Transportören finns inte längre — ladda om sidan.",
  "company-carrier-not-found": "Transportören finns inte längre — ladda om sidan.",
  "alert-digest-resend": serverMessage("Sammanställningen skickas igen nästa arbetsdag."),
  // E-invoice and freight.
  "e-invoice-provider": serverMessage("E-fakturatjänsten svarade med ett fel — försök igen senare."),
  "ubl-read": serverMessage("E-fakturan kunde inte läsas."),
  "einvoice-reception-not-found": serverMessage("Mottagningen hittades inte."),
  "freight-provider": serverMessage("Fraktbokningen misslyckades — försök igen senare."),
  "shipment-not-found": serverMessage("Försändelsen hittades inte."),
  "shipment-delivery-not-found": serverMessage("Följesedeln hittades inte."),
  "shipment-file-not-found": serverMessage("Filen hittades inte."),
  "invalid-shipment-status": serverMessage("Försändelsen kan inte ändras med den här statusen."),
  "delivery-already-shipped": serverMessage("Följesedeln ligger redan i en försändelse."),
  "mixed-customers": serverMessage("Följesedlarna i en försändelse måste gå till samma kund."),
  "shipment-needs-delivery": serverMessage("En försändelse måste ha minst en följesedel."),
  "freight-not-configured": serverMessage("Frakt är inte inställd."),
  "freight-order-not-found": serverMessage("Kundordern hittades inte."),
  "freight-order-status":
    serverMessage("Frakt kan bara läggas på offert, bekräftad order eller order under tillverkning."),
  "freight-validation": serverMessage("Uppgifter saknas för transportbokningen."),
  "freight-pickup-day": serverMessage("Upphämtningsdagen är ogiltig."),
  "freight-booking-in-progress": serverMessage("Bokning pågår redan för försändelsen."),
  "freight-booking-taken-over":
    serverMessage("Bokningen tog för lång tid och försändelsen bokades om under tiden — kontrollera hos Sendify."),
  "freight-rates-expired": serverMessage("Priset har gått ut — nya priser har hämtats."),
  "freight-shipment-changed":
    serverMessage("Försändelsen ändrades under prishämtningen — hämta priser igen."),
  "freight-product-unavailable":
    serverMessage("Den sparade produkten finns inte bland de nya priserna — välj en annan."),
  "freight-price-changed": serverMessage("Priset har ändrats sedan valet sparades."),
  "freight-no-selection": serverMessage("Ingen fraktprodukt är vald — hämta priser och välj en."),
  "freight-currency": serverMessage("Bara priser i SEK kan väljas."),
  "freight-rate-not-found": serverMessage("Priset finns inte längre — hämta priser igen."),
  "freight-cancel-refused": serverMessage("Sendify avbokade inte försändelsen."),
  "freight-cancel-in-progress":
    serverMessage("Avbokning pågår redan för försändelsen — vänta en stund och ladda om."),
  "invalid-freight-article": serverMessage("Fraktartikeln finns inte."),
  // Time reporting and payroll.
  "atf-transaction-not-found": "ATF-transaktionen finns inte längre — ladda om sidan.",
  "attendance-session-not-found": "Närvaroposten finns inte längre — ladda om sidan.",
  "time-report-not-found": "Tidrapporten finns inte längre — ladda om sidan.",
  "absence-type-not-found": "Frånvarotypen finns inte längre — ladda om sidan.",
  "attendance-deviation-reason-not-found": "Avvikelseanledningen finns inte längre — ladda om sidan.",
  "ob-rule-not-found": "OB-regeln finns inte längre — ladda om sidan.",
  "absence-not-found": "Frånvaron finns inte längre — ladda om sidan.",
  "overtime-disposition-not-found": "Det finns inget övertidsval för medarbetaren den dagen.",
  "payroll-snapshot-not-found": "Det tidigare löneunderlaget finns inte längre — ladda om sidan.",
};

// Chain: mapped Swedish text for err.code -> a 401 (session gone) or a fetch
// that never reached the server in Swedish -> the API's own message -> the
// caller's fallback. Only ApiError carries a `code`; any other thrown value (a
// plain Error, a non-Error throw) falls through to its message or the fallback.
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
  if (err instanceof ApiError) {
    // The API answers 401 without a code ("Authentication required").
    if (err.status === 401) return SESSION_EXPIRED_MESSAGE;
    // An empty error body: parseOrThrow's own placeholder, never shown.
    if (/^Request failed \(\d+\)$/.test(err.message)) return fallback;
  }
  // fetch itself failed (no network, server down): the browser's own English
  // text — "Failed to fetch", "NetworkError when attempting to fetch
  // resource.", Safari's "Load failed".
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return NETWORK_ERROR_MESSAGE;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export const SESSION_EXPIRED_MESSAGE = "Sessionen har gått ut — logga in igen.";
export const NETWORK_ERROR_MESSAGE = "Ingen kontakt med servern — kontrollera anslutningen och försök igen.";

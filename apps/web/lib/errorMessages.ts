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
  "invalid-stop-time": "Sluttiden måste vara efter instämplingen och inte i framtiden.",
  "stop-time-not-allowed": "Bara arbetsledare och administratörer kan ange sluttid.",
  "duplicate-absence": "Frånvaro med samma kod finns redan på det datumet",
  "duplicate-payroll-code": "Koden eller namnet finns redan",
  "invalid-ob-window": "Sluttiden måste vara efter starttiden",
  // economy
  "overlapping-fiscal-year": "Räkenskapsåret överlappar ett befintligt räkenskapsår",
  "fiscal-year-before-closed-year": "Räkenskapsåret ligger före ett stängt räkenskapsår — ett år kan inte läggas upp före ett stängt år",
  "vat-period-not-covered": "Intervallet täcker inte hela redovisningsperioder.",
  "vat-period-already-settled": "Perioden är redan deklarerad — omför momsomföringen först.",
  "vat-accounts-not-distinct": "Två momsroller pekar på samma konto i standardkontona.",
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
  "duplicate-posting-rule": "Det finns redan en regel för den artikelgruppen och momssatsen",
  "posting-rule-no-accounts": "Minst ett konto (intäkt eller kostnad) måste anges",
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
  "year-end-step-order": "Gör stegen Lagerförändring, Avskrivningar och Periodiseringar före resultatöverföringen",
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
  "bank-entry-amount-differs": "Bankens belopp skiljer sig från betalfilens. Kontrollera i internetbanken och hantera posten manuellt.",
  // Per-row booking results (bank files / Bekräfta utförd) carry the code of
  // whatever refused that row; these are not in ERROR_CODES because no route
  // maps them to a standalone response in this feature.
  "supplier-invoice-not-open": "Fakturan är inte längre en öppen, attesterad post — kontrollera Öppna poster.",
  "invoice-not-open": "Fakturan är inte längre en öppen post — den kan ha betalats på annat sätt sedan förhandsgranskningen.",
  "invalid-status-transition": "Åtgärden går inte att göra i det här läget — ladda om sidan.",
  "bank-return-before-payment":
    "Returen är bokförd av banken före utbetalningens datum. Kontrollera betalningsdatumet och makulera utbetalningen manuellt under Betalningar.",
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
  "row-configuration-locked": serverMessage("Konfigurationen kan inte ändras — raden har gått vidare."),
  "row-configuration-changed":
    "Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration.",
  "row-variant-exists": serverMessage("Varianten ligger redan som rad på ordern."),
  "work-center-not-found": "Resursen finns inte.",
  // Ångra rapportering / Makulera order (TO)
  "mo-report-not-found": "Rapporteringen finns inte — ladda om sidan.",
  "mo-report-already-undone": "Rapporteringen är redan ångrad — ladda om sidan.",
  "mo-report-from-purchase-receipt": "Rapporteringen kommer från en inleverans på inköpsordern och kan inte ångras här.",
  "mo-report-stock-missing": serverMessage("De inlevererade varorna finns inte kvar på lagerplatsen."),
  // Ångra inleverans (IO card). The stock message names both quantities.
  "purchase-receipt-not-found": "Inleveransen finns inte — ladda om sidan.",
  "purchase-receipt-already-undone": "Inleveransen är redan ångrad — ladda om sidan.",
  "purchase-receipt-stock-missing": serverMessage("De inlevererade varorna finns inte kvar på lagerplatsen."),
  "purchase-receipt-manufacturing-order-locked":
    "Tillverkningsordern som legoraden hör till är inte längre öppen — inleveransen kan inte ångras.",
  "mo-report-time-locked": "Stämplingens tid ligger i en låst löneperiod — rapporteringen kan inte ångras.",
  "manufacturing-order-has-reports": "Ordern har rapporteringar — ångra dem först under Rapporteringar.",
  "manufacturing-order-stamped-in": "Någon är instämplad på ordern — stämpla ut först.",
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

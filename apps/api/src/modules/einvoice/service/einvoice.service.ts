import { createHash } from "node:crypto";
import {
  localized,
  normalizeVatNumber,
  toUnitPrice,
  toUnitQuantity,
  type EinvoiceAutoSendOutcome,
  type EinvoiceBlockedReason,
  type EinvoiceStatus,
  type PeppolLookupInput,
} from "@navet/shared";
import { configurationLines } from "../../configurator/service/configuration-lines.js";
import { InvoiceNotFoundError } from "../../sales/service/invoice.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { stockholmDateOf } from "../../system/service/delivery-days.js";
import { LIVE_TRANSMISSION_CONSTRAINT, type EinvoiceRepository, type TransmissionRow } from "../repository/einvoice.repository.js";
import { EInvoiceProviderError, type LookupResult } from "./einvoice-provider.js";
import type { CompanyInfoReader, CompanyInfoRow, EinvoiceSettingsService } from "./einvoice-settings.service.js";
import { DERIVED_PEPPOL_COUNTRIES, derivedPeppolId, normalizedOrgNumber, orgNumberDigits, orgNumberScheme } from "./peppol-schemes.js";
import { einvoiceStatusLabel, isLiveStatus, mapProviderState, providerErrorText } from "./einvoice-status.js";
import {
  BLOCKED_MESSAGES,
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceNotConfiguredError,
  EinvoiceProviderUnavailableError,
  fromProviderError,
} from "./einvoice.errors.js";
import { checkUblInput } from "./ubl/ubl-check.js";
import { isOutOfScopeVatCode, isSupportedVatCode, type UblLanguage } from "./ubl/vat-categories.js";
import { buildUblDocument } from "./ubl/ubl-invoice-builder.js";
import type { PeppolIdentifier, UblInvoiceInput, UblLine, UblPaymentAccount, UblPostalAddress } from "./ubl/ubl-types.js";

// E-faktura via Peppol — sändning, läsning för fakturakortet, Kontrollera
// mottagare (spec §3.4, §3.6) and, since etapp 2a (spec 2026-11-05-e-faktura-
// utland-automatik), foreign customers, the invoice's own currency and the
// automatic send after Utfärda. No DB transaction is ever held over the
// access point call: the `sending` row is inserted first (the partial unique
// index, per invoice AND environment, is the double-send guard), then the
// provider is called — the access point's id is written to the row as soon
// as the import is through, before the send — then the row is updated with
// the outcome.

// --- Narrow readers into sales/system (same pattern as RegisterReferenceReader) ---

export interface InvoiceReadRow {
  id: string;
  description: string;
  articleNumber: string | null;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  unitFactor: string | null;
  unitCode: string | null;
  vatRate: string;
  lineAmount: string;
  vatAmount: string;
  salesOrderRowId: string | null;
  configuration: unknown;
  // Momskoder: the row's code and the company's invoice texts for it
  // (BT-120 on an AE/K/G/O subtotal, English on an English invoice).
  // Optional only for older fixtures — the invoice service always returns it.
  vatCode?: { code: string; invoiceText: string | null; invoiceTextEn?: string | null } | null;
  // The article's English name (an English invoice's Item/Name) and the
  // row's last delivery day (BT-72 for an intra-community supply).
  articleNameEn?: string | null;
  deliveryDate?: string | null;
}

export interface InvoiceReadModel {
  id: string;
  invoiceNumber: string | null;
  type: "invoice" | "credit";
  status: "draft" | "issued" | "paid" | "cancelled";
  currency: string;
  // The stamped document language and the SEK figures at the invoice's rate
  // (null without a rate) — BT-111 is sekAmounts.vatAmount. Optional only
  // for older fixtures.
  language?: string | null;
  sekAmounts?: { vatAmount: number } | null;
  customerId: string;
  creditedInvoiceId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  ocrNumber: string | null;
  customerName: string | null;
  customerNumber: string | null;
  invoiceAddress: string | null;
  invoicePostalCode: string | null;
  invoiceCity: string | null;
  invoiceCountry: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  paymentTermName: string | null;
  note: string | null;
  rows: InvoiceReadRow[];
}

export interface CustomerReadModel {
  id: string;
  customerNumber: string;
  name: string;
  country: string;
  invoiceCountry: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  privatePerson: boolean;
  invoiceDelivery: "email" | "peppol";
  peppolId: string | null;
}

export interface InvoiceReader {
  getInvoice(id: string): Promise<InvoiceReadModel | null>;
  // The archived PDF (rendered and archived now if missing — first writer wins).
  archivedInvoicePdf(id: string): Promise<{ filename: string; content: Buffer }>;
  findCustomerById(id: string): Promise<CustomerReadModel | null>;
}

// --- Pure helpers (exported for the tests) ---

export interface Recipient {
  peppolId: string | null;
  source: "customer" | "org-number" | null;
}

// The customer's Peppol-id, else one derived from the organisation number
// where the country's register is the Peppol address (SE 0007, NO 0192,
// DK 0184, BE 0208 — peppol-schemes.ts); anywhere else the id must be typed.
// `override` (Kontrollera before Spara): undefined = the saved id, null = the
// field was emptied, so the derived id is what will apply — not the saved one.
export function resolveRecipient(customer: Pick<CustomerReadModel, "peppolId" | "orgNumber" | "country">, override?: string | null): Recipient {
  const own = (override === undefined ? customer.peppolId : override)?.trim();
  if (own) return { peppolId: own, source: "customer" };
  const derived = derivedPeppolId(customer.country, customer.orgNumber);
  if (derived) return { peppolId: derived, source: "org-number" };
  return { peppolId: null, source: null };
}

export function splitPeppolId(peppolId: string): PeppolIdentifier {
  const i = peppolId.indexOf(":");
  return { scheme: peppolId.slice(0, i), value: peppolId.slice(i + 1) };
}

// Why the invoice cannot be sent right now, in the spec's order; null = it
// can. Since etapp 2a a foreign customer and another currency are sendable.
export function blockedReasonFor(
  invoice: Pick<InvoiceReadModel, "status"> & { rows?: Pick<InvoiceReadRow, "vatCode">[] },
  customer: Pick<CustomerReadModel, "privatePerson" | "country" | "peppolId" | "orgNumber">,
  company: CompanyInfoRow | null
): EinvoiceBlockedReason | null {
  if (invoice.status !== "issued" && invoice.status !== "paid") return "invoice-not-issued";
  if (customer.privatePerson) return "private-person";
  // Momskoder: every catalog code but UTM has a Peppol category
  // (vat-categories.ts); EXT (⇒ O) must stand alone (BR-O-11..14).
  const codes = (invoice.rows ?? []).flatMap((row) => (row.vatCode != null ? [row.vatCode.code] : []));
  if (codes.some((code) => !isSupportedVatCode(code))) return "vat-code-unsupported";
  if (codes.some(isOutOfScopeVatCode) && codes.some((code) => !isOutOfScopeVatCode(code))) return "vat-code-mixed";
  if (!company || orgNumberDigits(company.orgNumber) === null || !company.vatNumber?.trim()) return "missing-company-data";
  if (resolveRecipient(customer).peppolId === null) return "missing-recipient-id";
  return null;
}

// The failed row's text: the adapter's message plus any field errors it
// does not already contain (B2Brouter's import refusal carries the same text
// in both, which printed it twice).
export function withFieldErrors(message: string, fieldErrors: string[]): string {
  const extra = fieldErrors.filter((e) => !message.includes(e));
  return extra.length > 0 ? `${message} — ${extra.join("; ")}` : message;
}

function addressOf(address: string | null, postalCode: string | null, city: string | null, country: string): UblPostalAddress {
  const lines = (address ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return { addressLines: lines, postalCode: postalCode?.trim() || null, city: city?.trim() || null, country };
}

// Bankgiro first for a Swedish customer paying in SEK; an IBAN first for a
// foreign customer or another currency (a bankgiro cannot be paid from
// abroad), then whatever exists.
function paymentAccountOf(company: CompanyInfoRow, preferIban = false): UblPaymentAccount | null {
  const iban = company.iban?.replace(/\s/g, "");
  if (preferIban && iban) return { kind: "iban", iban, bic: company.bic?.replace(/\s/g, "") || null };
  const bankgiro = company.bankgiro?.replace(/\s/g, "");
  if (bankgiro) return { kind: "bankgiro", account: bankgiro };
  const plusgiro = company.plusgiro?.replace(/\s/g, "");
  if (plusgiro) return { kind: "plusgiro", account: plusgiro };
  if (iban) return { kind: "iban", iban, bic: company.bic?.replace(/\s/g, "") || null };
  return null;
}

// "Grupp: Värde" lines (the same pure function as the PDF, never with
// prices) split into Name/Value for Item/AdditionalItemProperty.
export function configurationProperties(configuration: unknown): { name: string; value: string }[] {
  const cfg = configuration as { selection?: unknown } | null;
  if (!cfg || !Array.isArray(cfg.selection)) return [];
  return configurationLines(cfg.selection as Parameters<typeof configurationLines>[0]).map((line) => {
    const i = line.indexOf(": ");
    return i === -1 ? { name: line, value: "" } : { name: line.slice(0, i), value: line.slice(i + 2) };
  });
}

export interface OrderLink {
  rowId: string;
  orderNumber: string | null;
  customerOrderNumber: string | null;
  customerReference: string | null;
  orderLineNo: number | null;
  // The order's delivery address country — BT-80 for an intra-community
  // supply. Optional only for older fixtures.
  deliveryCountry?: string | null;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: "Faktura",
  credit_note: "Kreditfaktura",
  application_response: "Fakturasvar",
  order: "Order",
  order_response: "Ordersvar",
  despatch_advice: "Leveransavisering",
};

export interface TransmissionView {
  id: string;
  status: EinvoiceStatus;
  statusLabel: string;
  environment: "sandbox" | "production";
  recipientId: string;
  providerInvoiceId: string | null;
  providerState: string | null;
  errorMessage: string | null;
  startedAt: Date;
  sentAt: Date | null;
  statusUpdatedAt: Date | null;
  lastPolledAt: Date | null;
  createdByName: string | null;
}

export function transmissionView(row: TransmissionRow): TransmissionView {
  return {
    id: row.id,
    status: row.status,
    statusLabel: einvoiceStatusLabel(row.status),
    environment: row.environment === "production" ? "production" : "sandbox",
    recipientId: row.recipientId,
    providerInvoiceId: row.providerInvoiceId,
    providerState: row.providerState,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    sentAt: row.sentAt,
    statusUpdatedAt: row.statusUpdatedAt,
    lastPolledAt: row.lastPolledAt,
    createdByName: row.createdByName,
  };
}

// The invoice read model → the builder's plain input. Pure apart from the
// already-loaded data; exported so the tests can pin the mapping.
export function buildUblInput(args: {
  invoice: InvoiceReadModel;
  customer: CustomerReadModel;
  company: CompanyInfoRow;
  recipientId: string;
  orderLinks: OrderLink[];
  creditedInvoiceNumber: string | null;
  attachment: { filename: string; content: Buffer } | null;
  today: string;
}): UblInvoiceInput {
  const { invoice, customer, company } = args;
  const isCredit = invoice.type === "credit";
  const language: UblLanguage = invoice.language === "en" ? "en" : "sv";
  const currency = invoice.currency.trim().toUpperCase();
  const links = new Map(args.orderLinks.map((l) => [l.rowId, l]));
  // BT-13/BT-10 from the FIRST linked order in the DOCUMENT's own line
  // order (invoice.rows, the same order the lines are numbered in — so the
  // header reference always matches line 1's order, however the rows'
  // created_at tie); neither ⇒ the customer number as BT-10 (Peppol
  // requires one of them).
  const first = invoice.rows.map((r) => links.get(r.id)).find((l): l is OrderLink => l !== undefined && l.orderNumber !== null);
  const orderReference = first?.customerOrderNumber?.trim() || null;
  let buyerReference = first?.customerReference?.trim() || null;
  if (!orderReference && !buyerReference) buyerReference = invoice.customerNumber ?? customer.customerNumber;

  const lines: UblLine[] = invoice.rows.map((r, i) => {
    const link = links.get(r.id);
    return {
      lineNumber: i + 1,
      // An English invoice names the article in English when it has a name
      // for it (as the PDF does); otherwise the row's stored text.
      description: language === "en" && r.articleNameEn?.trim() ? r.articleNameEn.trim() : r.description,
      articleNumber: r.articleNumber,
      quantity: toUnitQuantity(Number(r.quantity), r.unitFactor),
      unitCode: r.unitCode,
      unitPrice: toUnitPrice(Number(r.unitPrice), r.unitFactor),
      discountPercent: Number(r.discountPercent),
      lineAmount: Number(r.lineAmount),
      vatAmount: Number(r.vatAmount),
      vatRate: Number(r.vatRate),
      vatCode: r.vatCode?.code ?? null,
      vatExemptionText: r.vatCode?.invoiceText != null ? localized(r.vatCode.invoiceText, r.vatCode.invoiceTextEn, language) : null,
      orderLineReference: link?.orderNumber ? `${link.orderNumber}:${link.orderLineNo ?? 1}` : null,
      properties: configurationProperties(r.configuration),
    };
  });

  // The buyer's country is the invoice's address snapshot; its registration
  // number is written in the scheme of the country it is registered in.
  const buyerCountry = (invoice.invoiceCountry ?? customer.invoiceCountry ?? customer.country).trim().toUpperCase() || "SE";
  const legalCountry = customer.country;
  const rawOrgNumber = invoice.orgNumber ?? customer.orgNumber;
  const orgScheme = orgNumberScheme(legalCountry);
  const orgNumber = orgScheme ? normalizedOrgNumber(legalCountry, rawOrgNumber) : rawOrgNumber?.trim() || null;
  const foreign = buyerCountry !== "SE" || currency !== "SEK";

  // BT-111 (ML 17 kap. 29 §): VAT in SEK when the invoice is in another
  // currency and carries VAT — the restmetod's toSek(Σ moms) the F
  // verification booked, the same figure as the PDF's "Moms i SEK". A
  // missing figure is left to ubl-check to refuse.
  const vatCents = lines.reduce((sum, l) => sum + Math.round(l.vatAmount * 100), 0);
  const taxCurrency =
    currency !== "SEK" && vatCents !== 0 && invoice.sekAmounts ? { currency: "SEK", vatAmount: invoice.sekAmounts.vatAmount } : null;

  // BT-72 + BT-80 for an intra-community supply (BR-IC-11/12): the last
  // delivery day among the rows (else the invoice date) and the country the
  // first linked order was delivered to (else the buyer's).
  const issueDate = invoice.invoiceDate ?? args.today;
  const deliveryDays = invoice.rows.map((r) => r.deliveryDate).filter((d): d is string => !!d).sort();
  const deliveryCountry = invoice.rows.map((r) => links.get(r.id)?.deliveryCountry).find((c): c is string => !!c?.trim());
  const delivery = lines.some((l) => l.vatCode === "EUV")
    ? { date: deliveryDays[deliveryDays.length - 1] ?? issueDate, country: (deliveryCountry ?? buyerCountry).trim().toUpperCase() }
    : null;

  return {
    type: isCredit ? "credit" : "invoice",
    invoiceNumber: invoice.invoiceNumber ?? "",
    issueDate,
    dueDate: isCredit ? null : invoice.dueDate,
    currency,
    language,
    taxCurrency,
    delivery,
    buyerReference,
    orderReference,
    creditedInvoiceNumber: isCredit ? args.creditedInvoiceNumber : null,
    note: invoice.note?.trim() || null,
    paymentTermsNote: invoice.paymentTermName?.trim() || null,
    seller: {
      name: company.name.trim(),
      orgNumber: orgNumberDigits(company.orgNumber) ?? "",
      vatNumber: (company.vatNumber ?? "").replace(/\s/g, "").toUpperCase(),
      address: addressOf(company.address, company.postalCode, company.city, "SE"),
      email: company.email?.trim() || null,
      phone: company.phone?.trim() || null,
      fSkatt: company.fSkatt,
    },
    buyer: {
      endpoint: splitPeppolId(args.recipientId),
      name: invoice.customerName ?? customer.name,
      address: addressOf(invoice.invoiceAddress, invoice.invoicePostalCode, invoice.invoiceCity, buyerCountry),
      orgNumber,
      orgNumberScheme: orgNumber ? orgScheme : null,
      // BT-48 as compared and reported everywhere (normalizeVatNumber):
      // upper case, letters and digits only — "SE 559000-1235 01" would
      // otherwise reach the access point with its hyphen.
      vatNumber: normalizeVatNumber(invoice.vatNumber ?? customer.vatNumber) || null,
      customerNumber: invoice.customerNumber ?? customer.customerNumber,
    },
    payment: {
      account: isCredit ? null : paymentAccountOf(company, foreign),
      ocrNumber: isCredit ? null : invoice.ocrNumber,
    },
    lines,
    attachment: args.attachment
      ? {
          filename: args.attachment.filename,
          description: ATTACHMENT_DESCRIPTIONS[language][isCredit ? "credit" : "invoice"],
          mimeCode: "application/pdf",
          content: args.attachment.content,
        }
      : null,
  };
}

const ATTACHMENT_DESCRIPTIONS: Record<UblLanguage, { invoice: string; credit: string }> = {
  sv: { invoice: "Faktura (PDF)", credit: "Kreditfaktura (PDF)" },
  en: { invoice: "Invoice (PDF)", credit: "Credit note (PDF)" },
};

// The automatic send's one-line result, in Swedish (the issue answer and the
// samlingsfakturering result show it as-is).
function autoSendMessage(t: TransmissionView): string {
  if (t.status === "failed" || t.status === "rejected") return `E-fakturan kunde inte skickas: ${t.errorMessage ?? t.statusLabel}`;
  const sandbox = t.environment === "sandbox" ? " (sandbox)" : "";
  return `E-fakturan skickades till Peppol-id ${t.recipientId}${sandbox}`;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// A send that failed outside the access point's answer — what the card and
// the alert say (the real error is in the server log).
export const UNEXPECTED_SEND_MESSAGE = "Sändningen avbröts av ett oväntat fel — försök igen";
// Samlingsfaktureringen after B2Brouter failed to answer earlier in the run.
export const PROVIDER_DOWN_MESSAGE = "E-fakturan skickades inte: B2Brouter svarade inte tidigare i körningen — skicka den från fakturakortet";

export function createEinvoiceService(deps: {
  repo: EinvoiceRepository;
  settings: EinvoiceSettingsService;
  invoices: InvoiceReader;
  company: CompanyInfoReader;
  audit: AuditWriter;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, settings, invoices, company, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));
  // The errors send() has already written an event for (einvoice_failed, or
  // the document left Nav): sendAfterIssue logs einvoice_not_sent for every
  // other failure, never for these.
  const accounted = new WeakSet<Error>();

  async function loadInvoice(id: string) {
    const invoice = await invoices.getInvoice(id);
    if (!invoice) throw new InvoiceNotFoundError(id);
    const customer = await invoices.findCustomerById(invoice.customerId);
    if (!customer) throw new CustomerNotFoundError(invoice.customerId);
    return { invoice, customer };
  }

  // Everything the send needs, checked in the spec's order — shared by send()
  // and Validera so both refuse the same documents.
  async function prepareDocument(id: string) {
    const { invoice, customer } = await loadInvoice(id);
    const companyRow = await company.getCompanyInfo();
    const blocked = blockedReasonFor(invoice, customer, companyRow);
    if (blocked) throw new EinvoiceNotAllowedError(blocked);
    const recipient = resolveRecipient(customer);
    const [pdf, orderLinks, credited] = await Promise.all([
      invoices.archivedInvoicePdf(invoice.id),
      repo.invoiceRowOrders(invoice.id),
      invoice.creditedInvoiceId ? invoices.getInvoice(invoice.creditedInvoiceId) : Promise.resolve(null),
    ]);
    const input = buildUblInput({
      invoice,
      customer,
      company: companyRow!,
      recipientId: recipient.peppolId!,
      orderLinks,
      creditedInvoiceNumber: credited?.invoiceNumber ?? null,
      attachment: pdf,
      // The issue date when the invoice has none: the Stockholm day, not UTC's.
      today: stockholmDateOf(now()),
    });
    const problems = checkUblInput(input);
    if (problems.length > 0) throw new EinvoiceDocumentInvalidError(problems);
    const xml = Buffer.from(buildUblDocument(input), "utf8");
    return { invoice, customer, recipient, input, xml };
  }

  async function send(invoiceId: string, userId: string | null, opts: { auto?: boolean } = {}): Promise<TransmissionView> {
    const s = await settings.read();
    if (!s.enabled) throw new EinvoiceNotConfiguredError("disabled");
    if (!s.apiKey) throw new EinvoiceNotConfiguredError("no-key");
    if (!s.accountId) throw new EinvoiceNotConfiguredError("no-account");
    const provider = await settings.provider({ requireEnabled: true, requireAccount: true });
    const { invoice, recipient, xml } = await prepareDocument(invoiceId);

    // The `sending` row first: the partial unique index is what makes a
    // second live transmission in this environment impossible, whoever
    // clicks.
    let transmissionId: string;
    try {
      transmissionId = await repo.insertTransmission({
        invoiceId: invoice.id,
        provider: provider.name,
        environment: s.environment,
        recipientId: recipient.peppolId!,
        document: xml,
        sha256: sha256(xml),
        createdBy: userId,
      });
    } catch (err) {
      if (isUniqueViolation(err, LIVE_TRANSMISSION_CONSTRAINT)) throw new EinvoiceAlreadySentError(invoice.invoiceNumber ?? invoice.id);
      throw err;
    }

    // The try covers the access point call ONLY. Once submit has
    // returned, the document has been sent: a database failure after that
    // must never mark the row failed (that would invite a second send) —
    // it is logged and rethrown, and the row, which already carries the
    // access point's id, is resolved by the status job from the state
    // there.
    let result;
    try {
      result = await provider.submit(
        { xml, filename: `${invoice.invoiceNumber}.xml` },
        {
          // Persisted BEFORE the send: a process that dies in between still
          // leaves a `sending` row with the id, which the status job polls.
          onImported: async (providerInvoiceId) => {
            await repo.updateTransmission(transmissionId, { status: "sending", providerInvoiceId });
          },
        }
      );
    } catch (err) {
      const at = now();
      if (err instanceof EInvoiceProviderError) {
        // Import ok, send not: the document is a draft at the access point.
        // A transient failure leaves the row `sending` with the id so the
        // status job can read what became of it; a refusal is final.
        const stillSending = err.providerInvoiceId !== null && (err.kind === "unavailable" || err.kind === "unexpected");
        await repo.updateTransmission(transmissionId, {
          status: stillSending ? "sending" : "failed",
          providerInvoiceId: err.providerInvoiceId,
          // The adapter often folds the provider's text into the message
          // already — append only the field errors it does not contain.
          errorMessage: withFieldErrors(err.message, err.fieldErrors),
          statusUpdatedAt: at,
        });
        await audit.log({
          entityType: "invoice",
          entityId: invoice.id,
          action: "einvoice_failed",
          detail: {
            transmissionId,
            kind: err.kind,
            reason: err.message,
            fieldErrors: err.fieldErrors,
            providerInvoiceId: err.providerInvoiceId,
            ...(opts.auto ? { auto: true } : {}),
          },
          userId,
        });
        const mapped = fromProviderError(err);
        accounted.add(mapped);
        throw mapped;
      }
      // Not the access point's answer (a database failure in onImported,
      // say): the card and the alert show a fixed Swedish text, never the
      // internal message, which goes to the server log (review 2026-11-10).
      log("E-invoice send failed outside the access point", { transmissionId, error: err instanceof Error ? err.message : String(err) });
      await repo.updateTransmission(transmissionId, { status: "failed", errorMessage: UNEXPECTED_SEND_MESSAGE, statusUpdatedAt: at });
      await audit.log({
        entityType: "invoice",
        entityId: invoice.id,
        action: "einvoice_failed",
        detail: { transmissionId, kind: "unexpected", reason: UNEXPECTED_SEND_MESSAGE, ...(opts.auto ? { auto: true } : {}) },
        userId,
      });
      if (err instanceof Error) accounted.add(err);
      throw err;
    }

    // The state the access point reported right after the send decides the
    // row — an immediate error/refused is final at once, never "sent".
    const at = now();
    const status = mapProviderState(result.state);
    const failedNow = status === "failed" || status === "rejected";
    const errorMessage = failedNow
      ? (providerErrorText(result.errorMessage) ?? (status === "rejected" ? "Mottagaren avvisade fakturan" : "Sändningen misslyckades"))
      : null;
    try {
      // Conditional on `sending`: the web hook or the status job may already
      // have written what came next (sent, delivered) — this answer is older
      // and must not take the row back (review 2026-11-10).
      await repo.updateTransmission(
        transmissionId,
        {
          status,
          providerInvoiceId: result.providerInvoiceId,
          providerState: result.state.slice(0, 40),
          errorMessage,
          ...(isLiveStatus(status) && status !== "sending" ? { sentAt: at } : {}),
          statusUpdatedAt: at,
        },
        "sending"
      );
      await audit.log({
        entityType: "invoice",
        entityId: invoice.id,
        action: failedNow ? "einvoice_failed" : "einvoice_sent",
        detail: {
          transmissionId,
          recipientId: recipient.peppolId,
          environment: s.environment,
          providerInvoiceId: result.providerInvoiceId,
          ...(failedNow ? { status, providerState: result.state, reason: errorMessage } : {}),
          ...(opts.auto ? { auto: true } : {}),
        },
        userId,
      });
    } catch (err) {
      log("E-invoice sent but the transmission row could not be updated", {
        transmissionId,
        providerInvoiceId: result.providerInvoiceId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Sent: never "not sent" in the event log.
      if (err instanceof Error) accounted.add(err);
      throw err;
    }
    return transmissionView((await repo.findTransmission(transmissionId))!);
  }

  return {
    // GET /invoices/:id/einvoice — the card's section.
    async getInvoiceView(id: string) {
      const { invoice, customer } = await loadInvoice(id);
      const [s, companyRow, rows] = await Promise.all([settings.read(), company.getCompanyInfo(), repo.listTransmissions(id)]);
      const blockedReason = blockedReasonFor(invoice, customer, companyRow);
      return {
        enabled: s.enabled && s.apiKey !== null,
        environment: s.environment,
        invoiceDelivery: customer.invoiceDelivery,
        recipient: resolveRecipient(customer),
        blockedReason,
        blockedMessage: blockedReason ? BLOCKED_MESSAGES[blockedReason] : null,
        transmissions: rows.map(transmissionView),
      };
    },

    async getTransmission(id: string) {
      const row = await repo.findTransmission(id);
      return row ? transmissionView(row) : null;
    },

    // GET /einvoice-transmissions/:id/document — the UBL exactly as sent.
    async getDocument(id: string) {
      const row = await repo.findTransmissionDocument(id);
      if (!row) return null;
      return { filename: `${row.invoiceNumber ?? row.invoiceId}.xml`, content: row.document };
    },

    // Skicka e-faktura (spec §3.4). `auto` marks the automatic send after
    // Utfärda in the event log.
    send,

    // Skicka e-faktura automatiskt vid Utfärda (spec 2026-11-05): called by
    // the invoice service after an issue, outside its transaction. Never
    // throws — the invoice is issued whatever happens here.
    async sendAfterIssue(invoiceId: string, userId: string | null, opts: { providerDown?: boolean } = {}): Promise<EinvoiceAutoSendOutcome | null> {
      try {
        const s = await settings.read();
        if (!s.enabled || !s.apiKey || !s.accountId || !s.autoSend) return null;
        const { invoice, customer } = await loadInvoice(invoiceId);
        if (customer.invoiceDelivery !== "peppol") return null;
        const blocked = blockedReasonFor(invoice, customer, await company.getCompanyInfo());
        if (blocked) {
          await audit.log({ entityType: "invoice", entityId: invoice.id, action: "einvoice_not_sent", detail: { reason: blocked, auto: true }, userId });
          return { status: "blocked", reason: blocked, transmissionId: null, message: `Skickades inte som e-faktura: ${BLOCKED_MESSAGES[blocked]}` };
        }
        if (opts.providerDown) {
          const message = PROVIDER_DOWN_MESSAGE;
          await audit.log({ entityType: "invoice", entityId: invoice.id, action: "einvoice_not_sent", detail: { reason: "provider-unavailable", auto: true, message }, userId });
          return { status: "error", reason: null, transmissionId: null, message, unavailable: true };
        }
        try {
          const t = await send(invoiceId, userId, { auto: true });
          return { status: t.status, reason: null, transmissionId: t.id, message: autoSendMessage(t) };
        } catch (err) {
          // send() has already written the failed row and the event for a
          // provider error; its domain errors carry Swedish messages meant
          // for the user. Anything else is logged and summarised.
          const known = err instanceof Error && err.name.startsWith("Einvoice");
          if (!known) log("Automatic e-invoice send failed", { invoiceId, error: err instanceof Error ? err.message : String(err) });
          const message = `E-fakturan kunde inte skickas: ${known ? (err as Error).message : "oväntat fel — se fakturakortet"}`;
          // Stopped before a transmission row (ubl-check, the PDF archive, a
          // key that contradicts Miljö …): the reply was the only trace, and
          // a caller that drops it (samlingsfakturering's summary, an API
          // client) left an invoice nobody knew was never sent. The event
          // says so on the card's Historik (review 2026-11-10). A failure
          // send() already logged (einvoice_failed) is not logged twice.
          if (!(err instanceof Error && accounted.has(err))) {
            await audit
              .log({
                entityType: "invoice",
                entityId: invoiceId,
                action: "einvoice_not_sent",
                detail: {
                  reason: err instanceof EinvoiceNotAllowedError ? err.reason : "error",
                  auto: true,
                  message,
                  ...(err instanceof EinvoiceDocumentInvalidError ? { problems: err.problems } : {}),
                },
                userId,
              })
              .catch(() => undefined);
          }
          return {
            status: "error",
            reason: err instanceof EinvoiceNotAllowedError ? err.reason : null,
            transmissionId: null,
            message,
            unavailable: err instanceof EinvoiceProviderUnavailableError,
          };
        }
      } catch (err) {
        log("Automatic e-invoice send could not start", { invoiceId, error: err instanceof Error ? err.message : String(err) });
        return { status: "error", reason: null, transmissionId: null, message: "E-fakturan kunde inte skickas: oväntat fel — se fakturakortet" };
      }
    },

    // Validera (settings page): the access point's own XSD + schematron
    // check of one invoice's document — never sent, nothing stored.
    async validateDocument(invoiceId: string) {
      const provider = await settings.provider({ requireEnabled: false });
      if (!provider.validate) throw new EinvoiceNotConfiguredError("no-key");
      const { xml } = await prepareDocument(invoiceId);
      try {
        return await provider.validate(xml);
      } catch (err) {
        throw err instanceof EInvoiceProviderError ? fromProviderError(err) : err;
      }
    },

    // Kontrollera mottagaren (spec §3.6): never stored.
    async lookup(customerId: string, input: PeppolLookupInput = {}) {
      const customer = await invoices.findCustomerById(customerId);
      if (!customer) throw new CustomerNotFoundError(customerId);
      const s = await settings.read();
      const provider = await settings.provider({ requireEnabled: false });
      const recipient = resolveRecipient(customer, input.peppolId);
      const base = { peppolId: recipient.peppolId, source: recipient.source, environment: s.environment };
      if (!recipient.peppolId) {
        const message = DERIVED_PEPPOL_COUNTRIES.includes(customer.country)
          ? "Kunden saknar Peppol-id och organisationsnummer"
          : "Kunden saknar Peppol-id — i kundens land härleds det inte ur organisationsnumret";
        return { ...base, found: null, name: null, documentTypes: [], message };
      }
      const { scheme, value } = splitPeppolId(recipient.peppolId);
      let result: LookupResult;
      try {
        // The directory of the customer's own country (spec 2026-11-05).
        result = await provider.lookupParticipant(scheme, value, customer.country);
      } catch (err) {
        throw err instanceof EInvoiceProviderError ? fromProviderError(err) : err;
      }
      return {
        ...base,
        found: result.found,
        name: result.name,
        documentTypes: result.documentTypes.map((t) => DOCUMENT_TYPE_LABELS[t] ?? t),
        message: result.message,
      };
    },
  };
}

export type EinvoiceService = ReturnType<typeof createEinvoiceService>;

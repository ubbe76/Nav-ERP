import { createHash } from "node:crypto";
import { toUnitPrice, toUnitQuantity, type EinvoiceBlockedReason, type EinvoiceStatus, type PeppolLookupInput } from "@navet/shared";
import { configurationLines } from "../../configurator/service/configuration-lines.js";
import { InvoiceNotFoundError } from "../../sales/service/invoice.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { LIVE_TRANSMISSION_CONSTRAINT, type EinvoiceRepository, type TransmissionRow } from "../repository/einvoice.repository.js";
import { EInvoiceProviderError, type LookupResult } from "./einvoice-provider.js";
import {
  orgNumberDigits,
  type CompanyInfoReader,
  type CompanyInfoRow,
  type EinvoiceSettingsService,
} from "./einvoice-settings.service.js";
import { einvoiceStatusLabel, isLiveStatus, mapProviderState, providerErrorText } from "./einvoice-status.js";
import {
  BLOCKED_MESSAGES,
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceNotConfiguredError,
  fromProviderError,
} from "./einvoice.errors.js";
import { checkUblInput } from "./ubl/ubl-check.js";
import { buildUblDocument } from "./ubl/ubl-invoice-builder.js";
import type { PeppolIdentifier, UblInvoiceInput, UblLine, UblPaymentAccount, UblPostalAddress } from "./ubl/ubl-types.js";

// E-faktura via Peppol — sändning, läsning för fakturakortet och Kontrollera
// mottagare (spec §3.4, §3.6). No DB transaction is ever held over the
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
}

export interface InvoiceReadModel {
  id: string;
  invoiceNumber: string | null;
  type: "invoice" | "credit";
  status: "draft" | "issued" | "paid" | "cancelled";
  currency: string;
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

// The customer's Peppol-id, else "0007:" + organisationsnummer.
export function resolveRecipient(customer: Pick<CustomerReadModel, "peppolId" | "orgNumber">, override?: string | null): Recipient {
  const own = (override ?? customer.peppolId)?.trim();
  if (own) return { peppolId: own, source: "customer" };
  const digits = orgNumberDigits(customer.orgNumber);
  if (digits) return { peppolId: `0007:${digits}`, source: "org-number" };
  return { peppolId: null, source: null };
}

export function splitPeppolId(peppolId: string): PeppolIdentifier {
  const i = peppolId.indexOf(":");
  return { scheme: peppolId.slice(0, i), value: peppolId.slice(i + 1) };
}

// Why the invoice cannot be sent right now, in the spec's order; null = it can.
export function blockedReasonFor(
  invoice: Pick<InvoiceReadModel, "status" | "currency">,
  customer: Pick<CustomerReadModel, "privatePerson" | "country" | "invoiceCountry" | "peppolId" | "orgNumber">,
  company: CompanyInfoRow | null
): EinvoiceBlockedReason | null {
  if (invoice.status !== "issued" && invoice.status !== "paid") return "invoice-not-issued";
  if (customer.privatePerson) return "private-person";
  if (customer.country !== "SE" || (customer.invoiceCountry !== null && customer.invoiceCountry !== "SE")) return "foreign-customer";
  if (invoice.currency !== "SEK") return "currency";
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

function paymentAccountOf(company: CompanyInfoRow): UblPaymentAccount | null {
  const bankgiro = company.bankgiro?.replace(/\s/g, "");
  if (bankgiro) return { kind: "bankgiro", account: bankgiro };
  const plusgiro = company.plusgiro?.replace(/\s/g, "");
  if (plusgiro) return { kind: "plusgiro", account: plusgiro };
  const iban = company.iban?.replace(/\s/g, "");
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
      description: r.description,
      articleNumber: r.articleNumber,
      quantity: toUnitQuantity(Number(r.quantity), r.unitFactor),
      unitCode: r.unitCode,
      unitPrice: toUnitPrice(Number(r.unitPrice), r.unitFactor),
      discountPercent: Number(r.discountPercent),
      lineAmount: Number(r.lineAmount),
      vatAmount: Number(r.vatAmount),
      vatRate: Number(r.vatRate),
      orderLineReference: link?.orderNumber ? `${link.orderNumber}:${link.orderLineNo ?? 1}` : null,
      properties: configurationProperties(r.configuration),
    };
  });

  return {
    type: isCredit ? "credit" : "invoice",
    invoiceNumber: invoice.invoiceNumber ?? "",
    issueDate: invoice.invoiceDate ?? args.today,
    dueDate: isCredit ? null : invoice.dueDate,
    currency: "SEK",
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
      address: addressOf(invoice.invoiceAddress, invoice.invoicePostalCode, invoice.invoiceCity, "SE"),
      orgNumber: orgNumberDigits(invoice.orgNumber ?? customer.orgNumber),
      vatNumber: (invoice.vatNumber ?? customer.vatNumber)?.replace(/\s/g, "").toUpperCase() || null,
      customerNumber: invoice.customerNumber ?? customer.customerNumber,
    },
    payment: {
      account: isCredit ? null : paymentAccountOf(company),
      ocrNumber: isCredit ? null : invoice.ocrNumber,
    },
    lines,
    attachment: args.attachment
      ? {
          filename: args.attachment.filename,
          description: isCredit ? "Kreditfaktura (PDF)" : "Faktura (PDF)",
          mimeCode: "application/pdf",
          content: args.attachment.content,
        }
      : null,
  };
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

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
      today: isoDate(now()),
    });
    const problems = checkUblInput(input);
    if (problems.length > 0) throw new EinvoiceDocumentInvalidError(problems);
    const xml = Buffer.from(buildUblDocument(input), "utf8");
    return { invoice, customer, recipient, input, xml };
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

    // Skicka e-faktura (spec §3.4).
    async send(invoiceId: string, userId: string | null): Promise<TransmissionView> {
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
            detail: { transmissionId, kind: err.kind, reason: err.message, fieldErrors: err.fieldErrors, providerInvoiceId: err.providerInvoiceId },
            userId,
          });
          throw fromProviderError(err);
        }
        await repo.updateTransmission(transmissionId, {
          status: "failed",
          errorMessage: err instanceof Error ? err.message : "Sändningen misslyckades",
          statusUpdatedAt: at,
        });
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
        await repo.updateTransmission(transmissionId, {
          status,
          providerInvoiceId: result.providerInvoiceId,
          providerState: result.state.slice(0, 40),
          errorMessage,
          sentAt: isLiveStatus(status) && status !== "sending" ? at : null,
          statusUpdatedAt: at,
        });
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
          },
          userId,
        });
      } catch (err) {
        log("E-invoice sent but the transmission row could not be updated", {
          transmissionId,
          providerInvoiceId: result.providerInvoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return transmissionView((await repo.findTransmission(transmissionId))!);
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
        return { ...base, found: null, name: null, documentTypes: [], message: "Kunden saknar Peppol-id och organisationsnummer" };
      }
      const { scheme, value } = splitPeppolId(recipient.peppolId);
      let result: LookupResult;
      try {
        result = await provider.lookupParticipant(scheme, value);
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

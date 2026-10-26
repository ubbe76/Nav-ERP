import { createHash } from "node:crypto";
import type { Db, Tx } from "@navet/db";
import {
  DEVIATION_COST_KIND_LABELS,
  DEVIATION_DECISION_LABELS,
  type CancelDeviationInput,
  type CloseDeviationInput,
  type CreateDeviationCostInput,
  type CreateDeviationInput,
  type CreateDeviationLinkInput,
  type DeviationType,
  type ListDeviationsQuery,
  type SendDeviationEmailInput,
  type UpdateDeviationInput,
} from "@navet/shared";
import { formatNumber, type DocumentPdfService } from "../../mail/service/document-pdf.js";
import type { MailService } from "../../mail/service/mail.service.js";
import { hasSignature } from "../../purchase/service/invoice-scan/file-signature.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import {
  ORDER_ID_BATCH,
  type DerivedCostLine,
  type DeviationRow,
  type DeviationWrite,
  type DetailRow,
  type ListRow,
  type QualityRepository,
} from "../repository/quality.repository.js";
import { summarizeDeviationCosts, type DeviationCostLine } from "./deviation-costs.js";
import {
  DeviationCloseRequirementsError,
  DeviationFileNotFoundError,
  DeviationLinkMismatchError,
  DeviationNotEditableError,
  DeviationNotFoundError,
  DeviationReasonNotApplicableError,
  InvalidDeviationFileTypeError,
} from "./deviation-errors.js";
import { checkDeviationLinks, impliedParents, type DeviationLinkInput } from "./deviation-link-check.js";
import { allowedActions, closeRequirementsMissing, isEditable } from "./deviation-status.js";

// Reklamationer och avvikelser — the service. Documents only: nothing here
// books, moves stock or changes another module's document; the shortcuts
// create their documents through their own routines and link them with
// linkDeviationInTx. Statuses: deviation-status.ts. Links: the pure
// deviation-link-check.ts over the facts the repository loads. Net cost:
// deviation-costs.ts over the manual and the derived lines.

export const DEVIATION_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_DEVIATION_FILE_BYTES = 20 * 1024 * 1024;

const PDF_TITLES: Record<DeviationType, string> = {
  supplier: "Reklamation",
  customer: "Reklamationsbesked",
  internal: "Avvikelserapport",
};

// The fields PATCH may change (the type never changes).
const EDITABLE_FIELDS = [
  "title",
  "description",
  "reportedDate",
  "reasonId",
  "responsibleUserId",
  "dueDate",
  "customerId",
  "supplierId",
  "counterpartyReference",
  "salesOrderId",
  "salesOrderRowId",
  "invoiceId",
  "purchaseOrderId",
  "purchaseOrderRowId",
  "manufacturingOrderId",
  "moOperationId",
  "articleId",
  "quantity",
  "causeAnalysis",
  "correctiveAction",
  "preventiveAction",
  "decision",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

// The PDF's quantity: formatNumber (never sv-SE's U+2212 minus, mail.md)
// with up to four decimals and no trailing zeros.
function formatQuantity(value: number): string {
  const decimals = Number.isInteger(value) ? 0 : Math.min(4, String(value).split(".")[1]?.length ?? 4);
  return formatNumber(value, decimals);
}

// Comparable form of a stored or incoming value (numeric columns come back
// as "5.0000").
function comparable(field: EditableField, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (field === "quantity") return Number(value);
  return value;
}

export function createQualityService(deps: {
  repo: QualityRepository;
  pdf: Pick<DocumentPdfService, "renderDeviationReport">;
  mail: Pick<MailService, "sendMail">;
  today?: () => string;
}) {
  const { repo } = deps;
  const today = deps.today ?? stockholmToday;

  const isOverdue = (row: { status: string; dueDate: string | null }, day: string) =>
    (row.status === "registered" || row.status === "investigating") && row.dueDate !== null && row.dueDate < day;

  // In batches like ordersWithDeviation: the leveransprecision's period
  // can hold more cases than one IN list should carry.
  async function netCosts(ids: string[]): Promise<Map<string, number>> {
    const lines = new Map<string, DeviationCostLine[]>();
    for (let i = 0; i < ids.length; i += ORDER_ID_BATCH) {
      const batch = ids.slice(i, i + ORDER_ID_BATCH);
      const [manual, derived] = await Promise.all([repo.manualCostLines(batch), repo.derivedCostLines(batch)]);
      for (const line of [...manual, ...derived]) {
        const list = lines.get(line.deviationId) ?? [];
        list.push({ kind: line.kind, amount: line.amount });
        lines.set(line.deviationId, list);
      }
    }
    return new Map(ids.map((id) => [id, summarizeDeviationCosts(lines.get(id) ?? []).netCost]));
  }

  function listRow(row: ListRow, day: string, netCost: number | null) {
    return {
      ...row,
      quantity: row.quantity === null ? null : Number(row.quantity),
      counterpartyName: row.customerName ?? row.supplierName ?? null,
      overdue: isOverdue(row, day),
      netCost,
    };
  }

  // The reason must exist, be active and apply to the case's type. An
  // unchanged reason on PATCH is kept even if it has since been deactivated.
  async function assertReason(type: DeviationType, reasonId: string, executor?: Db | Tx) {
    const reason = await repo.findReason(reasonId, executor);
    if (!reason) throw new DeviationReasonNotApplicableError("Orsaken finns inte");
    if (!reason.active) throw new DeviationReasonNotApplicableError(`Orsaken ${reason.name} är inaktiv`);
    const applies = type === "customer" ? reason.appliesCustomer : type === "supplier" ? reason.appliesSupplier : reason.appliesInternal;
    if (!applies) {
      const text = type === "customer" ? "kundreklamationer" : type === "supplier" ? "leverantörsavvikelser" : "interna avvikelser";
      throw new DeviationReasonNotApplicableError(`Orsaken ${reason.name} gäller inte ${text}`);
    }
  }

  // Runs the link check over the facts and returns the resolved ids (the
  // implied order of a row, the article of a row/TO).
  async function resolveLinks(input: DeviationLinkInput, executor?: Db | Tx): Promise<DeviationLinkInput> {
    const facts = await repo.loadLinkFacts(input, executor);
    Object.assign(facts, await repo.loadOrderFacts(impliedParents(input, facts), executor));
    const result = checkDeviationLinks(input, facts);
    if (!result.ok) throw new DeviationLinkMismatchError(result.field, result.message);
    return result.resolved;
  }

  async function assertResponsible(userId: string | null | undefined, executor?: Db | Tx) {
    if (userId && !(await repo.userExists(userId, executor))) {
      throw new DeviationLinkMismatchError("responsibleUserId", "Användaren finns inte");
    }
  }

  function linkInputOf(type: DeviationType, v: Partial<Record<keyof DeviationLinkInput, string | null | undefined>>): DeviationLinkInput {
    return {
      type,
      customerId: v.customerId ?? null,
      supplierId: v.supplierId ?? null,
      salesOrderId: v.salesOrderId ?? null,
      salesOrderRowId: v.salesOrderRowId ?? null,
      invoiceId: v.invoiceId ?? null,
      purchaseOrderId: v.purchaseOrderId ?? null,
      purchaseOrderRowId: v.purchaseOrderRowId ?? null,
      manufacturingOrderId: v.manufacturingOrderId ?? null,
      moOperationId: v.moOperationId ?? null,
      articleId: v.articleId ?? null,
    };
  }

  async function requireRaw(id: string): Promise<DeviationRow> {
    const row = await repo.findRaw(id);
    if (!row) throw new DeviationNotFoundError(id);
    return row;
  }

  const service = {
    async list(query: ListDeviationsQuery, opts: { seePrices: boolean }) {
      const day = today();
      const { rows, total } = await repo.list(query, day);
      const costs = opts.seePrices ? await netCosts(rows.map((r) => r.id)) : new Map<string, number>();
      return { rows: rows.map((r) => listRow(r, day, opts.seePrices ? (costs.get(r.id) ?? 0) : null)), total };
    },

    async responsibleOptions() {
      return repo.responsibleOptions();
    },

    async get(id: string, opts: { seePrices: boolean }) {
      const row = await repo.findDetail(id);
      if (!row) throw new DeviationNotFoundError(id);
      const day = today();
      const [manual, derived, links, files, events] = await Promise.all([
        repo.listCosts(id),
        repo.derivedCostLines([id]),
        repo.listLinks(id),
        repo.listFiles(id),
        repo.listEvents(id),
      ]);
      const totals = summarizeDeviationCosts([
        ...manual.map((c) => ({ kind: c.kind, amount: Number(c.amount) })),
        ...derived.map((d) => ({ kind: d.kind, amount: d.amount })),
      ]);
      const describedLinks = await Promise.all(
        links.map(async (link) => {
          const doc = await repo.describeDocument(link.documentType, link.documentId);
          return {
            ...link,
            documentNumber: doc?.number ?? null,
            documentStatus: doc?.status ?? null,
            deleted: doc === null,
          };
        })
      );
      const derivedLabel = (d: DerivedCostLine) =>
        d.documentType === "credit_invoice"
          ? `Från kreditfaktura ${d.documentNumber ?? ""}`.trim()
          : `Från leverantörsfaktura ${d.documentNumber ?? ""}`.trim();
      return {
        ...listRow(row, day, opts.seePrices ? totals.netCost : null),
        ...detailFields(row),
        editable: isEditable(row.status),
        allowedTransitions: allowedActions(row.status),
        closeRequirementsMissing: closeRequirementsMissing(row),
        costs: opts.seePrices
          ? {
              rows: manual.map((c) => ({ ...c, amount: Number(c.amount), kindLabel: DEVIATION_COST_KIND_LABELS[c.kind] })),
              derived: derived.map(({ deviationId: _d, ...d }) => ({ ...d, kindLabel: DEVIATION_COST_KIND_LABELS[d.kind], label: derivedLabel(d) })),
              ...totals,
            }
          : null,
        links: describedLinks,
        files,
        events,
      };
    },

    async create(input: CreateDeviationInput, userId: string | null, opts: { seePrices: boolean }) {
      if (input.reasonId) await assertReason(input.type, input.reasonId);
      await assertResponsible(input.responsibleUserId);
      const links = await resolveLinks(linkInputOf(input.type, input));
      const { type: _type, ...linkValues } = links;
      const { id } = await repo.create(
        {
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          reportedDate: input.reportedDate ?? today(),
          reasonId: input.reasonId ?? null,
          responsibleUserId: input.responsibleUserId ?? null,
          dueDate: input.dueDate ?? null,
          counterpartyReference: input.counterpartyReference ?? null,
          ...linkValues,
          quantity: input.quantity == null ? null : String(input.quantity),
          causeAnalysis: input.causeAnalysis ?? null,
          correctiveAction: input.correctiveAction ?? null,
          preventiveAction: input.preventiveAction ?? null,
        },
        userId
      );
      return service.get(id, opts);
    },

    async update(id: string, input: UpdateDeviationInput, userId: string | null, opts: { seePrices: boolean }) {
      if (input.title === null) delete (input as { title?: unknown }).title;
      if (input.reportedDate === null) delete (input as { reportedDate?: unknown }).reportedDate;
      const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      // Everything below runs on the LOCKED row (repo.update): the merge, the
      // reason and the link checks, and the counterparty rule — a concurrent
      // PATCH waits and then merges onto what this one stored.
      await repo.update(
        id,
        async (current, tx) => {
          const merged = { ...current, ...given } as DeviationRow & { quantity: string | number | null };
          if (input.reasonId && input.reasonId !== current.reasonId) await assertReason(current.type, input.reasonId, tx);
          if (input.responsibleUserId && input.responsibleUserId !== current.responsibleUserId) {
            await assertResponsible(input.responsibleUserId, tx);
          }
          if (current.type === "internal" && merged.decision) {
            throw new DeviationLinkMismatchError("decision", "En intern avvikelse har inget beslut");
          }
          const links = await resolveLinks(linkInputOf(current.type, merged), tx);
          const { type: _type, ...linkValues } = links;
          // Another counterparty: the linked kreditfakturor/KO/IO/
          // leverantörsfakturor are the current one's (the link checked
          // that) — they would stay linked, and counted, on the wrong case.
          for (const field of ["customerId", "supplierId"] as const) {
            if ((linkValues[field] ?? null) === (current[field] ?? null)) continue;
            const bound = await repo.counterpartyLinks(tx, id);
            if (bound.length > 0) {
              const who = field === "customerId" ? "kunden" : "leverantören";
              throw new DeviationLinkMismatchError(
                field,
                `${current.deviationNumber} har kopplade dokument från den nuvarande ${who}. Ta bort kopplingarna först.`
              );
            }
          }
          const next: Record<EditableField, unknown> = {
            title: merged.title,
            description: merged.description ?? null,
            reportedDate: merged.reportedDate,
            reasonId: merged.reasonId ?? null,
            responsibleUserId: merged.responsibleUserId ?? null,
            dueDate: merged.dueDate ?? null,
            counterpartyReference: merged.counterpartyReference ?? null,
            ...linkValues,
            quantity: merged.quantity == null ? null : String(merged.quantity),
            causeAnalysis: merged.causeAnalysis ?? null,
            correctiveAction: merged.correctiveAction ?? null,
            preventiveAction: merged.preventiveAction ?? null,
            decision: merged.decision ?? null,
          };
          const set: Record<string, unknown> = {};
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          for (const field of EDITABLE_FIELDS) {
            const before = comparable(field, current[field]);
            const after = comparable(field, next[field]);
            if (before === after) continue;
            set[field] = next[field];
            changes[field] = { before, after };
          }
          return { set: set as DeviationWrite, changes };
        },
        userId
      );
      return service.get(id, opts);
    },

    // --- status ---

    async start(id: string, userId: string | null) {
      await repo.transition(id, "start", () => ({ set: {} }), userId);
    },

    // Avsluta: Åtgärd and (customer/supplier) Beslut, checked on the locked
    // row; a Beslut given here is written in the same UPDATE.
    async close(id: string, input: CloseDeviationInput, userId: string | null) {
      const current = await requireRaw(id);
      if (current.type === "internal" && input.decision) {
        throw new DeviationLinkMismatchError("decision", "En intern avvikelse har inget beslut");
      }
      await repo.transition(
        id,
        "close",
        (row) => {
          const decision = input.decision ?? row.decision;
          const missing = closeRequirementsMissing({ type: row.type, correctiveAction: row.correctiveAction, decision });
          if (missing.length > 0) throw new DeviationCloseRequirementsError(missing);
          return {
            set: { decision, closedAt: new Date(), closedBy: userId },
            detail: row.type === "internal" ? {} : { decision },
          };
        },
        userId
      );
    },

    async cancel(id: string, input: CancelDeviationInput, userId: string | null) {
      await repo.transition(
        id,
        "cancel",
        () => ({ set: { cancelledAt: new Date(), cancelledBy: userId, cancelReason: input.reason }, detail: { reason: input.reason } }),
        userId
      );
    },

    // Öppna igen: closed_at/by cleared, the decision and the texts kept.
    async reopen(id: string, userId: string | null) {
      await repo.transition(id, "reopen", () => ({ set: { closedAt: null, closedBy: null } }), userId);
    },

    // --- costs, links, files ---

    async addCost(id: string, input: CreateDeviationCostInput, userId: string | null) {
      await repo.addCost(id, { kind: input.kind, description: input.description ?? null, amount: input.amount }, userId);
    },

    async removeCost(id: string, costId: string, userId: string | null) {
      await repo.removeCost(id, costId, userId);
    },

    async addLink(id: string, input: CreateDeviationLinkInput, userId: string | null) {
      await repo.addLink(id, input.documentType, input.documentId, userId);
    },

    async removeLink(id: string, linkId: string, userId: string | null) {
      await repo.removeLink(id, linkId, userId);
    },

    async listFiles(id: string) {
      await requireRaw(id);
      return repo.listFiles(id);
    },

    async addFile(id: string, file: { filename: string; contentType: string; data: Buffer }, userId: string | null) {
      await requireRaw(id);
      if (!(DEVIATION_FILE_TYPES as readonly string[]).includes(file.contentType) || !hasSignature(file.contentType, file.data)) {
        throw new InvalidDeviationFileTypeError(file.contentType);
      }
      const sha256 = createHash("sha256").update(file.data).digest("hex");
      return repo.addFile(
        id,
        { filename: file.filename.slice(0, 255), contentType: file.contentType, sizeBytes: file.data.length, sha256, data: file.data },
        userId
      );
    },

    async downloadFile(id: string, fileId: string) {
      const file = await repo.findFile(id, fileId);
      if (!file) throw new DeviationFileNotFoundError(fileId);
      return file;
    },

    async removeFile(id: string, fileId: string, userId: string | null) {
      await repo.removeFile(id, fileId, userId);
    },

    // --- the reklamationsrapport ---

    async renderPdf(id: string, opts: { details: boolean }) {
      const row = await repo.findDetail(id);
      if (!row) throw new DeviationNotFoundError(id);
      const title = PDF_TITLES[row.type];
      const references: { label: string; value: string }[] = [];
      if (row.counterpartyReference) references.push({ label: "Er referens", value: row.counterpartyReference });
      if (row.salesOrderNumber) references.push({ label: "Kundorder", value: row.salesOrderNumber });
      if (row.customerOrderNumber) references.push({ label: "Ert ordernr", value: row.customerOrderNumber });
      if (row.invoiceNumber) references.push({ label: "Faktura", value: row.invoiceNumber });
      if (row.purchaseOrderNumber) references.push({ label: "Inköpsorder", value: row.purchaseOrderNumber });
      // The TO number is internal — only the internal report prints it.
      if (row.type === "internal" && row.manufacturingOrderNumber) {
        references.push({ label: "Tillverkningsorder", value: row.manufacturingOrderNumber });
      }
      const sections: { label: string; text: string }[] = [{ label: "Ärende", text: row.title }];
      if (row.articleNumber) sections.push({ label: "Artikel", text: `${row.articleNumber} ${row.articleName ?? ""}`.trim() });
      if (row.quantity !== null) {
        sections.push({ label: "Antal", text: `${formatQuantity(Number(row.quantity))}${row.unitCode ? ` ${row.unitCode}` : ""}` });
      }
      if (row.reasonName) sections.push({ label: "Orsak", text: row.reasonName });
      if (row.description) sections.push({ label: "Beskrivning", text: row.description });
      if (opts.details) {
        if (row.causeAnalysis) sections.push({ label: "Orsaksanalys", text: row.causeAnalysis });
        if (row.correctiveAction) sections.push({ label: "Åtgärd", text: row.correctiveAction });
        if (row.preventiveAction) sections.push({ label: "Förebyggande åtgärd", text: row.preventiveAction });
        if (row.decision) sections.push({ label: "Beslut", text: DEVIATION_DECISION_LABELS[row.decision] });
      }
      const partnerName = row.customerName ?? row.supplierName;
      const content = await deps.pdf.renderDeviationReport({
        title,
        outgoing: row.type !== "internal",
        documentNumber: row.deviationNumber,
        date: row.reportedDate,
        partnerLabel: row.type === "customer" ? "KUND" : row.type === "supplier" ? "LEVERANTÖR" : null,
        partner: partnerName
          ? {
              name: partnerName,
              address: row.counterpartyAddress,
              postalCode: row.counterpartyPostalCode,
              city: row.counterpartyCity,
              country: row.counterpartyCountry,
            }
          : null,
        references,
        sections,
      });
      return { filename: `${title}-${row.deviationNumber}.pdf`, content };
    },

    // Skicka: the PDF as attachment through the mail module (email_log with
    // document type "deviation"); no status change, a history row on success.
    async sendEmail(id: string, input: SendDeviationEmailInput, userId: string | null) {
      const { filename, content } = await service.renderPdf(id, { details: input.includeDetails });
      const logged = await deps.mail.sendMail({
        documentType: "deviation",
        documentId: id,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: [{ filename, content }],
        includeDetails: input.includeDetails,
      });
      await repo.logEmailSent(id, { emailLogId: logged.id, to: input.to, subject: input.subject, includeDetails: input.includeDetails }, userId);
      return logged;
    },

    // --- leveransprecisionens kvalitetsdel (the reports module reads this) ---

    async precisionQuality(kind: "sales" | "purchase", range: { fromDate: string; toDate: string }, measuredOrderIds: string[]) {
      const type = kind === "sales" ? "customer" : "supplier";
      const [deviations, withDeviation] = await Promise.all([
        repo.periodDeviations(type, range.fromDate, range.toDate),
        repo.ordersWithDeviation(type, measuredOrderIds),
      ]);
      const costs = await netCosts(deviations.map((d) => d.id));
      return {
        deviations: deviations.map((d) => ({ ...d, netCost: costs.get(d.id) ?? 0 })),
        ordersWithDeviation: withDeviation,
      };
    },
  };
  return service;
}

// The card-only fields of the detail read.
function detailFields(row: DetailRow) {
  return {
    description: row.description,
    salesOrderRowId: row.salesOrderRowId,
    purchaseOrderRowId: row.purchaseOrderRowId,
    moOperationId: row.moOperationId,
    moOperationSequenceNo: row.moOperationSequenceNo,
    moOperationWorkCenterName: row.moOperationWorkCenterName,
    causeAnalysis: row.causeAnalysis,
    correctiveAction: row.correctiveAction,
    preventiveAction: row.preventiveAction,
    decision: row.decision,
    closedAt: row.closedAt,
    closedByName: row.closedByName,
    cancelledAt: row.cancelledAt,
    cancelledByName: row.cancelledByName,
    cancelReason: row.cancelReason,
    createdByName: row.createdByName,
    updatedAt: row.updatedAt,
    customerNumber: row.customerNumber,
    supplierNumber: row.supplierNumber,
    counterpartyEmail: row.counterpartyEmail,
  };
}

export type QualityService = ReturnType<typeof createQualityService>;

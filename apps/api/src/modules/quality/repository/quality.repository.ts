import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import {
  articles,
  customers,
  deviationCosts,
  deviationEvents,
  deviationFiles,
  deviationLinks,
  deviationReasons,
  deviations,
  invoiceRows,
  invoices,
  manufacturingOrders,
  moOperations,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  supplierInvoices,
  suppliers,
  units,
  users,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import {
  DEVIATION_OPEN_STATUSES,
  ilikePattern,
  type DeviationAction,
  type DeviationCostKind,
  type DeviationLinkDocumentType,
  type DeviationStatus,
  type DeviationType,
  type ListDeviationsQuery,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import {
  DeviationCostNotFoundError,
  DeviationFileNotFoundError,
  DeviationLinkNotFoundError,
  DeviationNotEditableError,
  DeviationNotFoundError,
  InvalidStatusTransitionError,
} from "../service/deviation-errors.js";
import type { DeviationLinkFacts } from "../service/deviation-link-check.js";
import { canPerform, DEVIATION_TRANSITIONS, isEditable } from "../service/deviation-status.js";
import { round2 } from "../service/deviation-costs.js";
import { linkDeviationInTx } from "./deviation-link-tx.js";

// Avvikelser — the register's reads and writes. Every write that changes the
// case (fields, status, costs, links, files) locks the case row FOR UPDATE
// first and writes its history row (deviation_events) in the same
// transaction; the edits are refused unless the case is open. The derived
// costs are read here (derivedCostLines) and summed by the pure
// deviation-costs.ts.

const responsibleUsers = alias(users, "deviation_responsible_users");
const createdUsers = alias(users, "deviation_created_users");
const closedUsers = alias(users, "deviation_closed_users");
const cancelledUsers = alias(users, "deviation_cancelled_users");

export type DeviationRow = typeof deviations.$inferSelect;
export type DeviationWrite = Partial<Omit<typeof deviations.$inferInsert, "id" | "deviationNumber" | "createdAt">>;

export interface DerivedCostLine {
  kind: "credit" | "recovery";
  amount: number;
  linkId: string;
  documentType: DeviationLinkDocumentType;
  documentId: string;
  documentNumber: string | null;
}

const listColumns = {
  id: deviations.id,
  deviationNumber: deviations.deviationNumber,
  type: deviations.type,
  status: deviations.status,
  title: deviations.title,
  reportedDate: deviations.reportedDate,
  dueDate: deviations.dueDate,
  customerId: deviations.customerId,
  customerName: customers.name,
  supplierId: deviations.supplierId,
  supplierName: suppliers.name,
  counterpartyReference: deviations.counterpartyReference,
  articleId: deviations.articleId,
  articleNumber: articles.articleNumber,
  articleName: articles.name,
  unitCode: units.code,
  quantity: deviations.quantity,
  reasonId: deviations.reasonId,
  reasonCode: deviationReasons.code,
  reasonName: deviationReasons.name,
  responsibleUserId: deviations.responsibleUserId,
  responsibleUserName: responsibleUsers.name,
  salesOrderId: deviations.salesOrderId,
  salesOrderNumber: salesOrders.orderNumber,
  invoiceId: deviations.invoiceId,
  invoiceNumber: invoices.invoiceNumber,
  purchaseOrderId: deviations.purchaseOrderId,
  purchaseOrderNumber: purchaseOrders.orderNumber,
  manufacturingOrderId: deviations.manufacturingOrderId,
  manufacturingOrderNumber: manufacturingOrders.orderNumber,
  createdAt: deviations.createdAt,
};

// The joins every list/detail read shares (drizzle's dynamic mode; the
// selected columns are explicit, so the joins never change the row shape).
function withListJoins<T extends PgSelect>(qb: T): T {
  return qb
    .leftJoin(customers, eq(customers.id, deviations.customerId))
    .leftJoin(suppliers, eq(suppliers.id, deviations.supplierId))
    .leftJoin(articles, eq(articles.id, deviations.articleId))
    .leftJoin(units, eq(units.id, articles.unitId))
    .leftJoin(deviationReasons, eq(deviationReasons.id, deviations.reasonId))
    .leftJoin(responsibleUsers, eq(responsibleUsers.id, deviations.responsibleUserId))
    .leftJoin(salesOrders, eq(salesOrders.id, deviations.salesOrderId))
    .leftJoin(invoices, eq(invoices.id, deviations.invoiceId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, deviations.purchaseOrderId))
    .leftJoin(manufacturingOrders, eq(manufacturingOrders.id, deviations.manufacturingOrderId)) as unknown as T;
}

export function createQualityRepository(db: Db) {
  // The case row, locked, and open — or the error the routes map (404/409).
  async function lockEditable(tx: Tx, id: string): Promise<DeviationRow> {
    const [row] = await tx.select().from(deviations).where(eq(deviations.id, id)).for("update");
    if (!row) throw new DeviationNotFoundError(id);
    if (!isEditable(row.status)) throw new DeviationNotEditableError(row.deviationNumber);
    return row;
  }

  async function event(
    executor: Db | Tx,
    deviationId: string,
    kind: (typeof deviationEvents.$inferInsert)["event"],
    detail: Record<string, unknown> | null,
    userId: string | null
  ) {
    await executor.insert(deviationEvents).values({ deviationId, event: kind, detail, userId });
  }

  async function touch(tx: Tx, id: string) {
    await tx.update(deviations).set({ updatedAt: sql`now()` }).where(eq(deviations.id, id));
  }

  function listWhere(query: ListDeviationsQuery, today: string): SQL | undefined {
    const conditions: (SQL | undefined)[] = [];
    if (query.type) conditions.push(eq(deviations.type, query.type));
    if (query.status) conditions.push(inArray(deviations.status, query.status));
    if (query.reasonId) conditions.push(eq(deviations.reasonId, query.reasonId));
    if (query.customerId) conditions.push(eq(deviations.customerId, query.customerId));
    if (query.supplierId) conditions.push(eq(deviations.supplierId, query.supplierId));
    if (query.articleId) conditions.push(eq(deviations.articleId, query.articleId));
    if (query.salesOrderId) conditions.push(eq(deviations.salesOrderId, query.salesOrderId));
    if (query.invoiceId) conditions.push(eq(deviations.invoiceId, query.invoiceId));
    if (query.purchaseOrderId) conditions.push(eq(deviations.purchaseOrderId, query.purchaseOrderId));
    if (query.manufacturingOrderId) conditions.push(eq(deviations.manufacturingOrderId, query.manufacturingOrderId));
    if (query.responsibleUserId) conditions.push(eq(deviations.responsibleUserId, query.responsibleUserId));
    if (query.overdue) {
      conditions.push(inArray(deviations.status, [...DEVIATION_OPEN_STATUSES]), lt(deviations.dueDate, today));
    }
    if (query.from) conditions.push(gte(deviations.reportedDate, query.from));
    if (query.to) conditions.push(lte(deviations.reportedDate, query.to));
    if (query.search) {
      const pattern = ilikePattern(query.search);
      conditions.push(
        or(
          ilike(deviations.deviationNumber, pattern),
          ilike(deviations.title, pattern),
          ilike(deviations.counterpartyReference, pattern),
          ilike(customers.name, pattern),
          ilike(suppliers.name, pattern),
          ilike(articles.articleNumber, pattern),
          ilike(articles.name, pattern)
        )
      );
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  const repo = {
    async list(query: ListDeviationsQuery, today: string) {
      const where = listWhere(query, today);
      const [rows, [total]] = await Promise.all([
        withListJoins(db.select(listColumns).from(deviations).$dynamic())
          .where(where)
          .orderBy(desc(deviations.reportedDate), desc(deviations.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        withListJoins(db.select({ n: count() }).from(deviations).$dynamic()).where(where),
      ]);
      return { rows: rows as ListRow[], total: Number(total?.n ?? 0) };
    },

    async findRaw(id: string): Promise<DeviationRow | null> {
      const [row] = await db.select().from(deviations).where(eq(deviations.id, id));
      return row ?? null;
    },

    async findDetail(id: string) {
      const [row] = await withListJoins(
        db
          .select({
            ...listColumns,
            description: deviations.description,
            salesOrderRowId: deviations.salesOrderRowId,
            purchaseOrderRowId: deviations.purchaseOrderRowId,
            moOperationId: deviations.moOperationId,
            moOperationSequenceNo: moOperations.sequenceNo,
            moOperationWorkCenterName: workCenters.name,
            causeAnalysis: deviations.causeAnalysis,
            correctiveAction: deviations.correctiveAction,
            preventiveAction: deviations.preventiveAction,
            decision: deviations.decision,
            closedAt: deviations.closedAt,
            closedByName: closedUsers.name,
            cancelledAt: deviations.cancelledAt,
            cancelledByName: cancelledUsers.name,
            cancelReason: deviations.cancelReason,
            createdByName: createdUsers.name,
            updatedAt: deviations.updatedAt,
            customerNumber: customers.customerNumber,
            supplierNumber: suppliers.supplierNumber,
            counterpartyEmail: sql<string | null>`coalesce(${customers.email}, ${suppliers.email})`,
            counterpartyAddress: sql<string | null>`coalesce(${customers.address}, ${suppliers.address})`,
            counterpartyPostalCode: sql<string | null>`coalesce(${customers.postalCode}, ${suppliers.postalCode})`,
            counterpartyCity: sql<string | null>`coalesce(${customers.city}, ${suppliers.city})`,
            counterpartyCountry: sql<string | null>`coalesce(${customers.country}, ${suppliers.country})`,
            customerOrderNumber: salesOrders.customerOrderNumber,
          })
          .from(deviations)
          .$dynamic()
      )
        .leftJoin(moOperations, eq(moOperations.id, deviations.moOperationId))
        .leftJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .leftJoin(closedUsers, eq(closedUsers.id, deviations.closedBy))
        .leftJoin(cancelledUsers, eq(cancelledUsers.id, deviations.cancelledBy))
        .leftJoin(createdUsers, eq(createdUsers.id, deviations.createdBy))
        .where(eq(deviations.id, id));
      return (row as DetailRow | undefined) ?? null;
    },

    // --- the facts the pure link check needs ---

    async loadLinkFacts(ids: {
      customerId: string | null;
      supplierId: string | null;
      articleId: string | null;
      salesOrderRowId: string | null;
      purchaseOrderRowId: string | null;
      moOperationId: string | null;
      invoiceId: string | null;
    }): Promise<DeviationLinkFacts> {
      const facts: DeviationLinkFacts = {};
      if (ids.customerId) {
        facts.customerExists = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, ids.customerId))).length > 0;
      }
      if (ids.supplierId) {
        facts.supplierExists = (await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, ids.supplierId))).length > 0;
      }
      if (ids.articleId) {
        facts.articleExists = (await db.select({ id: articles.id }).from(articles).where(eq(articles.id, ids.articleId))).length > 0;
      }
      if (ids.salesOrderRowId) {
        const [row] = await db
          .select({ salesOrderId: salesOrderRows.salesOrderId, articleId: salesOrderRows.articleId })
          .from(salesOrderRows)
          .where(eq(salesOrderRows.id, ids.salesOrderRowId));
        facts.salesOrderRow = row ?? null;
      }
      if (ids.purchaseOrderRowId) {
        const [row] = await db
          .select({ purchaseOrderId: purchaseOrderRows.purchaseOrderId, articleId: purchaseOrderRows.articleId })
          .from(purchaseOrderRows)
          .where(eq(purchaseOrderRows.id, ids.purchaseOrderRowId));
        facts.purchaseOrderRow = row ?? null;
      }
      if (ids.moOperationId) {
        const [row] = await db
          .select({ manufacturingOrderId: moOperations.manufacturingOrderId })
          .from(moOperations)
          .where(eq(moOperations.id, ids.moOperationId));
        facts.moOperation = row ?? null;
      }
      if (ids.invoiceId) {
        const [row] = await db
          .select({ customerId: invoices.customerId, invoiceNumber: invoices.invoiceNumber })
          .from(invoices)
          .where(eq(invoices.id, ids.invoiceId));
        facts.invoice = row ?? null;
      }
      return facts;
    },

    // The orders (given or implied by a row/operation).
    async loadOrderFacts(ids: { salesOrderId: string | null; purchaseOrderId: string | null; manufacturingOrderId: string | null }) {
      const facts: Pick<DeviationLinkFacts, "salesOrder" | "purchaseOrder" | "manufacturingOrder"> = {};
      if (ids.salesOrderId) {
        const [row] = await db
          .select({ customerId: salesOrders.customerId, orderNumber: salesOrders.orderNumber })
          .from(salesOrders)
          .where(eq(salesOrders.id, ids.salesOrderId));
        facts.salesOrder = row ?? null;
      }
      if (ids.purchaseOrderId) {
        const [row] = await db
          .select({ supplierId: purchaseOrders.supplierId, orderNumber: purchaseOrders.orderNumber })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, ids.purchaseOrderId));
        facts.purchaseOrder = row ?? null;
      }
      if (ids.manufacturingOrderId) {
        const [row] = await db
          .select({ articleId: manufacturingOrders.articleId, orderNumber: manufacturingOrders.orderNumber })
          .from(manufacturingOrders)
          .where(eq(manufacturingOrders.id, ids.manufacturingOrderId));
        facts.manufacturingOrder = row ?? null;
      }
      return facts;
    },

    async findReason(id: string) {
      const [row] = await db.select().from(deviationReasons).where(eq(deviationReasons.id, id));
      return row ?? null;
    },

    async userExists(id: string) {
      return (await db.select({ id: users.id }).from(users).where(eq(users.id, id))).length > 0;
    },

    // --- writes ---

    async create(values: Omit<DeviationWrite, "status" | "closedAt" | "cancelledAt"> & { type: DeviationType; title: string; reportedDate: string }, userId: string | null) {
      return db.transaction(async (tx) => {
        const deviationNumber = await getNextOrderNumber(tx, "deviation");
        const [row] = await tx
          .insert(deviations)
          .values({ ...values, deviationNumber, status: "registered", createdBy: userId })
          .returning({ id: deviations.id, deviationNumber: deviations.deviationNumber });
        await event(tx, row!.id, "created", { type: values.type, title: values.title }, userId);
        return row!;
      });
    },

    // Field edits, only while the case is open. `changes` is the history
    // row's before/after per field.
    async update(id: string, set: DeviationWrite, changes: Record<string, { before: unknown; after: unknown }>, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, id);
        await tx.update(deviations).set({ ...set, updatedAt: sql`now()` }).where(eq(deviations.id, id));
        if (Object.keys(changes).length > 0) await event(tx, id, "updated", { changes }, userId);
      });
    },

    // A status action under the case's row lock: the whitelist, then the
    // caller's guard (Avsluta's requirements) on the LOCKED row, then the
    // UPDATE and the history row.
    async transition(
      id: string,
      action: DeviationAction,
      build: (row: DeviationRow) => { set: DeviationWrite; detail?: Record<string, unknown> },
      userId: string | null
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(deviations).where(eq(deviations.id, id)).for("update");
        if (!row) throw new DeviationNotFoundError(id);
        if (!canPerform(row.status, action)) {
          throw new InvalidStatusTransitionError(`Cannot ${action} a deviation in status "${row.status}"`);
        }
        const to = DEVIATION_TRANSITIONS[action].to;
        const { set, detail } = build(row);
        await tx.update(deviations).set({ ...set, status: to, updatedAt: sql`now()` }).where(eq(deviations.id, id));
        await event(tx, id, "status_changed", { action, from: row.status, to, ...(detail ?? {}) }, userId);
      });
    },

    // --- costs ---

    async listCosts(deviationId: string) {
      return db
        .select({
          id: deviationCosts.id,
          kind: deviationCosts.kind,
          description: deviationCosts.description,
          amount: deviationCosts.amount,
          createdByName: users.name,
          createdAt: deviationCosts.createdAt,
        })
        .from(deviationCosts)
        .leftJoin(users, eq(users.id, deviationCosts.createdBy))
        .where(eq(deviationCosts.deviationId, deviationId))
        .orderBy(asc(deviationCosts.createdAt));
    },

    async addCost(deviationId: string, input: { kind: DeviationCostKind; description: string | null; amount: number }, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        const amount = round2(input.amount);
        const [row] = await tx
          .insert(deviationCosts)
          .values({ deviationId, kind: input.kind, description: input.description, amount: amount.toFixed(2), createdBy: userId })
          .returning();
        await event(tx, deviationId, "cost_added", { costId: row!.id, kind: input.kind, description: input.description, amount }, userId);
        await touch(tx, deviationId);
        return row!;
      });
    },

    async removeCost(deviationId: string, costId: string, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        const [row] = await tx
          .delete(deviationCosts)
          .where(and(eq(deviationCosts.id, costId), eq(deviationCosts.deviationId, deviationId)))
          .returning();
        if (!row) throw new DeviationCostNotFoundError(costId);
        await event(tx, deviationId, "cost_removed", { costId, kind: row.kind, description: row.description, amount: Number(row.amount) }, userId);
        await touch(tx, deviationId);
      });
    },

    // Manual cost lines of many cases, for the net cost of a list page.
    async manualCostLines(deviationIds: string[]) {
      if (deviationIds.length === 0) return [];
      const rows = await db
        .select({ deviationId: deviationCosts.deviationId, kind: deviationCosts.kind, amount: deviationCosts.amount })
        .from(deviationCosts)
        .where(inArray(deviationCosts.deviationId, deviationIds));
      return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
    },

    // The derived cost lines: a linked kreditfaktura that is issued (or
    // paid) counts as Kreditering with its net in SEK (the booked
    // line_amount_sek of its rows); a linked leverantörsfaktura that is
    // attested (or paid) and is a credit note (negative net) counts as
    // Ersättning with its net converted at its own rate. Drafts and
    // cancelled documents never count.
    async derivedCostLines(deviationIds: string[]): Promise<(DerivedCostLine & { deviationId: string })[]> {
      if (deviationIds.length === 0) return [];
      const creditNet = sql<string>`(SELECT coalesce(sum(r.line_amount_sek), 0) FROM ${invoiceRows} r WHERE r.invoice_id = ${invoices.id})`;
      const credits = await db
        .select({
          deviationId: deviationLinks.deviationId,
          linkId: deviationLinks.id,
          documentId: invoices.id,
          documentNumber: invoices.invoiceNumber,
          amount: creditNet,
        })
        .from(deviationLinks)
        .innerJoin(invoices, eq(invoices.id, deviationLinks.documentId))
        .where(
          and(
            inArray(deviationLinks.deviationId, deviationIds),
            eq(deviationLinks.documentType, "credit_invoice"),
            eq(invoices.type, "credit"),
            inArray(invoices.status, ["issued", "paid"])
          )
        );
      const recoveries = await db
        .select({
          deviationId: deviationLinks.deviationId,
          linkId: deviationLinks.id,
          documentId: supplierInvoices.id,
          documentNumber: supplierInvoices.registrationNumber,
          netAmount: supplierInvoices.netAmount,
          exchangeRate: supplierInvoices.exchangeRate,
        })
        .from(deviationLinks)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, deviationLinks.documentId))
        .where(
          and(
            inArray(deviationLinks.deviationId, deviationIds),
            eq(deviationLinks.documentType, "supplier_invoice"),
            inArray(supplierInvoices.status, ["approved", "paid"]),
            lt(supplierInvoices.netAmount, "0")
          )
        );
      return [
        ...credits
          .map((c) => ({ ...c, kind: "credit" as const, documentType: "credit_invoice" as const, amount: round2(Number(c.amount)) }))
          .filter((c) => c.amount > 0),
        ...recoveries.map((r) => ({
          deviationId: r.deviationId,
          linkId: r.linkId,
          documentId: r.documentId,
          documentNumber: r.documentNumber,
          kind: "recovery" as const,
          documentType: "supplier_invoice" as const,
          amount: round2(-Number(r.netAmount) * Number(r.exchangeRate)),
        })),
      ];
    },

    // --- links ---

    async listLinks(deviationId: string) {
      return db
        .select({
          id: deviationLinks.id,
          documentType: deviationLinks.documentType,
          documentId: deviationLinks.documentId,
          createdAt: deviationLinks.createdAt,
          createdByName: users.name,
        })
        .from(deviationLinks)
        .leftJoin(users, eq(users.id, deviationLinks.createdBy))
        .where(eq(deviationLinks.deviationId, deviationId))
        .orderBy(asc(deviationLinks.createdAt));
    },

    // Number and status of one linked document; null when it is gone.
    async describeDocument(documentType: DeviationLinkDocumentType, documentId: string) {
      switch (documentType) {
        case "credit_invoice": {
          const [row] = await db
            .select({ number: invoices.invoiceNumber, status: invoices.status })
            .from(invoices)
            .where(eq(invoices.id, documentId));
          return row ?? null;
        }
        case "sales_order": {
          const [row] = await db
            .select({ number: salesOrders.orderNumber, status: salesOrders.status })
            .from(salesOrders)
            .where(eq(salesOrders.id, documentId));
          return row ?? null;
        }
        case "purchase_order": {
          const [row] = await db
            .select({ number: purchaseOrders.orderNumber, status: purchaseOrders.status })
            .from(purchaseOrders)
            .where(eq(purchaseOrders.id, documentId));
          return row ?? null;
        }
        case "manufacturing_order": {
          const [row] = await db
            .select({ number: manufacturingOrders.orderNumber, status: manufacturingOrders.status })
            .from(manufacturingOrders)
            .where(eq(manufacturingOrders.id, documentId));
          return row ?? null;
        }
        case "supplier_invoice": {
          const [row] = await db
            .select({ number: supplierInvoices.registrationNumber, status: supplierInvoices.status })
            .from(supplierInvoices)
            .where(eq(supplierInvoices.id, documentId));
          return row ?? null;
        }
      }
    },

    async addLink(deviationId: string, documentType: DeviationLinkDocumentType, documentId: string, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        return linkDeviationInTx(tx, { deviationId, documentType, documentId, userId });
      });
    },

    async removeLink(deviationId: string, linkId: string, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        const [row] = await tx
          .delete(deviationLinks)
          .where(and(eq(deviationLinks.id, linkId), eq(deviationLinks.deviationId, deviationId)))
          .returning();
        if (!row) throw new DeviationLinkNotFoundError(linkId);
        await event(tx, deviationId, "link_removed", { linkId, documentType: row.documentType, documentId: row.documentId }, userId);
        await touch(tx, deviationId);
      });
    },

    // --- files (listings never select data) ---

    async listFiles(deviationId: string) {
      const { data: _data, ...columns } = getTableColumns(deviationFiles);
      return db.select(columns).from(deviationFiles).where(eq(deviationFiles.deviationId, deviationId)).orderBy(asc(deviationFiles.createdAt));
    },

    async addFile(
      deviationId: string,
      file: { filename: string; contentType: string; sizeBytes: number; sha256: string; data: Buffer },
      userId: string | null
    ) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        const { data: _data, ...columns } = getTableColumns(deviationFiles);
        const [row] = await tx.insert(deviationFiles).values({ deviationId, ...file, uploadedBy: userId }).returning(columns);
        await event(tx, deviationId, "file_added", { fileId: row!.id, filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 }, userId);
        await touch(tx, deviationId);
        return row!;
      });
    },

    async findFile(deviationId: string, fileId: string) {
      const [row] = await db
        .select()
        .from(deviationFiles)
        .where(and(eq(deviationFiles.id, fileId), eq(deviationFiles.deviationId, deviationId)));
      return row ?? null;
    },

    async removeFile(deviationId: string, fileId: string, userId: string | null) {
      return db.transaction(async (tx) => {
        await lockEditable(tx, deviationId);
        const [row] = await tx
          .delete(deviationFiles)
          .where(and(eq(deviationFiles.id, fileId), eq(deviationFiles.deviationId, deviationId)))
          .returning({ filename: deviationFiles.filename, sha256: deviationFiles.sha256 });
        if (!row) throw new DeviationFileNotFoundError(fileId);
        await event(tx, deviationId, "file_removed", { fileId, filename: row.filename, sha256: row.sha256 }, userId);
        await touch(tx, deviationId);
      });
    },

    // --- history ---

    async listEvents(deviationId: string) {
      return db
        .select({
          id: deviationEvents.id,
          event: deviationEvents.event,
          detail: deviationEvents.detail,
          userName: users.name,
          createdAt: deviationEvents.createdAt,
        })
        .from(deviationEvents)
        .leftJoin(users, eq(users.id, deviationEvents.userId))
        .where(eq(deviationEvents.deviationId, deviationId))
        .orderBy(asc(deviationEvents.createdAt), asc(deviationEvents.id));
    },

    // The e-mail is a history row in any status (sending changes nothing).
    async logEmailSent(deviationId: string, detail: Record<string, unknown>, userId: string | null) {
      await event(db, deviationId, "email_sent", detail, userId);
    },

    // --- leveransprecisionens kvalitetsdel ---

    // The period's cases of one type (not cancelled), with their
    // counterparty and the reklamerat antal in the article's unit.
    async periodDeviations(type: "customer" | "supplier", fromDate: string, toDate: string) {
      const rows = await db
        .select({
          id: deviations.id,
          counterpartyId: type === "customer" ? deviations.customerId : deviations.supplierId,
          counterpartyName: sql<string | null>`coalesce(${customers.name}, ${suppliers.name})`,
          articleId: deviations.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          unitCode: units.code,
          quantity: deviations.quantity,
        })
        .from(deviations)
        .leftJoin(customers, eq(customers.id, deviations.customerId))
        .leftJoin(suppliers, eq(suppliers.id, deviations.supplierId))
        .leftJoin(articles, eq(articles.id, deviations.articleId))
        .leftJoin(units, eq(units.id, articles.unitId))
        .where(
          and(
            eq(deviations.type, type),
            ne(deviations.status, "cancelled"),
            gte(deviations.reportedDate, fromDate),
            lte(deviations.reportedDate, toDate)
          )
        );
      return rows.map((r) => ({ ...r, counterpartyId: r.counterpartyId!, quantity: r.quantity === null ? null : Number(r.quantity) }));
    },

    // Which of these orders carry a case that is not cancelled (any date).
    async ordersWithDeviation(type: "customer" | "supplier", orderIds: string[]): Promise<Set<string>> {
      if (orderIds.length === 0) return new Set();
      const column = type === "customer" ? deviations.salesOrderId : deviations.purchaseOrderId;
      const rows = await db
        .selectDistinct({ orderId: column })
        .from(deviations)
        .where(and(eq(deviations.type, type), ne(deviations.status, "cancelled"), isNotNull(column), inArray(column, orderIds)));
      return new Set(rows.map((r) => r.orderId!));
    },
  };
  return repo;
}

export type QualityRepository = ReturnType<typeof createQualityRepository>;

export interface ListRow {
  id: string;
  deviationNumber: string;
  type: DeviationType;
  status: DeviationStatus;
  title: string;
  reportedDate: string;
  dueDate: string | null;
  customerId: string | null;
  customerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  counterpartyReference: string | null;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  unitCode: string | null;
  quantity: string | null;
  reasonId: string | null;
  reasonCode: string | null;
  reasonName: string | null;
  responsibleUserId: string | null;
  responsibleUserName: string | null;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  manufacturingOrderId: string | null;
  manufacturingOrderNumber: string | null;
  createdAt: Date;
}

export interface DetailRow extends ListRow {
  description: string | null;
  salesOrderRowId: string | null;
  purchaseOrderRowId: string | null;
  moOperationId: string | null;
  moOperationSequenceNo: number | null;
  moOperationWorkCenterName: string | null;
  causeAnalysis: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  decision: "accepted" | "rejected" | null;
  closedAt: Date | null;
  closedByName: string | null;
  cancelledAt: Date | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  createdByName: string | null;
  updatedAt: Date;
  customerNumber: string | null;
  supplierNumber: string | null;
  counterpartyEmail: string | null;
  counterpartyAddress: string | null;
  counterpartyPostalCode: string | null;
  counterpartyCity: string | null;
  counterpartyCountry: string | null;
  customerOrderNumber: string | null;
}

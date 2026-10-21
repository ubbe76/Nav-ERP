import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import { einvoiceTransmissions, invoiceRows, salesOrderRows, salesOrders, systemSettings, users, type Db } from "@navet/db";
import type { EinvoiceStatus } from "@navet/shared";

// E-faktura (Peppol) — the module's own tables and the einvoice_* settings
// keys. Reads of invoices/customers/company_info go through the narrow
// readers the service is given (InvoiceReader/CompanyInfoReader); the one
// cross-module read here is the order link of the invoice rows (BT-10/BT-13
// and OrderLineReference), which no sales read model exposes.

// One status run at a time across API processes (see claimStatusLease);
// the stamp is what runStatusIfDue reads back through the settings.
const STATUS_LEASE_KEY = "einvoice_status_lease_until";
const STATUS_RUN_KEY = "einvoice_last_status_run_at";

export const LIVE_TRANSMISSION_CONSTRAINT = "einvoice_transmissions_live";

export interface TransmissionInsert {
  invoiceId: string;
  provider: string;
  environment: "sandbox" | "production";
  recipientId: string;
  document: Buffer;
  sha256: string;
  createdBy: string | null;
}

export interface TransmissionStatusPatch {
  status: EinvoiceStatus;
  providerInvoiceId?: string | null;
  providerState?: string | null;
  errorMessage?: string | null;
  sentAt?: Date | null;
  statusUpdatedAt?: Date | null;
  lastPolledAt?: Date | null;
}

// A row as the card lists it: never the document itself.
const transmissionColumns = {
  id: einvoiceTransmissions.id,
  invoiceId: einvoiceTransmissions.invoiceId,
  provider: einvoiceTransmissions.provider,
  environment: einvoiceTransmissions.environment,
  recipientId: einvoiceTransmissions.recipientId,
  status: einvoiceTransmissions.status,
  providerInvoiceId: einvoiceTransmissions.providerInvoiceId,
  providerState: einvoiceTransmissions.providerState,
  errorMessage: einvoiceTransmissions.errorMessage,
  sha256: einvoiceTransmissions.sha256,
  startedAt: einvoiceTransmissions.startedAt,
  sentAt: einvoiceTransmissions.sentAt,
  statusUpdatedAt: einvoiceTransmissions.statusUpdatedAt,
  lastPolledAt: einvoiceTransmissions.lastPolledAt,
  createdBy: einvoiceTransmissions.createdBy,
  createdByName: users.name,
};

export function createEinvoiceRepository(db: Db) {
  return {
    // --- Inställningar (system_settings key–value, einvoice_* keys) ---

    async readSettings(): Promise<Map<string, string>> {
      const rows = await db.select().from(systemSettings).where(like(systemSettings.key, "einvoice_%"));
      return new Map(rows.map((r) => [r.key, r.value]));
    },

    async setSetting(key: string, value: string) {
      await db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },

    async deleteSetting(key: string) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    },

    // --- Sändningsloggen ---

    // The `sending` row written BEFORE the access point is called. The
    // partial unique index einvoice_transmissions_live refuses a second
    // live row per invoice — the service maps that violation.
    async insertTransmission(input: TransmissionInsert) {
      const [row] = await db
        .insert(einvoiceTransmissions)
        .values({ ...input, status: "sending" })
        .returning({ id: einvoiceTransmissions.id });
      return row!.id;
    },

    async updateTransmission(id: string, patch: TransmissionStatusPatch) {
      await db.update(einvoiceTransmissions).set(patch).where(eq(einvoiceTransmissions.id, id));
    },

    async findTransmission(id: string) {
      const [row] = await db
        .select(transmissionColumns)
        .from(einvoiceTransmissions)
        .leftJoin(users, eq(users.id, einvoiceTransmissions.createdBy))
        .where(eq(einvoiceTransmissions.id, id));
      return row ?? null;
    },

    async findTransmissionDocument(id: string) {
      const [row] = await db
        .select({ invoiceId: einvoiceTransmissions.invoiceId, document: einvoiceTransmissions.document })
        .from(einvoiceTransmissions)
        .where(eq(einvoiceTransmissions.id, id));
      return row ?? null;
    },

    // Newest first, as the card shows them.
    async listTransmissions(invoiceId: string) {
      return db
        .select(transmissionColumns)
        .from(einvoiceTransmissions)
        .leftJoin(users, eq(users.id, einvoiceTransmissions.createdBy))
        .where(eq(einvoiceTransmissions.invoiceId, invoiceId))
        .orderBy(desc(einvoiceTransmissions.startedAt), desc(einvoiceTransmissions.id));
    },

    // The status job's work list: live rows the access point can still say
    // something about — `sending` with a provider id, and `sent` — started
    // after `since` (a transmission never registered is not polled forever).
    async listPollable(since: Date): Promise<string[]> {
      const rows = await db
        .select({ id: einvoiceTransmissions.id })
        .from(einvoiceTransmissions)
        .where(
          and(
            gt(einvoiceTransmissions.startedAt, since),
            isNotNull(einvoiceTransmissions.providerInvoiceId),
            inArray(einvoiceTransmissions.status, ["sending", "sent"])
          )
        )
        .orderBy(asc(einvoiceTransmissions.startedAt));
      return rows.map((r) => r.id);
    },

    // A `sending` row without a provider id older than `olderThan` is a send
    // whose process died between the insert and the answer: marked failed so
    // the invoice can be sent again. Returns what it changed (for the log).
    async failStaleSending(olderThan: Date, message: string, at: Date) {
      return db
        .update(einvoiceTransmissions)
        .set({ status: "failed", errorMessage: message, statusUpdatedAt: at })
        .where(
          and(
            eq(einvoiceTransmissions.status, "sending"),
            isNull(einvoiceTransmissions.providerInvoiceId),
            lt(einvoiceTransmissions.startedAt, olderThan)
          )
        )
        .returning({ id: einvoiceTransmissions.id, invoiceId: einvoiceTransmissions.invoiceId });
    },

    // The order side of an invoice's rows, in row order: which order each
    // row settles (BT-13/BT-10 come from the FIRST linked order, the
    // OrderLineReference from each). Free rows have no order.
    async invoiceRowOrders(invoiceId: string) {
      return db
        .select({
          rowId: invoiceRows.id,
          salesOrderRowId: invoiceRows.salesOrderRowId,
          orderNumber: salesOrders.orderNumber,
          customerOrderNumber: salesOrders.customerOrderNumber,
          customerReference: salesOrders.customerReference,
          // Position of the order row within its order (Nav has no stored
          // line numbers): 1-based by creation order.
          orderLineNo: sql<number | null>`(
            select count(*)::int from ${salesOrderRows} r2
            where r2.sales_order_id = ${salesOrderRows.salesOrderId}
              and (r2.created_at, r2.id) <= (${salesOrderRows.createdAt}, ${salesOrderRows.id}))`,
        })
        .from(invoiceRows)
        .leftJoin(salesOrderRows, eq(salesOrderRows.id, invoiceRows.salesOrderRowId))
        .leftJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .where(eq(invoiceRows.invoiceId, invoiceId))
        .orderBy(asc(invoiceRows.createdAt));
    },

    // --- Statusjobbets lease (same atomic-upsert pattern as freight tracking) ---

    async claimStatusLease(now: Date, ttlMs: number): Promise<string | null> {
      const until = new Date(now.getTime() + ttlMs).toISOString();
      const rows = await db.execute(sql`
        INSERT INTO system_settings (key, value) VALUES (${STATUS_LEASE_KEY}, ${until})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        WHERE system_settings.value = '' OR system_settings.value::timestamptz <= ${now.toISOString()}::timestamptz
        RETURNING key`);
      return rows.length > 0 ? until : null;
    },

    // Owner-checked: only the run that wrote `until` releases.
    async releaseStatusLease(until: string) {
      await db.delete(systemSettings).where(and(eq(systemSettings.key, STATUS_LEASE_KEY), eq(systemSettings.value, until)));
    },

    async stampStatusRun(at: Date) {
      await db
        .insert(systemSettings)
        .values({ key: STATUS_RUN_KEY, value: at.toISOString() })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: at.toISOString() } });
    },
  };
}

export type EinvoiceRepository = ReturnType<typeof createEinvoiceRepository>;
export type TransmissionRow = NonNullable<Awaited<ReturnType<EinvoiceRepository["findTransmission"]>>>;

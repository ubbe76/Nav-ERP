import { alias } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, like, ne, notInArray, or, sql } from "drizzle-orm";
import {
  articles,
  articleSuppliers,
  invoiceScanHints,
  invoiceScanMailLog,
  invoiceScans,
  numberSeries,
  purchaseOrderRows,
  purchaseOrders,
  supplierInvoiceFiles,
  supplierInvoiceRows,
  supplierContacts,
  supplierInvoices,
  suppliers,
  systemSettings,
  users,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type InvoiceScanHintField, type InvoiceScanMailOutcome, type InvoiceScanSource, type InvoiceScanStatus, type ListInvoiceScansQuery } from "@navet/shared";
import { getNextOrderNumber, NumberSeriesNotConfiguredError } from "../../system/service/number-series.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";

// Fakturaskanning — the inbox's repository (spec §1). Listings never select
// `data`; the file is read on its own (readFile) or under the conversion's
// FOR UPDATE.

export const INVOICE_SCAN_SERIES = { key: "invoice_scan", prefix: "FI-" } as const;
const SHA256_INDEX = "invoice_scans_sha256_live";
// The e-mail job's own keys in system_settings (never written by the
// settings' update()).
const MAIL_LEASE_KEY = "invoice_scan_mail_lease_until";
const MAIL_RUN_KEY = "invoice_scan_mail_last_run_at";
const MAIL_ERROR_KEY = "invoice_scan_mail_last_error";
const MAIL_SUCCESS_KEY = "invoice_scan_mail_last_success_at";
// Automatic AI calls on the current Stockholm day ("YYYY-MM-DD|n").
const AI_AUTO_COUNT_KEY = "invoice_scan_ai_auto_count";
// At most this many learned labels per supplier and field.
export const MAX_HINTS_PER_FIELD = 5;
// An AI reservation older than this is taken over (a process that died
// mid-call). Longer than the client's worst case: 120 s timeout × 3 attempts
// plus backoff.
export const AI_RESERVATION_STALE_MINUTES = 10;

const PENDING: InvoiceScanStatus[] = ["new", "interpreted"];
const LIST_STATUSES: Record<ListInvoiceScansQuery["status"], InvoiceScanStatus[] | null> = {
  pending: PENDING,
  converted: ["converted"],
  rejected: ["rejected"],
  all: null,
};

// Every column except the file itself.
const { data: _data, ...scanColumns } = getTableColumns(invoiceScans);

// The matched supplier and the read invoice number/amount out of the result
// jsonb, for the list and its search.
const matchedSupplierIdSql = sql`NULLIF(${invoiceScans.result} #>> '{supplier,matchedSupplierId}', '')::uuid`;
const interpretedInvoiceNumberSql = sql<string | null>`${invoiceScans.result} #>> '{invoiceNumber,value}'`;

export type InvoiceScanRow = Omit<typeof invoiceScans.$inferSelect, "data">;

export interface ExistingScan {
  id: string;
  scanNumber: string;
  status: InvoiceScanStatus;
}

// FI- number: getNextOrderNumber on the transaction, the series created on
// first use when it is missing (self-healing, like the SIE import's LÖ).
async function nextScanNumber(tx: Tx): Promise<string> {
  try {
    return await getNextOrderNumber(tx, INVOICE_SCAN_SERIES.key);
  } catch (err) {
    if (!(err instanceof NumberSeriesNotConfiguredError)) throw err;
    await tx
      .insert(numberSeries)
      .values({ key: INVOICE_SCAN_SERIES.key, prefix: INVOICE_SCAN_SERIES.prefix, nextNumber: 1, digits: 0 })
      .onConflictDoNothing();
    return getNextOrderNumber(tx, INVOICE_SCAN_SERIES.key);
  }
}

async function findLiveBySha(db: Db | Tx, sha256: string): Promise<ExistingScan | null> {
  const [row] = await db
    .select({ id: invoiceScans.id, scanNumber: invoiceScans.scanNumber, status: invoiceScans.status })
    .from(invoiceScans)
    .where(and(eq(invoiceScans.sha256, sha256), ne(invoiceScans.status, "rejected")));
  return row ?? null;
}

async function findByEmailKey(db: Db | Tx, messageId: string, attachmentIndex: number): Promise<ExistingScan | null> {
  const [row] = await db
    .select({ id: invoiceScans.id, scanNumber: invoiceScans.scanNumber, status: invoiceScans.status })
    .from(invoiceScans)
    .where(and(eq(invoiceScans.emailMessageId, messageId), eq(invoiceScans.emailAttachmentIndex, attachmentIndex)));
  return row ?? null;
}

export interface NewScanInput {
  source: InvoiceScanSource;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  data: Buffer;
  uploadedBy: string | null;
  // E-post: the idempotency key (Message-ID, attachment index) and the
  // letter's headers.
  email?: {
    messageId: string;
    attachmentIndex: number;
    from: string | null;
    subject: string | null;
    receivedAt: Date | null;
  };
}

export type InsertScanOutcome =
  | { ok: true; scan: InvoiceScanRow }
  // The same file is live in the inbox (the dubblettspärr on sha256).
  | { ok: false; reason: "duplicate"; existing: ExistingScan }
  // This letter's attachment was imported by an earlier run (the move to
  // the processed folder failed and the letter was read again).
  | { ok: false; reason: "already_imported"; existing: ExistingScan };

class AlreadyImported extends Error {}

// A new scan (status new) with its FI- number, inside the caller's
// transaction but in a SAVEPOINT of its own: a duplicate (the partial unique
// index on sha256) or an attachment already imported (ON CONFLICT on the
// e-mail key) rolls back to it, so the FI- number is not burned and the
// caller's transaction goes on.
async function insertScanInTx(tx: Tx, input: NewScanInput): Promise<InsertScanOutcome> {
  const { email, ...file } = input;
  try {
    const scan = await tx.transaction(async (sp) => {
      const scanNumber = await nextScanNumber(sp);
      const values = {
        ...file,
        scanNumber,
        status: "new" as const,
        ...(email
          ? {
              emailMessageId: email.messageId,
              emailAttachmentIndex: email.attachmentIndex,
              emailFrom: email.from,
              emailSubject: email.subject,
              emailReceivedAt: email.receivedAt,
            }
          : {}),
      };
      const insert = sp.insert(invoiceScans).values(values);
      const rows = email
        ? await insert
            .onConflictDoNothing({
              target: [invoiceScans.emailMessageId, invoiceScans.emailAttachmentIndex],
              where: sql`email_message_id IS NOT NULL`,
            })
            .returning(scanColumns)
        : await insert.returning(scanColumns);
      if (rows.length === 0) throw new AlreadyImported();
      return rows[0]!;
    });
    return { ok: true, scan };
  } catch (err) {
    if (err instanceof AlreadyImported && email) {
      const existing = await findByEmailKey(tx, email.messageId, email.attachmentIndex);
      if (existing) return { ok: false, reason: "already_imported", existing };
      throw err;
    }
    if (!isUniqueViolation(err, SHA256_INDEX)) throw err;
    // The live scan was rejected or deleted in between: report it as a
    // duplicate of nothing rather than retrying blindly.
    const existing = await findLiveBySha(tx, input.sha256);
    if (!existing) throw err;
    return { ok: false, reason: "duplicate", existing };
  }
}

// The created supplier invoice's supplier (a converted scan shows what was
// created, not the proposal).
const createdSuppliers = alias(suppliers, "created_suppliers");

// The created supplier invoice's values, for a converted scan.
const createdColumns = {
  createdSupplierId: supplierInvoices.supplierId,
  createdSupplierName: createdSuppliers.name,
  createdInvoiceNumber: supplierInvoices.invoiceNumber,
  createdInvoiceDate: supplierInvoices.invoiceDate,
  createdGrossAmount: supplierInvoices.grossAmount,
  createdCurrency: supplierInvoices.currency,
};

export function createInvoiceScanRepository(db: Db) {
  // The list's columns: the scan without its file, the matched supplier's
  // name and the created supplier invoice's LF- number and values.
  const listSelect = () =>
    db
      .select({
        ...scanColumns,
        supplierName: suppliers.name,
        supplierInvoiceRegistrationNumber: supplierInvoices.registrationNumber,
        ...createdColumns,
      })
      .from(invoiceScans)
      .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
      .leftJoin(supplierInvoices, eq(supplierInvoices.id, invoiceScans.supplierInvoiceId))
      .leftJoin(createdSuppliers, eq(createdSuppliers.id, supplierInvoices.supplierId));

  return {
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },

    // An uploaded file as a new scan (status new) with its FI- number, in
    // one transaction so a duplicate does not burn a number. The
    // dubblettspärr is the partial unique index on sha256 — its violation
    // answers with the live scan.
    async insert(input: Omit<NewScanInput, "email">): Promise<{ ok: true; scan: InvoiceScanRow } | { ok: false; existing: ExistingScan }> {
      const outcome = await db.transaction((tx) => insertScanInTx(tx, input));
      return outcome.ok ? outcome : { ok: false, existing: outcome.existing };
    },

    // --- E-postlådan (spec §4) ---

    // One letter's scans and its log row in the caller's transaction.
    insertScanInTx,

    async insertMailLogInTx(
      tx: Tx,
      row: {
        messageId: string | null;
        emailFrom: string | null;
        emailSubject: string | null;
        receivedAt: Date | null;
        outcome: InvoiceScanMailOutcome;
        detail: string | null;
        scanIds: string[];
      }
    ) {
      await tx.insert(invoiceScanMailLog).values(row);
    },

    // Senast lästa brev: the newest first.
    async listMailLog(limit: number) {
      const rows = await db
        .select()
        .from(invoiceScanMailLog)
        .orderBy(desc(invoiceScanMailLog.runAt), desc(invoiceScanMailLog.id))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        runAt: r.runAt.toISOString(),
        messageId: r.messageId,
        emailFrom: r.emailFrom,
        emailSubject: r.emailSubject,
        receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
        outcome: r.outcome,
        detail: r.detail,
        scanIds: r.scanIds,
      }));
    },

    // The job's lease (same atomic-upsert pattern as the e-invoice status
    // job): a run holds it at most ttlMs; one that dies lets it expire.
    async claimMailLease(now: Date, ttlMs: number): Promise<string | null> {
      const until = new Date(now.getTime() + ttlMs).toISOString();
      const rows = await db.execute(sql`
        INSERT INTO system_settings (key, value) VALUES (${MAIL_LEASE_KEY}, ${until})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        WHERE system_settings.value = '' OR system_settings.value::timestamptz <= ${now.toISOString()}::timestamptz
        RETURNING key`);
      return rows.length > 0 ? until : null;
    },

    // Extends the run's lease to `next`, only while it is still `until` (ours):
    // the new value, or null when another run has taken over.
    async renewMailLease(until: string, next: Date): Promise<string | null> {
      const value = next.toISOString();
      const rows = await db
        .update(systemSettings)
        .set({ value })
        .where(and(eq(systemSettings.key, MAIL_LEASE_KEY), eq(systemSettings.value, until)))
        .returning({ key: systemSettings.key });
      return rows.length > 0 ? value : null;
    },

    // Owner-checked: only the run that wrote `until` releases.
    async releaseMailLease(until: string) {
      await db.delete(systemSettings).where(and(eq(systemSettings.key, MAIL_LEASE_KEY), eq(systemSettings.value, until)));
    },

    // After every run: when it ran, and its error as Swedish text (null =
    // it went through, which also stamps the last successful read).
    async stampMailRun(at: Date, error: string | null) {
      const upsert = (key: string, value: string) =>
        db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
      await upsert(MAIL_RUN_KEY, at.toISOString());
      if (error === null) {
        await db.delete(systemSettings).where(eq(systemSettings.key, MAIL_ERROR_KEY));
        await upsert(MAIL_SUCCESS_KEY, at.toISOString());
      } else {
        await upsert(MAIL_ERROR_KEY, error);
      }
    },

    async list(query: ListInvoiceScansQuery) {
      const conditions = [];
      const statuses = LIST_STATUSES[query.status];
      if (statuses) conditions.push(inArray(invoiceScans.status, statuses));
      if (query.source) conditions.push(eq(invoiceScans.source, query.source));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(invoiceScans.filename, pattern),
            ilike(invoiceScans.scanNumber, pattern),
            ilike(invoiceScans.emailFrom, pattern),
            ilike(invoiceScans.emailSubject, pattern),
            ilike(suppliers.name, pattern),
            sql`${interpretedInvoiceNumberSql} ILIKE ${pattern}`,
            // A converted scan: the created supplier invoice's values.
            ilike(createdSuppliers.name, pattern),
            ilike(supplierInvoices.invoiceNumber, pattern)
          )
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totals] = await Promise.all([
        listSelect()
          .where(where)
          .orderBy(desc(invoiceScans.createdAt), desc(invoiceScans.scanNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(invoiceScans)
          .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
          .leftJoin(supplierInvoices, eq(supplierInvoices.id, invoiceScans.supplierInvoiceId))
          .leftJoin(createdSuppliers, eq(createdSuppliers.id, supplierInvoices.supplierId))
          .where(where),
      ]);
      return { rows, total: totals[0]!.total };
    },

    // One scan as a list row (the upload's answer).
    async listRow(id: string) {
      const [row] = await listSelect().where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    async findById(id: string) {
      const rejectedByUsers = users;
      const [row] = await db
        .select({
          ...scanColumns,
          supplierName: suppliers.name,
          supplierInvoiceRegistrationNumber: supplierInvoices.registrationNumber,
          rejectedByName: rejectedByUsers.name,
          ...createdColumns,
        })
        .from(invoiceScans)
        .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
        .leftJoin(supplierInvoices, eq(supplierInvoices.id, invoiceScans.supplierInvoiceId))
        .leftJoin(createdSuppliers, eq(createdSuppliers.id, supplierInvoices.supplierId))
        .leftJoin(rejectedByUsers, eq(rejectedByUsers.id, invoiceScans.rejectedBy))
        .where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    // The scan with its file (only while it is not converted).
    async findWithData(id: string) {
      const [row] = await db.select().from(invoiceScans).where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    // The file: from the scan, or from supplier_invoice_files once the
    // conversion moved it there.
    async readFile(id: string): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
      const [row] = await db
        .select({
          filename: invoiceScans.filename,
          contentType: invoiceScans.contentType,
          data: invoiceScans.data,
          movedData: supplierInvoiceFiles.data,
        })
        .from(invoiceScans)
        .leftJoin(supplierInvoiceFiles, eq(supplierInvoiceFiles.id, invoiceScans.supplierInvoiceFileId))
        .where(eq(invoiceScans.id, id));
      if (!row) return null;
      const data = row.data ?? row.movedData;
      return data ? { filename: row.filename, contentType: row.contentType, data } : null;
    },

    // A new result, only while the scan is pending (a concurrent Avvisa or
    // Skapa wins). `status` = interpreted, or the current status when the
    // extraction crashed (the result then only carries the check).
    async writeResult(
      id: string,
      write: {
        result: unknown;
        interpretedBy: "rules" | "ai" | null;
        hasTextLayer: boolean | null;
        pageCount: number | null;
        interpreted: boolean;
      }
    ): Promise<InvoiceScanRow | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({
          result: write.result,
          hasTextLayer: write.hasTextLayer,
          pageCount: write.pageCount,
          ...(write.interpreted
            ? { status: "interpreted" as const, interpretedBy: write.interpretedBy, interpretedAt: new Date() }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // --- AI-tolkningen (spec §3.5): no transaction over HTTP ---

    // Reserves the scan for one AI call: an atomic UPDATE that only takes a
    // pending scan without a live reservation (a stale one — a process that
    // died mid-call — is taken over after AI_RESERVATION_STALE_MINUTES).
    // The reservation value is set from the app (millisecond precision) so
    // the conditional writes below compare it exactly. null = not reserved.
    async reserveAi(id: string, at: Date): Promise<Date | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({ aiStartedAt: at })
        .where(
          and(
            eq(invoiceScans.id, id),
            inArray(invoiceScans.status, PENDING),
            or(
              isNull(invoiceScans.aiStartedAt),
              sql`${invoiceScans.aiStartedAt} < now() - make_interval(mins => ${AI_RESERVATION_STALE_MINUTES})`
            )
          )
        )
        .returning({ aiStartedAt: invoiceScans.aiStartedAt });
      return row?.aiStartedAt ?? null;
    },

    // The AI's result, only when the reservation is still ours and the scan
    // still pending — a concurrent Avvisa/Skapa (which clear ai_started_at)
    // wins and the answer is dropped. The reservation is released in the
    // same UPDATE; aiError carries the truncation note or null.
    async writeAiResult(
      id: string,
      reservedAt: Date,
      write: { result: unknown; aiError: string | null; hasTextLayer: boolean | null; pageCount: number | null }
    ): Promise<InvoiceScanRow | null> {
      const now = new Date();
      const [row] = await db
        .update(invoiceScans)
        .set({
          result: write.result,
          hasTextLayer: write.hasTextLayer,
          pageCount: write.pageCount,
          status: "interpreted",
          interpretedBy: "ai",
          interpretedAt: now,
          aiError: write.aiError,
          aiStartedAt: null,
          updatedAt: now,
        })
        .where(and(eq(invoiceScans.id, id), eq(invoiceScans.aiStartedAt, reservedAt), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // A failed AI call: the Swedish text, on the same condition; the
    // previous result stays.
    async writeAiError(id: string, reservedAt: Date, aiError: string): Promise<InvoiceScanRow | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({ aiError: aiError.slice(0, 200), aiStartedAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceScans.id, id), eq(invoiceScans.aiStartedAt, reservedAt), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // Avsändarregeln: the e-mail addresses that may trigger automatic AI —
    // active suppliers' and their contacts' (the domain counts), and the
    // company's active users' (only the exact address counts).
    async knownSenderAddresses(): Promise<{ suppliers: string[]; users: string[] }> {
      const [own, contacts, people] = await Promise.all([
        db.select({ email: suppliers.email }).from(suppliers).where(and(eq(suppliers.active, true), isNotNull(suppliers.email))),
        db
          .select({ email: supplierContacts.email })
          .from(supplierContacts)
          .innerJoin(suppliers, eq(suppliers.id, supplierContacts.supplierId))
          .where(and(eq(suppliers.active, true), isNotNull(supplierContacts.email))),
        db.select({ email: users.email }).from(users).where(eq(users.active, true)),
      ]);
      const present = (rows: { email: string | null }[]) => rows.map((r) => r.email).filter((e): e is string => e !== null && e !== "");
      return { suppliers: present([...own, ...contacts]), users: present(people) };
    },

    // Dagens tak för automatisk AI-tolkning: one atomic upsert counts the
    // call on the Stockholm day `day` ("YYYY-MM-DD|n" in system_settings) —
    // a new day starts over at 1. false (nothing written) when the day's
    // count already is `max`.
    async claimAutomaticAiCall(day: string, max: number): Promise<boolean> {
      const rows = await db.execute(sql`
        INSERT INTO system_settings (key, value) VALUES (${AI_AUTO_COUNT_KEY}, ${`${day}|1`})
        ON CONFLICT (key) DO UPDATE SET value = CASE
            WHEN split_part(system_settings.value, '|', 1) = ${day}
              THEN ${day} || '|' || (COALESCE(NULLIF(split_part(system_settings.value, '|', 2), ''), '0')::int + 1)::text
            ELSE ${`${day}|1`}
          END
        WHERE split_part(system_settings.value, '|', 1) <> ${day}
           OR COALESCE(NULLIF(split_part(system_settings.value, '|', 2), ''), '0')::int < ${max}
        RETURNING key`);
      return rows.length > 0;
    },

    async reject(id: string, reason: string, userId: string | null): Promise<InvoiceScanRow | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), rejectedBy: userId, aiStartedAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // Återställ: back to new, or interpreted when an interpretation
    // succeeded on it. The dubblettspärr applies again — the same file
    // uploaded after the rejection makes this a duplicate.
    async restore(id: string): Promise<{ ok: true; scan: InvoiceScanRow } | { ok: false; reason: "status" } | { ok: false; reason: "duplicate"; existing: ExistingScan }> {
      const [current] = await db.select({ sha256: invoiceScans.sha256 }).from(invoiceScans).where(eq(invoiceScans.id, id));
      try {
        const [row] = await db
          .update(invoiceScans)
          .set({
            status: sql`CASE WHEN ${invoiceScans.interpretedBy} IS NULL THEN 'new' ELSE 'interpreted' END::invoice_scan_status`,
            rejectedReason: null,
            rejectedAt: null,
            rejectedBy: null,
            updatedAt: new Date(),
          })
          .where(and(eq(invoiceScans.id, id), eq(invoiceScans.status, "rejected")))
          .returning(scanColumns);
        return row ? { ok: true, scan: row } : { ok: false, reason: "status" };
      } catch (err) {
        if (!isUniqueViolation(err, SHA256_INDEX) || !current) throw err;
        const existing = await findLiveBySha(db, current.sha256);
        if (!existing) throw err;
        return { ok: false, reason: "duplicate", existing };
      }
    },

    // Only a rejected scan is deleted (the service's räkenskapsinformation
    // rule); the conditional DELETE closes the race with Återställ.
    async deleteRejected(id: string) {
      const [row] = await db
        .delete(invoiceScans)
        .where(and(eq(invoiceScans.id, id), eq(invoiceScans.status, "rejected")))
        .returning({
          scanNumber: invoiceScans.scanNumber,
          filename: invoiceScans.filename,
          sha256: invoiceScans.sha256,
          rejectedReason: invoiceScans.rejectedReason,
        });
      return row ?? null;
    },

    // --- The conversion (inside the caller's transaction) ---

    async lockInTx(tx: Tx, id: string) {
      const [row] = await tx.select().from(invoiceScans).where(eq(invoiceScans.id, id)).for("update");
      return row ?? null;
    },

    async insertInvoiceFileInTx(
      tx: Tx,
      input: { supplierInvoiceId: string; filename: string; contentType: string; sizeBytes: number; sha256: string; data: Buffer; uploadedBy: string | null }
    ) {
      const { data: _fileData, ...columns } = getTableColumns(supplierInvoiceFiles);
      const [row] = await tx.insert(supplierInvoiceFiles).values(input).returning(columns);
      return row!;
    },

    async markConvertedInTx(tx: Tx, id: string, link: { supplierInvoiceId: string; supplierInvoiceFileId: string }) {
      const [row] = await tx
        .update(invoiceScans)
        .set({
          status: "converted",
          supplierInvoiceId: link.supplierInvoiceId,
          supplierInvoiceFileId: link.supplierInvoiceFileId,
          data: null,
          aiStartedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // Leverantörsinlärningen: hits + 1 on a known label, then keep the
    // MAX_HINTS_PER_FIELD most recently used per field.
    async upsertHintsInTx(tx: Tx, supplierId: string, hints: { field: InvoiceScanHintField; label: string }[]) {
      if (hints.length === 0) return;
      const now = new Date();
      for (const hint of hints) {
        await tx
          .insert(invoiceScanHints)
          .values({ supplierId, field: hint.field, label: hint.label, hits: 1, lastUsedAt: now })
          .onConflictDoUpdate({
            target: [invoiceScanHints.supplierId, invoiceScanHints.field, invoiceScanHints.label],
            set: { hits: sql`${invoiceScanHints.hits} + 1`, lastUsedAt: now },
          });
      }
      const fields = [...new Set(hints.map((h) => h.field))];
      for (const fieldName of fields) {
        const keep = tx
          .select({ id: invoiceScanHints.id })
          .from(invoiceScanHints)
          .where(and(eq(invoiceScanHints.supplierId, supplierId), eq(invoiceScanHints.field, fieldName)))
          .orderBy(desc(invoiceScanHints.lastUsedAt), desc(invoiceScanHints.hits), asc(invoiceScanHints.label))
          .limit(MAX_HINTS_PER_FIELD);
        await tx
          .delete(invoiceScanHints)
          .where(and(eq(invoiceScanHints.supplierId, supplierId), eq(invoiceScanHints.field, fieldName), notInArray(invoiceScanHints.id, keep)));
      }
    },

    async hintsFor(supplierId: string) {
      return db
        .select({ field: invoiceScanHints.field, label: invoiceScanHints.label, hits: invoiceScanHints.hits })
        .from(invoiceScanHints)
        .where(eq(invoiceScanHints.supplierId, supplierId))
        .orderBy(desc(invoiceScanHints.hits), desc(invoiceScanHints.lastUsedAt));
    },

    // --- What the rules read ---

    // The five identifier columns (+ name, currency, country) of the active
    // suppliers — never the whole register.
    async supplierIdentities() {
      return db
        .select({
          id: suppliers.id,
          name: suppliers.name,
          orgNumber: suppliers.orgNumber,
          vatNumber: suppliers.vatNumber,
          bankgiro: suppliers.bankgiro,
          plusgiro: suppliers.plusgiro,
          iban: suppliers.iban,
          currency: suppliers.currency,
          country: suppliers.country,
        })
        .from(suppliers)
        .where(eq(suppliers.active, true));
    },

    // Dubblett: the supplier already has a (non-cancelled) supplier invoice
    // with this number. A cancelled one still holds the unique key, so it
    // counts too.
    async findSupplierInvoiceByNumber(supplierId: string, invoiceNumber: string) {
      const [row] = await db
        .select({ id: supplierInvoices.id, registrationNumber: supplierInvoices.registrationNumber })
        .from(supplierInvoices)
        .where(and(eq(supplierInvoices.supplierId, supplierId), eq(supplierInvoices.invoiceNumber, invoiceNumber)));
      return row ?? null;
    },

    async purchaseOrderNumber(id: string): Promise<string | null> {
      const [row] = await db.select({ orderNumber: purchaseOrders.orderNumber }).from(purchaseOrders).where(eq(purchaseOrders.id, id));
      return row?.orderNumber ?? null;
    },

    async purchaseOrderPrefix(): Promise<string> {
      const [row] = await db.select({ prefix: numberSeries.prefix }).from(numberSeries).where(eq(numberSeries.key, "purchase_order"));
      return row?.prefix ?? "";
    },

    // The supplier's orders with goods received (the Skapa dialog's Hämta
    // från inköpsorder), each with whether every received quantity is
    // already invoiced by live supplier invoices.
    async receivedPurchaseOrders(supplierId: string) {
      const rows = await db
        .select({
          id: purchaseOrders.id,
          orderNumber: purchaseOrders.orderNumber,
          createdAt: purchaseOrders.createdAt,
          // Qualified by hand: drizzle renders a column without its table in
          // a single-table select, which the subquery would capture.
          fullyInvoiced: sql<boolean>`NOT EXISTS (
            SELECT 1 FROM ${purchaseOrderRows} por
            WHERE por.purchase_order_id = purchase_orders.id
              AND por.quantity_received > COALESCE((
                SELECT SUM(sir.quantity) FROM ${supplierInvoiceRows} sir
                JOIN ${supplierInvoices} si ON si.id = sir.supplier_invoice_id
                WHERE sir.purchase_order_row_id = por.id AND si.status <> 'cancelled'
              ), 0)
          )`,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.supplierId, supplierId),
            inArray(purchaseOrders.status, ["partially_received", "received", "closed"])
          )
        );
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },

    // The order's rows for the row matching: our and the supplier's article
    // number, the price and what is received but not yet invoiced.
    async purchaseOrderRowsForMatch(purchaseOrderId: string, supplierId: string) {
      const rows = await db
        .select({
          id: purchaseOrderRows.id,
          articleId: purchaseOrderRows.articleId,
          articleNumber: articles.articleNumber,
          supplierArticleNumber: articleSuppliers.supplierArticleNumber,
          unitPrice: purchaseOrderRows.unitPrice,
          quantityReceived: purchaseOrderRows.quantityReceived,
          invoiced: sql<string>`COALESCE((
            SELECT SUM(sir.quantity) FROM ${supplierInvoiceRows} sir
            JOIN ${supplierInvoices} si ON si.id = sir.supplier_invoice_id
            WHERE sir.purchase_order_row_id = purchase_order_rows.id AND si.status <> 'cancelled'
          ), 0)`,
        })
        .from(purchaseOrderRows)
        .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
        .leftJoin(
          articleSuppliers,
          and(eq(articleSuppliers.articleId, purchaseOrderRows.articleId), eq(articleSuppliers.supplierId, supplierId))
        )
        .where(eq(purchaseOrderRows.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(purchaseOrderRows.createdAt));
      return rows.map((r) => ({
        id: r.id,
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        supplierArticleNumber: r.supplierArticleNumber,
        unitPrice: Number(r.unitPrice),
        openQuantity: Math.max(0, Number(r.quantityReceived) - Number(r.invoiced)),
      }));
    },

    // --- Settings (invoice_scan_* in system_settings) ---

    async readSettings(): Promise<Map<string, string>> {
      const rows = await db.select().from(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
      return new Map(rows.map((r) => [r.key, r.value]));
    },

    async setSetting(key: string, value: string) {
      await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },

    async deleteSetting(key: string) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    },
  };
}

export type InvoiceScanRepository = ReturnType<typeof createInvoiceScanRepository>;

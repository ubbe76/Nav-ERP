import { and, count, desc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";
import { emailLog, invoices, type Db } from "@navet/db";
import {
  ilikePattern,
  type EmailDocumentType,
  type EmailLinkKind,
  type EmailStatus,
  type ListEmailLogQuery,
} from "@navet/shared";

export interface NewEmailLogEntry {
  documentType: EmailDocumentType;
  documentId: string | null;
  recipient: string;
  subject: string;
  message: string;
  attachDrawings: boolean;
  // Konfigurator 4b: Visa tilläggspriser as sent; null = not applicable.
  showConfigurationPrices: boolean | null;
  // Avvikelser: the reklamationsrapport's details choice; null = not applicable.
  includeDetails?: boolean | null;
  status: EmailStatus;
  error: string | null;
}

export function createMailRepository(db: Db) {
  return {
    // Append-only: every SMTP attempt gets a row, successful or not.
    async logEmail(entry: NewEmailLogEntry) {
      const [row] = await db.insert(emailLog).values(entry).returning();
      return row!;
    },

    async findById(id: string) {
      const [row] = await db.select().from(emailLog).where(eq(emailLog.id, id));
      return row ?? null;
    },

    async listEmailLog(query: ListEmailLogQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(emailLog.recipient, pattern), ilike(emailLog.subject, pattern)));
      }
      if (query.status) conditions.push(inArray(emailLog.status, query.status));
      if (query.documentType) conditions.push(eq(emailLog.documentType, query.documentType));
      if (query.documentId) conditions.push(eq(emailLog.documentId, query.documentId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // "invoice" rows are the only ambiguous ones (see EmailLinkKind) — a
      // left join against invoices.id tells them apart from the id without
      // needing a migration on the documentType enum. Joining on the id
      // alone (rather than also gating on documentType) is fine: ids are
      // random uuids from separate defaultRandom() sequences, so a
      // cross-entity collision isn't a real risk, and non-invoice rows fall
      // straight through to their own documentType in the CASE below.
      // ::text on the fall-through branch — the CASE otherwise tries to unify
      // text literals with the email_document_type enum and Postgres refuses.
      const linkKind = sql<EmailLinkKind>`case when ${emailLog.documentType} = 'invoice'
        then case when ${invoices.id} is not null then 'invoice' else 'sales_order' end
        else ${emailLog.documentType}::text end`.as("link_kind");

      const [rows, totalRows] = await Promise.all([
        db
          .select({ ...getTableColumns(emailLog), linkKind })
          .from(emailLog)
          .leftJoin(invoices, eq(invoices.id, emailLog.documentId))
          .where(where)
          .orderBy(desc(emailLog.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(emailLog).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },
  };
}

export type MailRepository = ReturnType<typeof createMailRepository>;

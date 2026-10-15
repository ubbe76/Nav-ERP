import { and, count, desc, eq, gte, ilike, lte, or } from "drizzle-orm";
import { auditLog, users, type Db } from "@navet/db";
import { ilikePattern, type ListAuditLogQuery } from "@navet/shared";

// One append-only audit entry. `entityId` is a varchar rather than a uuid so
// non-row entities can be addressed too (a payroll period is identified by
// "2026-05", not by its row id).
export interface AuditEntry {
  entityType: string;
  entityId: string | null;
  action: string;
  detail?: unknown;
  userId?: string | null;
}

// Structural dependency for services that write audit entries — keeps them
// from importing the system module's repository directly (same trick as
// RegisterReferenceReader/StockBalanceReader), and makes them trivially
// stubbable in tests.
export interface AuditWriter {
  log(entry: AuditEntry): Promise<void>;
}

// One row of the read side (G1's Agent 3), joined with the acting user's
// name — a plain LEFT JOIN on users.id, deliberately NOT filtered by
// deletedAt, so a soft-deleted user's name still resolves for old entries
// (see CLAUDE.md). userName is null both for system-attributed entries
// (userId null) and for a user row that no longer exists (the FK is
// ON DELETE SET NULL, so that case is rare but stays correct either way).
export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  detail: unknown;
  userId: string | null;
  userName: string | null;
  createdAt: Date;
}

// Own file rather than an addition to system.repository.ts: the audit trail
// is written by every module (payroll first, the rest with block G1) and has
// nothing to do with company info/number series/settings.
export function createAuditRepository(db: Db) {
  return {
    async log(entry: AuditEntry) {
      await db.insert(auditLog).values({
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        detail: entry.detail ?? null,
        userId: entry.userId ?? null,
      });
    },

    // Read side (GET /audit-log): the central admin page's filtered list AND
    // the card-mounted AuditTrailSection's per-entity fetch both go through
    // this one query — the card just supplies entityType+entityId and a
    // small limit, no offset/paging UI of its own.
    async listAuditLog(query: ListAuditLogQuery): Promise<{ rows: AuditLogEntry[]; total: number }> {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(auditLog.entityId, pattern), ilike(auditLog.action, pattern)));
      }
      if (query.entityType) conditions.push(eq(auditLog.entityType, query.entityType));
      if (query.entityId) conditions.push(eq(auditLog.entityId, query.entityId));
      if (query.userId) conditions.push(eq(auditLog.userId, query.userId));
      // Date-only filters — the whole day for `to`, so an event at 23:59 on
      // the end date isn't silently cut off by a midnight boundary.
      if (query.from) conditions.push(gte(auditLog.createdAt, new Date(`${query.from}T00:00:00`)));
      if (query.to) conditions.push(lte(auditLog.createdAt, new Date(`${query.to}T23:59:59.999`)));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: auditLog.id,
            entityType: auditLog.entityType,
            entityId: auditLog.entityId,
            action: auditLog.action,
            detail: auditLog.detail,
            userId: auditLog.userId,
            userName: users.name,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .where(where)
          .orderBy(desc(auditLog.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(auditLog).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },
  };
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;

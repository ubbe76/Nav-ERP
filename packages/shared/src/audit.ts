import { z } from "zod";
import { listQuerySchema } from "./list.js";

// Read side of the append-only audit_log (G1). entityType is deliberately a
// plain string, not an enum — writers across every module log into the same
// table with their own vocabulary (see CLAUDE.md's "Bindande konventioner"),
// and the read side must stay tolerant of entity types/actions it doesn't
// know about yet rather than rejecting them.
//
// `entityId` is an EXACT match — the card-mounted AuditTrailSection asks for
// one specific document's history (entityType + entityId, its own displayed
// number) — while `search` (inherited from listQuerySchema) does a free-text
// ILIKE across entityId + action for the admin list page at
// /system/handelselogg.
export const listAuditLogQuerySchema = listQuerySchema.extend({
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().trim().max(100).optional(),
  userId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

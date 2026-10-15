import type { FastifyInstance } from "fastify";
import { listAuditLogQuerySchema } from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { registerListCsvRoute } from "./csv-export.js";
import type { AuditRepository } from "../repository/audit.repository.js";
import { auditLogExportColumns } from "../service/audit-log-columns.js";

// G1 (Agent 3) — the read side of the audit trail. Own file rather than an
// addition to system.routes.ts: that file is system.service.ts's own
// (company info/settings/number series/carriers), which G1's Agent 2 is
// wiring audit WRITES into concurrently — this stays a separate route
// registration in app.ts to avoid a merge collision.
//
// Talks directly to the repository (no service layer) — same idiom as
// mailRoutes' /email-log, which is a thin read + resend over
// MailRepository.listEmailLog with no domain logic of its own to guard.
//
// Admin-only end to end, like the rest of System: both /audit-log and its
// CSV sibling require the admin role, and the web page mirrors the gate
// server-side (same pattern as /system/anvandare, /system/e-postlogg).
export async function auditLogRoutes(app: FastifyInstance, opts: { repo: AuditRepository }) {
  const { repo } = opts;

  app.get("/audit-log", { preHandler: requireRole("admin") }, async (req) => {
    return repo.listAuditLog(listAuditLogQuerySchema.parse(req.query));
  });

  registerListCsvRoute(app, {
    path: "/audit-log/csv",
    preHandler: requireRole("admin"),
    querySchema: listAuditLogQuerySchema,
    filenameBase: "handelselogg",
    columns: auditLogExportColumns,
    fetch: (query) => repo.listAuditLog(query),
  });
}

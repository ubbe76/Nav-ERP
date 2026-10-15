// G1 (Agent 3): CSV columns for GET /audit-log/csv — mirrors
// AuditLogPageClient.tsx's Table column order/labels.
import { type CsvColumn } from "@navet/shared";
import type { AuditLogEntry } from "../repository/audit.repository.js";
import { auditActionLabel, auditEntityTypeLabel } from "./audit-log-labels.js";

export const auditLogExportColumns: CsvColumn<AuditLogEntry>[] = [
  { label: "Tid", value: (r) => (r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt), format: "datetime" },
  { label: "Användare", value: (r) => r.userName ?? "System" },
  { label: "Typ", value: (r) => auditEntityTypeLabel(r.entityType) },
  { label: "Id", value: (r) => r.entityId ?? "" },
  { label: "Händelse", value: (r) => auditActionLabel(r.action) },
  { label: "Detalj", value: (r) => (r.detail ? JSON.stringify(r.detail) : "") },
];

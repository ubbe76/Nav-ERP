"use client";

import { useEffect, useState } from "react";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { auditActionLabel, type AuditLogEntry, type Paged } from "../../lib/types";
import { AuditDetail } from "./AuditDetail";
import { useCan } from "../PermissionsProvider";

// Shared "Historik"-section for the document cards (kundorder, inköpsorder,
// tillverkningsorder, faktura, leverantörsfaktura) — G1's read side. Mounted
// at the same position as MailSection's "E-post" section (bottom of the
// card), client-fetches on mount (InkopTab's own idiom — the card component
// itself is a Server Component elsewhere, so this piece owns its own
// loading state rather than the page fetching it up front). entityType/
// entityId must match what the writing service actually logged — entityId
// is the document's own displayed number (KO-…, IO-…, TO-…, FA-…, LF-…),
// never the row's uuid (CLAUDE.md's "Bindande konventioner").
export function AuditTrailSection({
  entityType,
  entityId,
  alsoEntityId,
  title = "Historik",
}: {
  entityType: string;
  entityId: string;
  // A second number the same document was logged under (offertnumret OF-…
  // after the quote became a kundorder).
  alsoEntityId?: string;
  title?: string;
}) {
  // The audit-log API is admin-only (like System → Händelselogg), so the
  // section is too — everyone else would only see a refusal.
  const isAdmin = useCan()(["admin"]);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<Paged<AuditLogEntry>>(
      `/api/v1/audit-log?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}${alsoEntityId ? `&alsoEntityId=${encodeURIComponent(alsoEntityId)}` : ""}&limit=50`
    )
      .then((res) => {
        if (!cancelled) setEntries(res.rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Kunde inte hämta historik");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, alsoEntityId, isAdmin]);

  if (!isAdmin || loading) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <strong>{title}</strong>
      {error && <p style={{ color: "var(--status-stopped-text)" }}>{error}</p>}
      {!error && entries.length === 0 && <p>Inga händelser.</p>}
      {!error && entries.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Table<AuditLogEntry>
            columns={[
              { key: "createdAt", label: "Tid", width: "150px" },
              { key: "userName", label: "Användare", width: "160px" },
              { key: "action", label: "Händelse", width: "160px" },
              { key: "detail", label: "Detalj", width: "1fr" },
            ]}
            rows={entries}
            renderCell={(row, key) => {
              switch (key) {
                case "createdAt":
                  return new Date(row.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
                case "userName":
                  return row.userName ?? "System";
                case "action":
                  return auditActionLabel(row.action);
                case "detail":
                  return <AuditDetail detail={row.detail} />;
                default:
                  return null;
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

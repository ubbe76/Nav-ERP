"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { apiFetch } from "../../lib/api";
import {
  EMAIL_DOCUMENT_TYPE_LABELS,
  EMAIL_STATUS_PILL,
  type EmailDocumentType,
  type EmailLogEntry,
  type Paged,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError } from "../ui/Form";

// Where each document type's card lives — for the Dokument column link.
// "invoice" rows are ambiguous (old pre-C1 rows point at a sales order id
// instead of a real invoice), so this switches on the API-derived linkKind
// rather than documentType directly — see EmailLinkKind.
function documentHref(entry: EmailLogEntry): string | null {
  if (!entry.documentId) return null;
  switch (entry.linkKind) {
    case "inquiry":
      return `/inkop/forfragningar/${entry.documentId}`;
    case "purchase_order":
      return `/inkop/ordrar/${entry.documentId}`;
    case "quote":
    case "order_confirmation":
    case "sales_order":
      return `/forsaljning/ordrar/${entry.documentId}`;
    case "invoice":
      return `/forsaljning/fakturor/${entry.documentId}`;
    // Kundreskontra (B3): a reminder is always logged against the invoice
    // itself, so it links to the invoice card rather than the order.
    case "payment_reminder":
      return `/forsaljning/fakturor/${entry.documentId}`;
    default:
      return null;
  }
}

export function EmailLogPageClient({ log, pageSize }: { log: Paged<EmailLogEntry>; pageSize: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function resend(entry: EmailLogEntry) {
    setError(null);
    setPendingId(entry.id);
    try {
      await apiFetch(`/api/v1/email-log/${entry.id}/resend`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Omskicket misslyckades");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>E-postlogg</div>
          <div className={shellStyles.meta}>{log.total.toLocaleString("sv-SE")} utskick</div>
        </div>
        <HelpLink chapter="system" anchor="e-postlogg" label="Hjälp om e-postloggen" />
      </div>

      <ListToolbar placeholder="Sök mottagare eller ämne…">
        <ListFilterSelect
          param="documentType"
          allLabel="Alla dokument"
          ariaLabel="Filtrera på dokumenttyp"
          options={Object.entries(EMAIL_DOCUMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(EMAIL_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/email-log/csv" />
      </ListToolbar>

      <FormError>{error}</FormError>

      <Table<EmailLogEntry>
        columns={[
          { key: "createdAt", label: "Tid", width: "140px" },
          { key: "documentType", label: "Dokument", width: "160px" },
          { key: "recipient", label: "Mottagare", width: "1fr" },
          { key: "subject", label: "Ämne", width: "1fr" },
          { key: "status", label: "Status", width: "120px" },
          { key: "id", label: "", width: "120px", align: "right" },
        ]}
        rows={log.rows}
        emptyText="Inga utskick matchar sökningen"
        renderCell={(entry, key) => {
          switch (key) {
            case "createdAt":
              return new Date(entry.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
            case "documentType": {
              const label = EMAIL_DOCUMENT_TYPE_LABELS[entry.documentType as EmailDocumentType];
              const href = documentHref(entry);
              return href ? (
                <Link href={href} style={{ fontWeight: 600, color: "inherit" }}>
                  {label}
                </Link>
              ) : (
                label
              );
            }
            case "status": {
              const pill = EMAIL_STATUS_PILL[entry.status];
              return (
                <span title={entry.error ?? undefined}>
                  <StatusPill status={pill.status} label={pill.label} compact />
                </span>
              );
            }
            case "id":
              if (entry.status !== "failed") return null;
              return (
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={pendingId !== null}
                  onClick={() => resend(entry)}
                >
                  {pendingId === entry.id ? "Skickar…" : "Skicka om"}
                </Button>
              );
            default:
              return entry[key as keyof EmailLogEntry] as string;
          }
        }}
      />

      <Pagination total={log.total} pageSize={pageSize} />
    </>
  );
}

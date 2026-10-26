import { SectionHeading } from "../ui/SectionHeading";
import { formatStockholmDateTime } from "../../lib/date";
import { formatMoney } from "../../lib/format";
import {
  DEVIATION_ACTION_LABELS,
  DEVIATION_COST_KIND_LABELS,
  DEVIATION_DECISION_LABELS,
  DEVIATION_LINK_DOCUMENT_LABELS,
  DEVIATION_STATUS_LABELS,
  DEVIATION_TYPE_LABELS,
  type DeviationAction,
  type DeviationCostKind,
  type DeviationDecision,
  type DeviationEvent,
  type DeviationLinkDocumentType,
  type DeviationStatus,
  type DeviationType,
} from "../../lib/quality";
import styles from "./Deviations.module.css";

// The field names a PATCH can change, as the card labels them.
const FIELD_LABELS: Record<string, string> = {
  title: "Rubrik",
  description: "Beskrivning",
  reportedDate: "Datum",
  reasonId: "Orsak",
  responsibleUserId: "Ansvarig",
  dueDate: "Åtgärd senast",
  counterpartyReference: "Referens",
  customerId: "Kund",
  supplierId: "Leverantör",
  salesOrderId: "Kundorder",
  salesOrderRowId: "Orderrad",
  invoiceId: "Faktura",
  purchaseOrderId: "Inköpsorder",
  purchaseOrderRowId: "Orderrad",
  manufacturingOrderId: "Tillverkningsorder",
  moOperationId: "Operation",
  articleId: "Artikel",
  quantity: "Antal",
  causeAnalysis: "Orsaksanalys",
  correctiveAction: "Åtgärd",
  preventiveAction: "Förebyggande åtgärd",
  decision: "Beslut",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusText(value: unknown): string {
  return DEVIATION_STATUS_LABELS[value as DeviationStatus] ?? text(value);
}

// One short sentence per history row, from the event kind and its detail.
export function describeDeviationEvent(event: DeviationEvent): string {
  const d = event.detail ?? {};
  switch (event.event) {
    case "created":
      return `Skapade avvikelsen${d.type ? ` (${DEVIATION_TYPE_LABELS[d.type as DeviationType] ?? text(d.type)})` : ""}`;
    case "status_changed": {
      const action = DEVIATION_ACTION_LABELS[d.action as DeviationAction] ?? text(d.action);
      const extra = [
        d.decision ? `beslut ${(DEVIATION_DECISION_LABELS[d.decision as DeviationDecision] ?? text(d.decision)).toLowerCase()}` : "",
        d.reason ? `orsak: ${text(d.reason)}` : "",
      ].filter(Boolean);
      return `${action}: ${statusText(d.from)} → ${statusText(d.to)}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
    }
    case "updated": {
      const changes = (d.changes ?? {}) as Record<string, { before: unknown; after: unknown }>;
      const names = Object.keys(changes).map((key) => FIELD_LABELS[key] ?? key);
      return names.length > 0 ? `Ändrade ${names.join(", ")}` : "Ändrade uppgifter";
    }
    case "cost_added":
      return `Lade till kostnad: ${DEVIATION_COST_KIND_LABELS[d.kind as DeviationCostKind] ?? text(d.kind)} ${formatMoney(Number(d.amount))} kr${
        d.description ? ` (${text(d.description)})` : ""
      }`;
    case "cost_removed":
      return `Tog bort kostnad: ${DEVIATION_COST_KIND_LABELS[d.kind as DeviationCostKind] ?? text(d.kind)} ${formatMoney(Number(d.amount))} kr`;
    case "link_added":
      return `Kopplade ${(DEVIATION_LINK_DOCUMENT_LABELS[d.documentType as DeviationLinkDocumentType] ?? text(d.documentType)).toLowerCase()} ${text(d.documentNumber)}`.trim();
    case "link_removed":
      return `Tog bort kopplingen till ${(DEVIATION_LINK_DOCUMENT_LABELS[d.documentType as DeviationLinkDocumentType] ?? text(d.documentType)).toLowerCase()}`;
    case "file_added":
      return `Lade till filen ${text(d.filename)}`;
    case "file_removed":
      return `Tog bort filen ${text(d.filename)}`;
    case "email_sent":
      return `Skickade avvikelsen till ${text(d.to)}${d.includeDetails ? " (med analys och åtgärd)" : ""}`;
    default:
      return String(event.event);
  }
}

// Historik: the case's own log, oldest first.
export function DeviationHistory({ events }: { events: DeviationEvent[] }) {
  return (
    <div className={styles.section}>
      <SectionHeading>Historik</SectionHeading>
      {events.length === 0 ? (
        <p>Ingen historik.</p>
      ) : (
        <ul className={styles.history}>
          {events.map((event) => (
            <li key={event.id} className={styles.historyItem}>
              <span className={styles.historyWhen}>{formatStockholmDateTime(event.createdAt)}</span>
              <span className={styles.historyWho}>{event.userName ?? "–"}</span>
              <span>{describeDeviationEvent(event)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

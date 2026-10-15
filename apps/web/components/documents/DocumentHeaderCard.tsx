import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { StatusPill, type Status } from "../ui/StatusPill";
import styles from "./DocumentHeaderCard.module.css";
import { Card } from "../ui/Card";

export interface HeaderField {
  label: string;
  // null/undefined/"" renders as an em dash.
  value: ReactNode | null | undefined;
  // Turns the value into a link — used for the supplier/customer card.
  href?: string;
  // Spans the full grid row (delivery address, note).
  wide?: boolean;
}

interface DocumentHeaderCardProps {
  pill: { status: Status; label: string };
  // Free-form line next to the pill: "Rev 2 · SEK", invoice number, a link to
  // the purchase order an inquiry became, …
  meta?: ReactNode;
  fields: HeaderField[];
  note?: string | null;
  // Omitted = the document is locked, so no Ändra button is rendered.
  onEdit?: () => void;
}

// Orderhuvudet — the shared read view on the inquiry, purchase order and
// sales order cards. Purely presentational: each card composes its own field
// list and owns the edit form behind `onEdit`.
export function DocumentHeaderCard({ pill, meta, fields, note, onEdit }: DocumentHeaderCardProps) {
  const shown = note ? [...fields, { label: "Notering", value: note, wide: true }] : fields;

  return (
    <Card maxWidth="none" className={styles.card}>
      <div className={styles.strip}>
        <StatusPill status={pill.status} label={pill.label} />
        {meta && <span className={styles.meta}>{meta}</span>}
        {onEdit && (
          <span className={styles.edit}>
            <Button type="button" size="small" variant="ghost" onClick={onEdit}>
              Ändra
            </Button>
          </span>
        )}
      </div>

      <div className={styles.grid}>
        {shown.map((field) => (
          <div key={field.label} className={field.wide ? styles.wide : undefined}>
            <div className={styles.label}>{field.label}</div>
            <div className={styles.value}>{renderValue(field)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function renderValue({ value, href }: HeaderField): ReactNode {
  if (value === null || value === undefined || value === "") return <span className={styles.muted}>–</span>;
  if (href)
    return (
      <Link href={href} className={styles.link}>
        {value}
      </Link>
    );
  return value;
}

"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { FormError, FormHint } from "../ui/Form";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import styles from "./HeaderEditor.module.css";

// The document header edited in place (Programramen steg 3, the user's
// choice "Ändra direkt"): the fields stand in a grid on the card itself, and
// a bar with Spara / Ångra ändringar appears once something differs from the
// saved header. Ctrl/⌘+S saves (SaveShortcut submits the focused form), and
// leaving the page with unsaved changes asks first (useUnsavedGuard). Each
// card owns its fields and its save; this is only the frame.
export function HeaderEditor({
  label,
  dirty,
  pending,
  error,
  onSubmit,
  onReset,
  children,
  more,
  moreOpen = false,
}: {
  label: string;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
  onReset: () => void;
  children: ReactNode;
  // The fields used now and then (valuta, påslag, fakturakund, dimensions)
  // behind Fler uppgifter — open from the start when one of them holds
  // something (moreOpen), so nothing set is ever hidden.
  more?: ReactNode;
  moreOpen?: boolean;
}) {
  useUnsavedGuard(dirty);
  const [showMore, setShowMore] = useState(moreOpen);
  return (
    <Card maxWidth="none" className={styles.card} data-dirty={dirty || undefined}>
      <form onSubmit={onSubmit} aria-label={label} className={styles.form}>
        <FormError>{error}</FormError>
        <div className={styles.grid}>{children}</div>
        {more && showMore && <div className={styles.grid}>{more}</div>}
        {more && (
          <button
            type="button"
            className={styles.moreToggle}
            aria-expanded={showMore}
            onClick={() => setShowMore((v) => !v)}
          >
            <ChevronDown size={15} strokeWidth={2} aria-hidden="true" data-open={showMore || undefined} />
            {showMore ? "Färre uppgifter" : "Fler uppgifter"}
          </button>
        )}
        {dirty && (
          <div className={styles.footer} role="status">
            <span className={styles.unsaved}>Osparade ändringar i huvudet</span>
            <Button type="button" size="small" variant="ghost" disabled={pending} onClick={onReset}>
              Ångra ändringar
            </Button>
            <Button type="submit" size="small" variant="primary" disabled={pending} title="Spara (Ctrl+S)">
              {pending ? "Sparar…" : "Spara"}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// One cell of the grid: a field (or a few that belong together) and an
// optional hint under it. `span` = two columns where there is room, `wide` =
// the whole row.
export function HeaderCell({
  span,
  wide,
  hint,
  title,
  children,
}: {
  span?: boolean;
  wide?: boolean;
  hint?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={wide ? styles.wide : span ? styles.span : styles.cell} title={title}>
      {children}
      {hint && <FormHint>{hint}</FormHint>}
    </div>
  );
}

// A header value that isn't edited here (Kund — changed with Byt kund —,
// Leveransdatum, the quote the order came from), in a field's place.
export function HeaderValue({
  label,
  value,
  href,
  wide,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  wide?: boolean;
}) {
  const shown = value === null || value === undefined || value === "" ? <span className={styles.muted}>–</span> : value;
  return (
    <div className={wide ? styles.wide : styles.cell}>
      <span className={styles.readLabel}>{label}</span>
      <span className={styles.readValue}>{href ? <Link href={href}>{shown}</Link> : shown}</span>
    </div>
  );
}

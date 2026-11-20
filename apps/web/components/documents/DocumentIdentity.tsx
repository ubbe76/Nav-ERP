import type { ReactNode } from "react";
import { StatusPill, type Status } from "../ui/StatusPill";
import styles from "./DocumentIdentity.module.css";

// The card's head under its toolbar (Programramen steg 3, the user's
// sketch): the number with its status and, to the right, a note (Skapad från
// offert OF-3310 · Rev 2 · SEK) and the help link; the counterparty's name as
// the title; the status steps under it. Replaces the page's own topbar on
// the order cards.
export function DocumentIdentity({
  pageTitle,
  number,
  pill,
  note,
  help,
  title,
  titleHref,
  steps,
}: {
  // The page's name for its tab, favourite and Senast öppnade ("Kundorder KO-5008").
  pageTitle: string;
  number: string;
  pill?: { status: Status; label: string } | null;
  note?: ReactNode;
  help?: ReactNode;
  title: string;
  titleHref?: string;
  steps?: ReactNode;
}) {
  return (
    <header className={styles.identity} data-page-title={pageTitle}>
      <div className={styles.line}>
        <span className={styles.number}>{number}</span>
        {pill && <StatusPill status={pill.status} label={pill.label} compact />}
        <span className={styles.spacer} />
        {note && <span className={styles.note}>{note}</span>}
        {help}
      </div>
      <h1 className={styles.title}>{titleHref ? <a href={titleHref}>{title}</a> : title}</h1>
      {steps}
    </header>
  );
}

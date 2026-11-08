import { GatedLink } from "../ui/GatedLink";
import type { ListCardRow } from "../../lib/overviewCardRows";
import cardStyles from "./DashboardCard.module.css";
import styles from "./ListCard.module.css";

// The newer Översikten cards (Leveranser, Beläggning, Fakturor, Offerter,
// Avvikelser): a title with Se alla, up to six rows deep-linked to where
// they are handled, and Visa alla (N) when the list goes on.
export function ListCard({
  title,
  rows,
  total,
  allHref,
  emptyText,
  errorText,
}: {
  title: string;
  rows: ListCardRow[];
  /** The whole list's count — Visa alla (N) shows when it is more than the rows. */
  total: number;
  allHref: string;
  emptyText: string;
  /** Set when the card's data could not be read — shown instead of the rows. */
  errorText?: string | null;
}) {
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>{title}</div>
        <GatedLink href={allHref} className={cardStyles.link}>
          Se alla
        </GatedLink>
      </div>
      {errorText ? (
        <p className={styles.empty}>{errorText}</p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <div>
          {rows.map((row) => (
            <ListCardRowView key={row.key} row={row} />
          ))}
          {total > rows.length && (
            <GatedLink href={allHref} className={styles.all}>
              Visa alla ({total})
            </GatedLink>
          )}
        </div>
      )}
    </div>
  );
}

function ListCardRowView({ row }: { row: ListCardRow }) {
  const tone = row.tone ?? undefined;
  const content = (
    <>
      <span className={styles.marker} data-tone={tone} aria-hidden="true" />
      <span className={styles.texts}>
        <span className={styles.primary}>{row.primary}</span>
        {row.secondary && <span className={styles.secondary}>{row.secondary}</span>}
      </span>
      <span className={`${styles.aside} num`} data-tone={tone}>
        {row.aside ?? ""}
      </span>
      <span className={styles.chevron} aria-hidden="true">
        ›
      </span>
    </>
  );
  if (row.href === null) return <span className={styles.row}>{content}</span>;
  return (
    <GatedLink href={row.href} className={styles.row}>
      {content}
    </GatedLink>
  );
}

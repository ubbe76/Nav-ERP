import { GatedLink } from "../ui/GatedLink";
import cardStyles from "./DashboardCard.module.css";
import styles from "./AttentionCard.module.css";

export interface AttentionItem {
  key: string;
  href: string;
  /** delayed = overdue order (amber), stopped = stock shortage (red) */
  tone: "delayed" | "stopped";
  primary: string;
  secondary: string;
}

// The action queue: every row is a concrete thing to act on (an overdue order,
// an article short on stock), deep-linked to where it can be fixed.
export function AttentionCard({
  items,
  hiddenCount = 0,
  emptyText = "Inget att bevaka — inga försenade ordrar eller negativa saldon.",
}: {
  items: AttentionItem[];
  hiddenCount?: number;
  emptyText?: string;
}) {
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>Att bevaka</div>
      </div>
      {items.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <div>
          {items.map((item) => (
            <GatedLink key={item.key} href={item.href} className={styles.row}>
              <span className={styles.marker} data-tone={item.tone} aria-hidden="true" />
              <span className={styles.texts}>
                <span className={styles.primary}>{item.primary}</span>
                <span className={styles.secondary}>{item.secondary}</span>
              </span>
              <span className={styles.chevron} aria-hidden="true">
                ›
              </span>
            </GatedLink>
          ))}
          {hiddenCount > 0 && <p className={styles.more}>+ {hiddenCount} till</p>}
        </div>
      )}
    </div>
  );
}

import { GatedLink } from "../ui/GatedLink";
import cardStyles from "./DashboardCard.module.css";
import styles from "./AttentionCard.module.css";

export interface AttentionItem {
  key: string;
  /** null = no card to open (rendered as plain text) */
  href: string | null;
  /** The alert's severity: yellow = amber, red = red. */
  tone: "red" | "yellow";
  primary: string;
  secondary: string;
}

// The action queue: the first rows of Aviseringar (GET /alerts), each a
// concrete thing to act on, deep-linked to where it can be fixed.
export function AttentionCard({
  items,
  totalCount = items.length,
  emptyText = "Inget att bevaka just nu.",
}: {
  items: AttentionItem[];
  /** Sum of every group's count — the "Visa alla (N)" figure. */
  totalCount?: number;
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
            <AttentionRow key={item.key} item={item} />
          ))}
          <GatedLink href="/aviseringar" className={styles.all}>
            Visa alla ({totalCount})
          </GatedLink>
        </div>
      )}
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const content = (
    <>
      <span className={styles.marker} data-tone={item.tone} aria-hidden="true" />
      <span className={styles.texts}>
        <span className={styles.primary}>{item.primary}</span>
        {item.secondary && <span className={styles.secondary}>{item.secondary}</span>}
      </span>
      <span className={styles.chevron} aria-hidden="true">
        ›
      </span>
    </>
  );
  if (item.href === null) return <span className={styles.row}>{content}</span>;
  return (
    <GatedLink href={item.href} className={styles.row}>
      {content}
    </GatedLink>
  );
}

import { Fragment } from "react";
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
  /** Supplier subheading (Behöver beställas): shown above the first row of each run. */
  heading?: string;
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
          {items.map((item, i) => (
            <Fragment key={item.key}>
              {item.heading && item.heading !== items[i - 1]?.heading && (
                <div className={styles.heading}>{item.heading}</div>
              )}
              {/* The supplier sections of Behöver beställas end here: a line,
                  so the next group's rows never read as that supplier's. */}
              {!item.heading && items[i - 1]?.heading && <div className={styles.divider} />}
              <AttentionRow item={item} />
            </Fragment>
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

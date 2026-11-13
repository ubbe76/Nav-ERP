import { GatedLink } from "../ui/GatedLink";
import type { AttentionSection } from "../../lib/alerts";
import cardStyles from "./DashboardCard.module.css";
import styles from "./AttentionCard.module.css";

// Aviseringar in short: one row per kind with its count, under the same area
// headings as the page (attentionSections). A row opens the kind on
// Aviseringar, unfolded.
export function AttentionCard({
  sections,
  totalCount,
  emptyText = "Inget att bevaka just nu.",
}: {
  sections: AttentionSection[];
  /** Sum of every kind's count — the "Visa alla (N)" figure. */
  totalCount: number;
  emptyText?: string;
}) {
  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.header}>
        <div className={cardStyles.title}>Att bevaka</div>
      </div>
      {sections.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <div>
          {sections.map((section) => (
            <div key={section.area} className={styles.section}>
              <div className={styles.heading}>{section.label}</div>
              {section.rows.map((row) => (
                <GatedLink key={row.kind} href={row.href} className={styles.row}>
                  <span className={styles.marker} data-tone={row.tone} aria-hidden="true" />
                  <span className={styles.primary}>{row.label}</span>
                  <span className={styles.count}>{row.count ?? "–"}</span>
                  <span className={styles.chevron} aria-hidden="true">
                    ›
                  </span>
                </GatedLink>
              ))}
            </div>
          ))}
          <GatedLink href="/aviseringar" className={styles.all}>
            Visa alla ({totalCount})
          </GatedLink>
        </div>
      )}
    </div>
  );
}

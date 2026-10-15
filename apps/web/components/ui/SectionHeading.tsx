import type { ReactNode } from "react";
import styles from "./SectionHeading.module.css";

interface SectionHeadingProps {
  children: ReactNode;
  // Right-aligned slot on the heading row: a "+ Ny …" button, a filter
  // checkbox, a count. Replaces the flex wrapper each card used to build
  // around its own <h3>.
  actions?: ReactNode;
  // The heading follows earlier content in the same card instead of opening
  // it — adds the gap that separates two blocks.
  spaced?: boolean;
}

// Sektionsrubrik — the heading above a group of fields or rows inside a card.
// One component so every panel in the app heads its sections the same way;
// it replaces the ad-hoc inline-styled <h3>s that used to differ per module.
export function SectionHeading({ children, actions, spaced }: SectionHeadingProps) {
  return (
    <div className={styles.row} data-spaced={spaced || undefined}>
      <h3 className={styles.heading}>{children}</h3>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

import type { ReactNode } from "react";
import styles from "./DocumentActionBar.module.css";
import { FormError } from "../ui/Form";

// The action row at the bottom of a document card. Dumb layout only — every
// button keeps its own handler in the card that renders it.
export function DocumentActionBar({
  error,
  children,
  trailing,
}: {
  // Shown above the bar, so all the flow actions share one error line.
  error?: string | null;
  children: ReactNode;
  // Right-aligned slot for the manual status override.
  trailing?: ReactNode;
}) {
  return (
    <>
      <FormError margin="above">{error}</FormError>
      <div className={styles.bar}>
        {children}
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </div>
    </>
  );
}

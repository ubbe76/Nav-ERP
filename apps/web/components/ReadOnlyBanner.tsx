import styles from "./ReadOnlyBanner.module.css";

// Endast läsning: a slim notice at the top of every page for a read-only
// account (the public demo login, an auditor). The API refuses every change
// regardless (403 read-only-account) — this only tells the visitor why.
// `flush`: a full-width strip for the fullscreen stamp terminal.
export function ReadOnlyBanner({ readOnly, flush }: { readOnly: boolean; flush?: boolean }) {
  if (!readOnly) return null;
  return (
    <div className={flush ? `${styles.banner} ${styles.flush}` : styles.banner} role="status">
      Du är inloggad med ett konto som bara kan läsa. Ändringar är avstängda, och systeminställningarna (menyn System) visas bara för administratörer.
    </div>
  );
}

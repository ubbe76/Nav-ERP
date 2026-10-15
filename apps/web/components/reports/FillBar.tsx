import styles from "./FillBar.module.css";

// A number's thin fill bar, clamped to [0, 100] so an over-100% value (e.g. a
// stray precisionPct) never overflows the track. See FillBar.module.css for
// why the color choice is theme-safe.
export function FillBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(percent, 100));
  return (
    <div className={styles.track}>
      <div className={styles.bar} style={{ width: `${clamped}%` }} />
    </div>
  );
}

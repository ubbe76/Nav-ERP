import styles from "./StatusPill.module.css";

export type Status = "running" | "delayed" | "stopped" | "done" | "draft";

const LABELS: Record<Status, string> = {
  running: "Pågår",
  delayed: "Försenad",
  stopped: "Stoppad",
  done: "Klar",
  draft: "Utkast",
};

interface StatusPillProps {
  status: Status;
  compact?: boolean;
  label?: string;
}

export function StatusPill({ status, compact, label }: StatusPillProps) {
  return (
    <span className={[styles.pill, styles[status], compact ? styles.compact : ""].join(" ")}>
      <span className={styles.dot} />
      {label ?? LABELS[status]}
    </span>
  );
}

// Inline variant used in the "Dagens order" list — a dot + label, no pill background.
export function StatusDot({ status, label }: StatusPillProps) {
  return (
    <span className={[styles.inline, styles[status]].join(" ")}>
      <span className={styles.dot} />
      {label ?? LABELS[status]}
    </span>
  );
}

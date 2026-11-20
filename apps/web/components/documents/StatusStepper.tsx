import { StatusPill, type Status } from "../ui/StatusPill";
import styles from "./DocumentIdentity.module.css";

// The document's flow as steps (Programramen steg 3, the user's sketch):
// Bekräftad — Under tillverkning — Levererad — Fakturerad, the steps passed
// filled, the current one marked. A status outside the flow (Avbruten,
// Förlorad) is shown as its pill instead.
export interface Step {
  key: string;
  label: string;
}

export function StatusStepper({
  steps,
  current,
  outside,
}: {
  steps: Step[];
  // The step the document is at; null = none of them (see outside).
  current: string | null;
  outside?: { status: Status; label: string } | null;
}) {
  if (outside) {
    return (
      <div className={styles.stepper}>
        <StatusPill status={outside.status} label={outside.label} compact />
      </div>
    );
  }
  const at = steps.findIndex((s) => s.key === current);
  return (
    <ol className={styles.stepper} aria-label="Status">
      {steps.map((step, i) => (
        <li
          key={step.key}
          className={styles.step}
          data-state={i < at ? "done" : i === at ? "current" : "next"}
          aria-current={i === at ? "step" : undefined}
        >
          <span className={styles.stepDot} aria-hidden="true" />
          {step.label}
        </li>
      ))}
    </ol>
  );
}

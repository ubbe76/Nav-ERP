import { FormNotice } from "./Form";
import styles from "./DeliveryDateHint.module.css";

// Sits under a delivery-date field: the partner's delivery days as muted text
// and, when the entered date doesn't fit them, a warning. Both texts come
// ready-made from the API.
export function DeliveryDateHint({ summary, warning }: { summary?: string | null; warning?: string | null }) {
  if (!summary && !warning) return null;
  return (
    <div className={styles.hint}>
      {summary && <p className={styles.summary}>{summary}</p>}
      {warning && <FormNotice role="status">{warning}</FormNotice>}
    </div>
  );
}

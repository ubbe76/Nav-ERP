import type { ReactNode } from "react";
import { formatMoney } from "../../lib/format";
import styles from "./DocumentTotals.module.css";

export interface TotalLine {
  key: string;
  label: string;
  amount: number;
  // The last line (Totalt), set off and bold.
  total?: boolean;
}

// The document's totals under its rows (Programramen steg 3, the user's
// sketch): Netto, Moms per sats, Totalt — right-aligned figures in the
// document's currency, with notes (no Swedish VAT, the value in SEK) under it.
export function DocumentTotals({ lines, currency, notes }: { lines: TotalLine[]; currency: string; notes?: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <dl className={styles.totals}>
        {lines.map((line) => (
          <div key={line.key} className={styles.line} data-total={line.total || undefined}>
            <dt>{line.label}</dt>
            <dd>
              {formatMoney(line.amount)} {currency}
            </dd>
          </div>
        ))}
      </dl>
      {notes && <div className={styles.notes}>{notes}</div>}
    </div>
  );
}

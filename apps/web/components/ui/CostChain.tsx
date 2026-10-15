import { formatMoney } from "../../lib/format";
import styles from "./CostChain.module.css";

// One step of the påläggskalkyl. `kind` styles the line: markups are muted so
// the direct costs read as the backbone, TVK/SVK are ruled off as subtotals,
// and the sales price is accented. `perUnit` is an already-formatted amount
// (see lib/costChain.ts's chainLines) — its presence, not just its value,
// decides whether the chain renders one amount column or two.
export type CostChainLine = {
  label: string;
  amount: number;
  kind?: "markup" | "subtotal" | "result";
  perUnit?: string;
};

// The calculation ladder — shared by the Kalkyl tab (a stored calculation) and
// System → Kalkyler (a live example of the configured markups). When the
// lines carry a perUnit figure, a second right-aligned column (Per st) is
// rendered next to the total; otherwise the chain looks exactly as before.
export function CostChain({ lines }: { lines: CostChainLine[] }) {
  const hasPerUnit = lines.some((line) => line.perUnit !== undefined);

  return (
    <div className={[styles.chain, hasPerUnit && styles.chainSplit].filter(Boolean).join(" ")}>
      {hasPerUnit && (
        <div className={styles.header}>
          <span />
          <span className={styles.headerAmount}>Totalt</span>
          <span className={styles.headerAmount}>Per st</span>
        </div>
      )}
      {lines.map((line) => (
        <div
          key={line.label}
          className={[hasPerUnit ? styles.rowSplit : styles.row, line.kind && styles[line.kind]]
            .filter(Boolean)
            .join(" ")}
        >
          <span>{line.label}</span>
          <span className={styles.amount}>{formatMoney(line.amount)} kr</span>
          {hasPerUnit && <span className={styles.amount}>{line.perUnit ? `${line.perUnit} kr` : "—"}</span>}
        </div>
      ))}
    </div>
  );
}

import { formatMoney, formatSignedMoney } from "../../lib/format";
import {
  DEVIATION_TONE_TEXT,
  PRELIMINARY_NOTICE,
  deviationTone,
  isZeroAmount,
  varianceSummaryLines,
} from "../../lib/costVariance";
import type { CostVarianceAnalysis } from "../../lib/types";
import styles from "./VarianceSummary.module.css";

// A deviation written with its sign. The sign and the hidden words carry the
// meaning; the colour (a semantic status token) only reinforces it.
export function Deviation({ value }: { value: number }) {
  const tone = deviationTone(value);
  return (
    <span className={styles.deviation} data-tone={tone}>
      {isZeroAmount(value) ? formatMoney(0) : formatSignedMoney(value)} kr
      <span className={styles.srOnly}> ({DEVIATION_TONE_TEXT[tone]})</span>
    </span>
  );
}

// "Avvikelse mot kalkylerat" — the order-level analysis under the
// efterkalkyl's chain on the TO card.
// `bare` drops the title, the notice and the top rule: the specification puts
// the summary under its own sub-heading and states the notice once above.
export function VarianceSummary({ analysis, bare }: { analysis: CostVarianceAnalysis; bare?: boolean }) {
  const lines = varianceSummaryLines(analysis);
  return (
    <div className={bare ? styles.bare : styles.block}>
      {!bare && <h4 className={styles.title}>Avvikelse mot kalkylerat</h4>}
      {!bare && analysis.preliminary && <p className={styles.notice}>{PRELIMINARY_NOTICE}</p>}
      <div className={styles.grid}>
        <span>Kalkylerat</span>
        <span className={styles.amount}>{formatMoney(analysis.base)} kr</span>
        <span>Utfall</span>
        <span className={styles.amount}>{formatMoney(analysis.actual)} kr</span>
        <span className={styles.total}>Avvikelse</span>
        <span className={`${styles.amount} ${styles.total}`}>
          <Deviation value={analysis.deviation} />
        </span>
        {lines.map((line) => (
          <VarianceLine key={line.key} label={line.label} amount={line.amount} sub={line.sub} />
        ))}
      </div>
    </div>
  );
}

function VarianceLine({ label, amount, sub }: { label: string; amount: number; sub?: boolean }) {
  return (
    <>
      <span className={sub ? styles.sub : styles.part}>{label}</span>
      <span className={`${styles.amount} ${sub ? styles.sub : styles.part}`}>
        <Deviation value={amount} />
      </span>
    </>
  );
}

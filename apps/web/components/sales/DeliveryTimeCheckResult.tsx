import { FormNotice } from "../ui/Form";
import { chosenDtcDate, formatDtcAlternativeSummary, formatDtcQuantity, formatDtcStep } from "../../lib/deliveryTimeCheck";
import type { DeliveryTimeCheckResult as Result } from "../../lib/types";
import styles from "./DeliveryTimeCheckResult.module.css";

// Shared result view of Leveranstidskontroll (order card dialog, Ny
// kundorder and the stand-alone page). Rows are cards rather than a table so
// the chain of steps reads top to bottom and nothing scrolls sideways at
// phone width.
//
// When the alternative resources gave an earlier date (usesAlternatives) both
// dates are shown. With onAlternativeModeChange the user picks which one to use
// (radio buttons); the dialog owns the choice. Without it (the stand-alone
// page, Ny kundorder) the two dates are only listed.
export function DeliveryTimeCheckResult({
  result,
  withCustomer,
  withAlternatives = true,
  onAlternativeModeChange,
}: {
  result: Result;
  withCustomer: boolean;
  withAlternatives?: boolean;
  onAlternativeModeChange?: (withAlternatives: boolean) => void;
}) {
  const hasDate = result.deliveryDate !== null && result.shipDate !== null;
  const usesAlt = result.usesAlternatives === true;
  const ordinary = result.ordinaryDeliveryDate ?? null;
  const showOrdinary = usesAlt && !withAlternatives && onAlternativeModeChange !== undefined;
  const primaryDate = withCustomer ? result.deliveryDate : result.shipDate;
  return (
    <div>
      {hasDate && usesAlt && (
        <div className={styles.altBox}>
          <div className={styles.altSummary}>
            {withCustomer
              ? formatDtcAlternativeSummary(result.deliveryDate!, ordinary)
              : `Avsändning ${result.shipDate} med alternativa resurser (ordinarie: ${result.ordinaryShipDate ?? "inget datum inom två år"})`}
          </div>
          {onAlternativeModeChange && withCustomer && (
            <div role="radiogroup" aria-label="Datum att använda" className={styles.altChoice}>
              <label className={styles.altOption}>
                <input
                  type="radio"
                  name="dtc-mode"
                  checked={withAlternatives}
                  onChange={() => onAlternativeModeChange(true)}
                />
                <span>Med alternativa resurser ({chosenDtcDate(result, true)})</span>
              </label>
              {ordinary ? (
                <label className={styles.altOption}>
                  <input
                    type="radio"
                    name="dtc-mode"
                    checked={!withAlternatives}
                    onChange={() => onAlternativeModeChange(false)}
                  />
                  <span>Med ordinarie resurser ({ordinary})</span>
                </label>
              ) : (
                <div className={styles.altHint}>Ordinarie resurser ger inget datum inom två år.</div>
              )}
            </div>
          )}
        </div>
      )}
      {hasDate ? (
        <div className={styles.summary}>
          {withCustomer && (
            <div>
              <div className={styles.summaryLabel}>Leveransdatum</div>
              <div className={styles.summaryValue}>{showOrdinary ? (ordinary ?? primaryDate) : result.deliveryDate}</div>
            </div>
          )}
          <div>
            <div className={styles.summaryLabel}>Avsändningsdag</div>
            <div className={styles.summaryValue}>{showOrdinary ? (result.ordinaryShipDate ?? result.shipDate) : result.shipDate}</div>
          </div>
        </div>
      ) : (
        <div className={styles.summary}>
          <div className={styles.noDate}>Inget datum — se noteringarna</div>
        </div>
      )}

      {result.notes.length > 0 && (
        <div className={styles.notes}>
          <NoteList notes={result.notes} />
        </div>
      )}

      <div className={styles.rows}>
        {result.rows.map((row) => (
          <div key={row.key} className={styles.row}>
            <div className={styles.rowHead}>
              <span>
                <span className={styles.cell}>Artikel </span>
                <span className={styles.article}>{row.articleNumber}</span>
              </span>
              <span>
                <span className={styles.cell}>Antal </span>
                <span className={styles.cellValue}>{formatDtcQuantity(row.quantity)}</span>
              </span>
              <span>
                <span className={styles.cell}>Klar </span>
                <span className={styles.cellValue}>{(showOrdinary ? (row.ordinaryReadyDate ?? row.readyDate) : row.readyDate) ?? "—"}</span>
              </span>
            </div>
            {row.chain.length > 0 && (
              <>
                <div className={styles.chainLabel}>
                  {showOrdinary ? "Vad som begränsar (med alternativa resurser)" : "Vad som begränsar"}
                </div>
                <ol className={styles.chain}>
                  {row.chain.map((step, i) => (
                    <li key={i}>{formatDtcStep(step)}</li>
                  ))}
                </ol>
              </>
            )}
            {row.notes.length > 0 && (
              <div className={styles.rowNotes}>
                <NoteList notes={row.notes} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// One notice for all of a row's notes — real data can carry dozens (every
// resource without a week schedule), and a box per note buries the result.
function NoteList({ notes }: { notes: string[] }) {
  if (notes.length === 1) return <FormNotice>{notes[0]}</FormNotice>;
  return (
    <FormNotice>
      <ul className={styles.noteList}>
        {notes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
    </FormNotice>
  );
}

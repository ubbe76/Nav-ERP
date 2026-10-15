"use client";

import type { VariantOf, VariantSelectionEntry } from "../../lib/configurator";
import { SectionHeading } from "../ui/SectionHeading";
import styles from "./Variants.module.css";

// What a choice reads as in the list: the option name for a list choice,
// "Ja" for a yes/no, the measure with decimal comma and unit for a number.
function valueText(entry: VariantSelectionEntry): string {
  if (entry.kind === "choice") return entry.valueName ?? "—";
  if (entry.kind === "boolean") return entry.value === true ? "Ja" : "—";
  if (entry.value === null || entry.value === undefined) return "—";
  const text = String(entry.value).replace(".", ",");
  return entry.unit ? `${text} ${entry.unit}` : text;
}

// Read-only list of the choices a stocked variant was created from.
export function VariantOfPanel({ variantOf }: { variantOf: VariantOf }) {
  const quantity = Number(variantOf.calcQuantity).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
  return (
    <div>
      <SectionHeading>Konfigurator</SectionHeading>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Grupp</th>
              <th>Val</th>
            </tr>
          </thead>
          <tbody>
            {variantOf.selection.map((entry) => (
              <tr key={entry.groupCode}>
                <td>{entry.groupName}</td>
                <td>{valueText(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
        Standardpriset räknades vid kalkylantal {quantity}.
      </p>
    </div>
  );
}

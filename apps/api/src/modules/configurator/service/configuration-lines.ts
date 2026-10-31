// apps/api/src/modules/configurator/service/configuration-lines.ts
import type { OrderRowConfiguration, VariantSelectionEntry } from "@navet/shared";
import { formatNumber } from "../../mail/service/document-pdf.js";

// Konfigurator 4b: the choice lines printed under an order/invoice/pick-list/
// delivery-note row. Pure: the entries are already in group order (variant-
// identity.ts's selectionEntries), so the output order is the template's.
// Nej and groups without a value print nothing; a measure prints with its
// unit; with `additions` the group's price addition is appended.

// sv-SE renders the thousands separator as U+00A0 (U+202F on some ICU builds)
// and 1.5 as "1,5"; pdfkit's WinAnsi has no glyph trouble with either, but
// normalise to an ordinary space so the string compares and wraps like the
// rest of the document.
const GROUP_SEPARATORS = /[\u00a0\u202f]/g;

/** sv-SE measure: "1 200", "12,5" — thousands separator is the ordinary space (WinAnsi-safe). */
export function formatMeasure(n: number): string {
  if (n === 0) n = 0; // −0 would print "-0"
  const decimals = Number.isInteger(n) ? 0 : Math.min(4, (String(Number(n.toFixed(4))).split(".")[1] ?? "").length);
  return formatNumber(n, decimals).replace(GROUP_SEPARATORS, " ");
}

/** "Grupp: Värde" per group with a value; Nej and empty groups print nothing. With `additions`,
 *  " (+ 240,00)" is appended when the group's summed addition ≠ 0. */
export function configurationLines(
  selection: VariantSelectionEntry[],
  additions?: { groupCode: string; amount: number }[]
): string[] {
  const addedByGroup = new Map<string, number>();
  for (const a of additions ?? []) addedByGroup.set(a.groupCode, (addedByGroup.get(a.groupCode) ?? 0) + a.amount);
  const lines: string[] = [];
  for (const e of selection) {
    let value: string | null = null;
    if (e.kind === "choice") value = e.valueName;
    else if (e.kind === "boolean") value = e.value === true ? "Ja" : null;
    else if (typeof e.value === "number") value = `${formatMeasure(e.value)}${e.unit ? ` ${e.unit}` : ""}`;
    if (value === null) continue;
    const added = addedByGroup.get(e.groupCode) ?? 0;
    const suffix =
      additions && added !== 0
        ? ` (${added > 0 ? "+" : "-"} ${formatNumber(Math.abs(added)).replace(GROUP_SEPARATORS, " ")})`
        : "";
    lines.push(`${e.groupName}: ${value}${suffix}`);
  }
  return lines;
}

/** The choice lines of a stored row configuration (sales_order_rows/invoice_rows.configuration,
 *  read raw from jsonb), with the price additions only when the document shows them — never
 *  on the pick list or the delivery note. A plain row (null) prints nothing (undefined). */
export function rowConfigurationLines(configuration: unknown, withPrices: boolean): string[] | undefined {
  const cfg = configuration as OrderRowConfiguration | null;
  if (!cfg) return undefined;
  return configurationLines(cfg.selection, withPrices ? cfg.price?.additions : undefined);
}

// Field-level formatting rules from the SIE 4 specification (§5.7–5.10).
// Pure and dependency-free so every rule is unit-testable on its own.
import { round2 } from "@navet/shared";

// Fields are whitespace-separated. Quoting is only REQUIRED when the value
// contains a space, but an empty value must be quoted too or the column
// silently disappears from the record. Embedded quotes and backslashes are
// escaped with a backslash; control characters are forbidden inside strings,
// so they collapse to a space rather than being emitted raw.
export function sieField(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (cleaned !== "" && !/[\s"\\]/.test(cleaned)) return cleaned;
  return sieText(cleaned);
}

// Text fields (names, descriptions) are ALWAYS quoted, even when they have
// no space. The spec permits either, but its own examples quote them
// consistently — "#KONTO 1510 \"Kundfordringar\"" — and matching the
// examples is the safer bet with strict importers. Codes, numbers and dates
// stay bare via sieField.
export function sieText(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Decimal point, at most two decimals, no thousands separator, minus for
// credit and never an explicit plus. A whole amount is written without any
// decimal part at all — "1000", not "1000.00".
export function sieAmount(value: number): string {
  const rounded = round2(value);
  // Guard against "-0": round2(-0.001) is -0, which String() renders as "0"
  // but toFixed() renders as "-0.00".
  const safe = rounded === 0 ? 0 : rounded;
  const fixed = safe.toFixed(2);
  return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed.replace(/0$/, "");
}

// "2026-01-01" -> "20260101".
export function sieDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

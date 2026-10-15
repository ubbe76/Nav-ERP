// Mirror of @navet/shared's VAT_BOXES/VAT_BOX_LABELS (the web cannot import
// @navet/shared — Turbopack vs .js-suffix imports). Kept in sync by
// apps/api/test/vat-box.shared.test.ts.
export const VAT_BOXES = ["05", "10", "11", "12", "35", "36", "42", "48"] as const;
export type VatBox = (typeof VAT_BOXES)[number];
export type VatBoxSetting = VatBox | "none";

export const VAT_BOX_LABELS: Record<VatBox, string> = {
  "05": "Momspliktig försäljning",
  "10": "Utgående moms 25 %",
  "11": "Utgående moms 12 %",
  "12": "Utgående moms 6 %",
  "35": "Varor till annat EU-land",
  "36": "Export av varor utanför EU",
  "42": "Momsfri försäljning",
  "48": "Ingående moms att dra av",
};

export function vatBoxLabel(value: VatBoxSetting | null): string {
  if (value === null) return "Ej angiven";
  if (value === "none") return "Ingen ruta";
  return `${value} · ${VAT_BOX_LABELS[value]}`;
}

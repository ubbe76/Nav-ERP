// Mirror of @navet/shared's VAT_BOXES/VAT_BOX_LABELS (the web cannot import
// @navet/shared — Turbopack vs .js-suffix imports). Kept in sync by
// apps/api/test/vat-box.shared.test.ts.
export const VAT_BOXES = [
  "05",
  "06",
  "07",
  "08",
  "10",
  "11",
  "12",
  "20",
  "21",
  "22",
  "23",
  "24",
  "30",
  "31",
  "32",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "48",
  "50",
  "60",
  "61",
  "62",
] as const;
export type VatBox = (typeof VAT_BOXES)[number];
export type VatBoxSetting = VatBox | "none";

export const VAT_BOX_LABELS: Record<VatBox, string> = {
  "05": "Momspliktig försäljning som inte ingår i ruta 06, 07 eller 08",
  "06": "Momspliktiga uttag",
  "07": "Beskattningsunderlag vid vinstmarginalbeskattning",
  "08": "Hyresinkomster vid frivillig skattskyldighet",
  "10": "Utgående moms 25 %",
  "11": "Utgående moms 12 %",
  "12": "Utgående moms 6 %",
  "20": "Inköp av varor från ett annat EU-land",
  "21": "Inköp av tjänster från ett annat EU-land enligt huvudregeln",
  "22": "Inköp av tjänster från ett land utanför EU",
  "23": "Inköp av varor i Sverige som köparen är skattskyldig för",
  "24": "Övriga inköp av tjänster",
  "30": "Utgående moms 25 %",
  "31": "Utgående moms 12 %",
  "32": "Utgående moms 6 %",
  "35": "Försäljning av varor till ett annat EU-land",
  "36": "Försäljning av varor utanför EU",
  "37": "Mellanmans inköp av varor vid trepartshandel",
  "38": "Mellanmans försäljning av varor vid trepartshandel",
  "39": "Försäljning av tjänster till en näringsidkare i ett annat EU-land enligt huvudregeln",
  "40": "Övrig försäljning av tjänster omsatta utanför Sverige",
  "41": "Försäljning när köparen är skattskyldig i Sverige",
  "42": "Övrig försäljning m.m.",
  "48": "Ingående moms att dra av",
  "50": "Beskattningsunderlag vid import",
  "60": "Utgående moms 25 %",
  "61": "Utgående moms 12 %",
  "62": "Utgående moms 6 %",
};

export function vatBoxLabel(value: VatBoxSetting | null): string {
  if (value === null) return "Ej angiven";
  if (value === "none") return "Ingen ruta";
  return `${value} · ${VAT_BOX_LABELS[value]}`;
}

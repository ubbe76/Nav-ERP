import type { VatDeclarationBox, VatDeclarationBoxes } from "@navet/shared";

// Momsdeklaration via fil (Skatteverket, "Lämna momsdeklaration via fil i
// e-tjänsten", eSKDUpload version 6.0). Pure builder — the report service
// supplies the rounded boxes; vat-file.test.ts pins the output byte for byte
// against the page's example 6.
//
// Rules from the page: whole kronor without decimals, only a leading minus
// is allowed, ruta 07 negative is written as 0, ruta 49 (MomsBetala) is
// always present, boxes with nothing to report may be left out, no extra
// spaces or tabs. The elements come in the page's order — not numeric.

export const VAT_FILE_ELEMENTS: readonly (readonly [VatDeclarationBox, string])[] = [
  ["05", "ForsMomsEjAnnan"],
  ["06", "UttagMoms"],
  ["07", "UlagMargbesk"],
  ["08", "HyrinkomstFriv"],
  ["20", "InkopVaruAnnatEg"],
  ["21", "InkopTjanstAnnatEg"],
  ["22", "InkopTjanstUtomEg"],
  ["23", "InkopVaruSverige"],
  ["24", "InkopTjanstSverige"],
  ["50", "MomsUlagImport"],
  ["35", "ForsVaruAnnatEg"],
  ["36", "ForsVaruUtomEg"],
  ["37", "InkopVaruMellan3p"],
  ["38", "ForsVaruMellan3p"],
  ["39", "ForsTjSkskAnnatEg"],
  ["40", "ForsTjOvrUtomEg"],
  ["41", "ForsKopareSkskSverige"],
  ["42", "ForsOvrigt"],
  ["10", "MomsUtgHog"],
  ["11", "MomsUtgMedel"],
  ["12", "MomsUtgLag"],
  ["30", "MomsInkopUtgHog"],
  ["31", "MomsInkopUtgMedel"],
  ["32", "MomsInkopUtgLag"],
  ["60", "MomsImportUtgHog"],
  ["61", "MomsImportUtgMedel"],
  ["62", "MomsImportUtgLag"],
  ["48", "MomsIngAvdr"],
  ["49", "MomsBetala"],
];

// ÅÅÅÅMM of the period's last month — month, quarter and helår alike.
export function vatFilePeriod(to: string): string {
  return `${to.slice(0, 4)}${to.slice(5, 7)}`;
}

// "556000-0175": ten digits with the hyphen; a twelve-digit number loses its
// century digits. Anything else is null (the caller refuses the file).
export function formatVatFileOrgNumber(raw: string | null | undefined): string | null {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 12) digits = digits.slice(2);
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

function integer(box: VatDeclarationBox, value: number): string {
  if (!Number.isInteger(value)) throw new Error(`Box ${box} must be whole kronor, got ${value}`);
  // `${-0}` is "0" — no stray minus.
  return String(value === 0 ? 0 : value);
}

export function buildVatDeclarationFile(input: {
  orgNumber: string;
  period: string;
  boxes: VatDeclarationBoxes;
}): Buffer {
  const lines = [
    `<?xml version="1.0" encoding="ISO-8859-1"?>`,
    `<eSKDUpload Version="6.0">`,
    `<OrgNr>${input.orgNumber}</OrgNr>`,
    `<Moms>`,
    `<Period>${input.period}</Period>`,
  ];
  for (const [box, element] of VAT_FILE_ELEMENTS) {
    let value = input.boxes[box];
    if (box === "07" && value < 0) value = 0;
    if (value === 0 && box !== "49") continue;
    lines.push(`<${element}>${integer(box, value)}</${element}>`);
  }
  lines.push(`</Moms>`, `</eSKDUpload>`);
  // Only digits and fixed ASCII names — latin1 cannot lose anything here.
  return Buffer.from(lines.join("\n"), "latin1");
}

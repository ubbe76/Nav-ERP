import { z } from "zod";
import { blankSafe } from "./coerce.js";

// Skanning (#4; spec 2026-10-29-skanning-design.md) — the pure rules every
// scan and every barcode field shares: what a scanned string looks like once
// cleaned, what a valid EAN/GTIN is, and how a lagerplats label is written.

// A handheld scanner types the code followed by Enter, and GS1 codes may
// carry the group separator (FNC1, \x1d) or a stray tab/CR. None of it is
// part of the code.
export function normalizeScanCode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

// GTIN-8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14): digits only, the last one
// a mod-10 check digit over the others weighted 3,1,3,1… from the right.
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

// THE identity of a GTIN (användarens val 2026-11-11): the same number may be
// written as UPC-A (12 digits) or as EAN-13 with a leading 0 — a scanner
// reads a UPC-A package as either — and GS1 compares every GTIN
// right-justified in 14 digits. So the key is the code zero-padded to 14
// (the check digit is unchanged by leading zeros); null when the code is no
// valid GTIN. The stored articles.barcode is never rewritten — the scan
// lookup and the duplicate check compare keys.
export function gtinKey(code: string): string | null {
  return isValidGtin(code) ? code.padStart(14, "0") : null;
}

// Every form the same GTIN can be stored in (8, 12, 13 or 14 digits — the
// lengths articles.barcode takes), for an indexed `barcode IN (…)` lookup.
// [] when the code is no valid GTIN.
export function gtinForms(code: string): string[] {
  const key = gtinKey(code);
  if (key === null) return [];
  return [14, 13, 12, 8].filter((length) => /^0*$/.test(key.slice(0, 14 - length))).map((length) => key.slice(14 - length));
}

// Streckkod (EAN) on the article: empty clears it.
export const articleBarcodeSchema = z
  .string()
  .transform((value) => normalizeScanCode(value))
  .refine((value) => value === "" || isValidGtin(value), "Ogiltig streckkod — 8, 12, 13 eller 14 siffror med rätt kontrollsiffra")
  .transform((value) => (value === "" ? null : value));

// Lagerplatsens etikettkod: LP + the location's label_number, at least four
// digits (LP0042). Case-insensitive when read back from a scan.
export function formatLocationLabelCode(labelNumber: number): string {
  return `LP${String(labelNumber).padStart(4, "0")}`;
}

export function parseLocationLabelCode(code: string): number | null {
  const match = /^LP(\d{4,9})$/i.exec(code);
  return match ? Number(match[1]) : null;
}

// GET /scan?code= — what a scanned code is. Every match, in the order the
// scan service resolves them (location label, article by EAN, article by
// number, orders).
export const scanQuerySchema = z.object({ code: z.string().max(200) });

export type ScanMatch =
  // blocked: a Spärrad lagerplats — Utleverans does not pick it.
  | { kind: "location"; id: string; labelCode: string; name: string; warehouseName: string; active: boolean; blocked: boolean }
  | {
      kind: "article";
      id: string;
      articleNumber: string;
      name: string;
      type: "manufactured" | "purchased" | "service";
      unitCode: string;
      active: boolean;
      matchedBy: "barcode" | "articleNumber";
    }
  | { kind: "purchaseOrder"; id: string; orderNumber: string; status: string; partyName: string }
  | { kind: "salesOrder"; id: string; orderNumber: string; status: string; partyName: string }
  | { kind: "manufacturingOrder"; id: string; orderNumber: string; status: string; articleNumber: string; articleName: string };

// Etiketter: A4-ark 70 × 37 mm (24 per ark, `start` = första lediga
// etiketten) or a label printer (100 × 50 mm, one per page). `copies` per
// article/location; at most 2 000 labels in one print.
export const labelFormatSchema = z.enum(["a4", "single"]);
export type LabelFormatInput = z.infer<typeof labelFormatSchema>;

const labelPrintFields = {
  format: labelFormatSchema,
  copies: blankSafe(z.coerce.number().int().min(1).max(100)).default(1),
  start: blankSafe(z.coerce.number().int().min(1).max(24)).default(1),
};
const MAX_LABELS = 2000;

export const articleLabelsSchema = z
  .object({ articleIds: z.array(z.string().uuid()).min(1).max(500), ...labelPrintFields })
  .refine((d) => d.articleIds.length * d.copies <= MAX_LABELS, `Högst ${MAX_LABELS} etiketter per utskrift`);
export type ArticleLabelsInput = z.infer<typeof articleLabelsSchema>;

export const locationLabelsSchema = z
  .object({ locationIds: z.array(z.string().uuid()).min(1).max(500), ...labelPrintFields })
  .refine((d) => d.locationIds.length * d.copies <= MAX_LABELS, `Högst ${MAX_LABELS} etiketter per utskrift`);
export type LocationLabelsInput = z.infer<typeof locationLabelsSchema>;

// POST /stock/batches/labels (#8 etapp 2 steg 5): batch- and serienummer-
// etiketter — one label per id (a stock_batches row of either sort) and copy.
export const batchLabelsSchema = z
  .object({ batchIds: z.array(z.string().uuid()).min(1).max(MAX_LABELS), ...labelPrintFields })
  .refine((d) => d.batchIds.length * d.copies <= MAX_LABELS, `Högst ${MAX_LABELS} etiketter per utskrift`);
export type BatchLabelsInput = z.infer<typeof batchLabelsSchema>;

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

// --- GS1 (#8 etapp 2 steg 6) ---
//
// THE one reader of a GS1 element string (GS1-128, GS1 DataMatrix, GS1 QR):
// the application identifiers a package carries next to its GTIN — batch
// (10), serienummer (21), utgångsdatum (17, else bäst före 15) and antal
// (30/37). GET /scan reads the scanned code with it BEFORE normalizeScanCode
// (which drops the group separator that ends a variable field); the web has
// no copy — the server answers.
//
// null = the code is no GS1 string, or it is one that does not hold together
// (a wrong check digit, a date that is no date, a field of the wrong length,
// the same identifier twice): never half an answer. The one exception is an
// identifier this reader does not know — the reading stops there, what was
// read stands and the rest is handed back in `unparsed`.
export interface Gs1Data {
  // Digits as scanned: 14 (AI 01, else 02 — the content of a logistic unit).
  gtin: string | null;
  batch: string | null;
  serial: string | null;
  // YYYY-MM-DD.
  expiresOn: string | null;
  quantity: number | null;
  unparsed: string | null;
}

const GS = "\x1d";

type Gs1Field = { length: number; variable: boolean; digits: boolean };
const fixed = (length: number): Gs1Field => ({ length, variable: false, digits: true });
const variable = (length: number, digits = false): Gs1Field => ({ length, variable: true, digits });
const GS1_FIELDS: Record<string, Gs1Field> = {
  "00": fixed(18),
  "01": fixed(14),
  "02": fixed(14),
  "10": variable(20),
  "11": fixed(6),
  "13": fixed(6),
  "15": fixed(6),
  "17": fixed(6),
  "21": variable(20),
  "30": variable(8, true),
  "37": variable(8, true),
  "240": variable(30),
  "241": variable(30),
};
const GS1_DATES = new Set(["11", "13", "15", "17"]);

// The identifier the string starts with: two digits, three (240/241) or four
// (310x–369x: measures, six digits). null = one this reader does not know.
function gs1FieldAt(text: string): { ai: string; field: Gs1Field } | null {
  for (const length of [2, 3]) {
    const ai = text.slice(0, length);
    const field = GS1_FIELDS[ai];
    if (field) return { ai, field };
  }
  const measure = /^3[1-6]\d\d/.exec(text);
  return measure ? { ai: measure[0], field: fixed(6) } : null;
}

// GS1's character set 82 without the space: what a variable field may hold.
const GS1_TEXT = /^[!-~]+$/;

function gs1ValueOk(ai: string, field: Gs1Field, value: string): boolean {
  if (field.variable ? value.length < 1 || value.length > field.length : value.length !== field.length) return false;
  if (field.digits ? !/^\d+$/.test(value) : !GS1_TEXT.test(value)) return false;
  // 14 digits always, so isValidGtin only asks for the check digit here.
  if ((ai === "01" || ai === "02") && !isValidGtin(value)) return false;
  return true;
}

// YYMMDD → YYYY-MM-DD. GS1's century rule: the year closest to today's
// (51–99 years ahead = last century, 50–99 behind = the next); day 00 = the
// last day of the month. null = no date.
function gs1Date(value: string, todayYear: number): string | null {
  const yy = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  let day = Number(value.slice(4, 6));
  const diff = yy - (todayYear % 100);
  const year = todayYear - (todayYear % 100) + yy + (diff >= 51 ? -100 : diff <= -50 ? 100 : 0);
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = lastDay;
  if (day > lastDay) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// `today` (YYYY-MM-DD) is only the year the century rule counts from.
export function parseGs1(raw: string, opts?: { today?: string }): Gs1Data | null {
  // The scanner's Enter/tab is not part of the code; the separator is.
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/[\x00-\x1c\x1e\x1f\x7f]/g, "").trim();
  // Symbology identifiers: GS1-128, GS1 DataMatrix, GS1 QR, GS1 DataBar.
  let marked = false;
  const prefix = /^\](C1|d2|Q3|e0)/.exec(text);
  if (prefix) {
    text = text.slice(prefix[0].length);
    marked = true;
  }
  // A leading FNC1 says the same as the prefix; trailing ones say nothing.
  if (text.startsWith(GS)) marked = true;
  text = text.replace(new RegExp(`^${GS}+|${GS}+$`, "g"), "");
  if (text === "") return null;

  const todayYear = opts?.today ? Number(opts.today.slice(0, 4)) : new Date().getUTCFullYear();
  const values = new Map<string, string>();
  let unparsed: string | null = null;

  if (text.startsWith("(")) {
    // The human-readable form: (01)…(10)…(17)… — every field is delimited.
    const pattern = /\((\d{2,4})\)([^(]*)/gy;
    let end = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const ai = m[1]!;
      const known = gs1FieldAt(ai);
      if (!known || known.ai !== ai) {
        unparsed = text.slice(m.index);
        end = text.length;
        break;
      }
      const value = m[2]!.replace(new RegExp(GS, "g"), "");
      if (values.has(ai) || !gs1ValueOk(ai, known.field, value)) return null;
      values.set(ai, value);
      end = pattern.lastIndex;
    }
    if (end !== text.length) return null;
  } else {
    // The element string. Without a prefix or a leading FNC1 it must open
    // with a GTIN (01 + 14 digits, valid check digit) AND carry one more
    // field — so an ordinary code that happens to start with 01 is not GS1.
    if (!marked && !/^01\d{14}./.test(text)) return null;
    let rest = text;
    while (rest !== "") {
      const known = gs1FieldAt(rest);
      if (!known) {
        unparsed = rest;
        break;
      }
      const { ai, field } = known;
      const body = rest.slice(ai.length);
      let value: string;
      if (field.variable) {
        // Ends at the separator or at the end of the string. A scanner that
        // drops the separator makes two variable fields one — that cannot be
        // told apart here (ScanInput catches Ctrl+] for that reason).
        const stop = body.indexOf(GS);
        value = stop === -1 ? body : body.slice(0, stop);
        rest = stop === -1 ? "" : body.slice(stop + 1);
      } else {
        value = body.slice(0, field.length);
        // A separator after a fixed field is allowed, never required.
        rest = body.slice(field.length).replace(new RegExp(`^${GS}`), "");
      }
      if (values.has(ai) || !gs1ValueOk(ai, field, value)) return null;
      values.set(ai, value);
    }
    if (!marked && values.size < 2) return null;
  }
  if (values.size === 0) return null;

  for (const ai of GS1_DATES) {
    const value = values.get(ai);
    if (value !== undefined && gs1Date(value, todayYear) === null) return null;
  }
  const expiry = values.get("17") ?? values.get("15");
  const quantity = values.get("30") ?? values.get("37");
  return {
    gtin: values.get("01") ?? values.get("02") ?? null,
    batch: values.get("10") ?? null,
    serial: values.get("21") ?? null,
    expiresOn: expiry === undefined ? null : gs1Date(expiry, todayYear),
    quantity: quantity === undefined ? null : Number(quantity),
    unparsed,
  };
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
      // How the article's STOCK is tracked (stockTrackingOf): "serial" only
      // when the numbers are created at the receipt. Says which of a GS1
      // code's batch (10) and serienummer (21) the article asks for.
      stockTracking: "batch" | "serial" | null;
    }
  | { kind: "purchaseOrder"; id: string; orderNumber: string; status: string; partyName: string }
  | { kind: "salesOrder"; id: string; orderNumber: string; status: string; partyName: string }
  | { kind: "manufacturingOrder"; id: string; orderNumber: string; status: string; articleNumber: string; articleName: string }
  // A batch or a serienummer that exists on an article (#8 etapp 2 steg 6):
  // the number the code names (GS1 AI 21, else AI 10, else the whole code),
  // last in the list. `quantityOnHand` is the physical balance (a serial
  // number: 0 or 1), `locations` where it stands — blocked places included.
  | {
      kind: "batch";
      id: string;
      batchNumber: string;
      batchKind: "batch" | "serial";
      articleId: string;
      articleNumber: string;
      articleName: string;
      expiresOn: string | null;
      quantityOnHand: number;
      locations: { locationId: string; locationName: string; warehouseName: string; blocked: boolean; quantity: number }[];
    };

// What a GS1 code said next to its GTIN (parseGs1 without `unparsed`); null =
// the code is no GS1 string.
export type ScanGs1 = Pick<Gs1Data, "gtin" | "batch" | "serial" | "expiresOn" | "quantity">;

export interface ScanResult {
  code: string;
  matches: ScanMatch[];
  gs1: ScanGs1 | null;
}

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

import {
  emptyInvoiceScanResult,
  emptyScanField,
  type InvoiceScanHintField,
  type InvoiceScanResult,
  type InvoiceScanSupplier,
  type ScanField,
  type ScanFieldSource,
  type SupplierMatchedBy,
} from "@navet/shared";
import {
  findBankgiros,
  findBics,
  findForeignVatNumbers,
  findIbans,
  findOrgNumbers,
  findPlusgiros,
  findSwedishVatNumbers,
  isValidOcr,
  normalizeGiro,
  normalizeIban,
  normalizeOrgNumber,
  normalizeVatNumber,
} from "./identifiers.js";
import {
  findAmounts,
  findDates,
  formatAmountSv,
  parseDate,
  parseLastAmount,
  plausibleDueDate,
  plausibleInvoiceDate,
  round2,
} from "./invoice-values.js";
import type { PdfTextLine } from "./pdf-text.js";

// Fakturaskanning — the rules (spec §3.3). Pure: the PDF's lines, the
// company's own identifiers (filtered out — they stand on the invoice as the
// BUYER's), the active suppliers' identifiers and the matched supplier's
// learned labels in, an InvoiceScanResult out. The service adds what needs
// the database afterwards (duplicate check, purchase order matching).
//
// The rules never read invoice rows (too unreliable between templates); rows
// come from the AI or from the purchase order (§3.6).

export interface CompanyIdentity {
  name: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  postalCode: string | null;
}

export interface SupplierIdentity {
  id: string;
  name: string;
  orgNumber: string | null;
  vatNumber: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  currency: string;
  country: string;
}

export interface HintLabel {
  field: InvoiceScanHintField;
  label: string;
}

export interface RulesInput {
  lines: PdfTextLine[];
  company: CompanyIdentity;
  suppliers: SupplierIdentity[];
  // The matched supplier's learned labels (empty without a match).
  hints: HintLabel[];
  // Stockholm day, for the date plausibility.
  today: string;
  // matchSupplier's answer when the caller already has it (it needs the
  // match to load the hints).
  match?: SupplierMatch;
}

// --- Labels (svenska + engelska) ---

const B = "(?<![\\p{L}\\d])";
const E = "(?![\\p{L}])";
const label = (alternatives: string) => new RegExp(`${B}(?:${alternatives})${E}`, "iu");

interface LabelSet {
  labels: RegExp[];
  // A line matching this never answers for the field ("Summa exkl. moms"
  // is not the VAT amount, "Att betala senast" not the amount due).
  exclude?: RegExp;
}

const DUE_LABEL = "förfallodatum|förfallodag|förfaller|att betala senast|betalas senast|due\\s?date|payment\\s?due";

const LABELS: Record<InvoiceScanHintField, LabelSet> = {
  invoiceNumber: {
    labels: [label("fakturanummer|fakturanr\\.?|faktura\\s?nr\\.?|invoice\\s?no\\.?|invoice\\s?number|invoice\\s?#"), label("kreditfakturanr\\.?|kreditnota\\s?nr\\.?|credit\\s?note\\s?no\\.?")],
  },
  invoiceDate: {
    labels: [label("fakturadatum|invoice\\s?date"), label("datum|date")],
    exclude: new RegExp(DUE_LABEL, "iu"),
  },
  dueDate: { labels: [label(DUE_LABEL)] },
  paymentReference: {
    labels: [label("ocr-nummer|ocr-nr\\.?|ocrnummer|ocr|referens vid betalning|betalningsreferens|payment\\s?reference")],
  },
  grossAmount: {
    labels: [
      label("summa att betala|totalt att betala|belopp att betala|att betala|att erlägga|amount\\s?due|total\\s?due"),
      label("totalt inkl\\.?\\s?moms|total inkl\\.?\\s?moms|summa inkl\\.?\\s?moms|total\\s?amount|totalt|total|summa"),
    ],
    exclude: /exkl|excl|senast|netto|before\s+vat|\bnet\b|summa\s+moms|totalt?\s+moms(?!\p{L})|moms\s+totalt?|total\s+vat|vat\s+total/iu,
  },
  netAmount: {
    labels: [
      label("summa exkl\\.?\\s?moms|belopp exkl\\.?\\s?moms|totalt exkl\\.?\\s?moms|total exkl\\.?\\s?moms|exkl\\.?\\s?moms|nettobelopp|netto|subtotal|net\\s?amount|total\\s?excl\\.?\\s?vat"),
    ],
  },
  vatAmount: {
    labels: [label("momsbelopp|moms|mervärdesskatt|vat\\s?amount|vat|tax")],
    exclude: /exkl|excl|inkl|incl|momsreg|momsnr|vat\s*(?:no|nr|number|reg|id)|reg\.?\s*nr|org/iu,
  },
  purchaseOrderReference: {
    labels: [
      label("ert ordernummer|ert ordernr\\.?|er order|er ordernr\\.?|your\\s?order|purchase\\s?order|po\\s?(?:no|nr|number)\\.?|po|ordernummer|ordernr\\.?|order\\s?no\\.?"),
      label("er referens|your\\s?reference"),
    ],
  },
};

const ROUNDING_LINE = /öresavrundning|avrundning|rounding/iu;
const CREDIT_LINE = /kreditfaktura|kreditnota|credit\s?note|creditnote/iu;
const KNOWN_CURRENCIES = ["SEK", "EUR", "USD", "NOK", "DKK", "GBP", "CHF", "PLN", "CZK", "JPY", "CNY", "CAD", "AUD", "ISK", "HUF", "RON", "BGN"];
const CURRENCY_RE = new RegExp(`(?<![A-Z])(${KNOWN_CURRENCIES.join("|")})(?![A-Z])`);
const KRONOR_RE = /(?<![\p{L}])kr(?![\p{L}])|:-/iu;
const COMPANY_FORM = /(?<![\p{L}])(?:AB|Aktiebolag|HB|KB|Ek\.?\s?för\.?|Oy|Oyj|AS|ASA|A\/S|ApS|GmbH|AG|Ltd|Limited|Inc|LLC|BV|B\.V\.|NV|SA|S\.A\.|SRL|SpA)(?![\p{L}])/u;
const POSTAL_RE = /^(?:SE-?\s?)?(\d{3})\s?(\d{2})\s+(\p{L}[\p{L}\s-]{1,40})$/u;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lower case, trimmed, no trailing colon, collapsed whitespace, max 60 —
// how a learned label is stored and compared.
export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s:.#-]+$/g, "")
    .replace(/^[\s:.#-]+/g, "")
    .trim()
    .slice(0, 60);
}

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim();
}

// --- Value parsers per field ---

type Parsed<T> = T | null;

function parseToken(text: string): Parsed<string> {
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9\-\/._]{0,49}/g)) {
    const token = m[0].replace(/[._\-/]+$/, "");
    if (/\d/.test(token) && findDates(token).length === 0) return token;
  }
  return null;
}

function parseOcr(text: string): Parsed<string> {
  const m = /\d(?:[\d ]{0,40}\d)?/.exec(text);
  if (!m) return null;
  const digits = m[0].replace(/\s/g, "");
  return digits.length >= 2 && digits.length <= 25 ? digits : null;
}

const PARSERS: { [F in InvoiceScanHintField]: (text: string) => unknown } = {
  invoiceNumber: parseToken,
  invoiceDate: parseDate,
  dueDate: parseDate,
  paymentReference: parseOcr,
  grossAmount: parseLastAmount,
  netAmount: parseLastAmount,
  vatAmount: parseLastAmount,
  purchaseOrderReference: parseToken,
};

// --- Finding a labelled value ---

interface LabelledValue<T> {
  value: T;
  source: "rules" | "learned";
  line: PdfTextLine;
}

// The cell a character offset of line.text falls in (cells are joined with
// two spaces), with the cell's own start offset.
function cellAt(line: PdfTextLine, offset: number): { index: number; start: number } {
  let start = 0;
  for (let i = 0; i < line.cells.length; i++) {
    const end = start + line.cells[i]!.text.length;
    if (offset < end + 2 || i === line.cells.length - 1) return { index: i, start };
    start = end + 2;
  }
  return { index: 0, start: 0 };
}

const COLUMN_TOLERANCE = 40;
const BELOW_MAX_DISTANCE = 40;

// The value to the right of the label on the same line (in the label's own
// cell, else the next cell), otherwise on the line below within the label's
// x column ±40 pt.
function valueNearLabel<T>(lines: PdfTextLine[], lineIndex: number, match: RegExpExecArray, parse: (text: string) => T | null): T | null {
  const line = lines[lineIndex]!;
  const { index: cellIndex, start } = cellAt(line, match.index);
  const cell = line.cells[cellIndex]!;
  const remainder = cell.text.slice(Math.max(0, match.index + match[0].length - start)).replace(/^[\s:.#=-]+/, "");
  if (remainder !== "") {
    const value = parse(remainder);
    if (value !== null) return value;
  }
  const next = line.cells[cellIndex + 1];
  if (next) {
    const value = parse(next.text);
    if (value !== null) return value;
  }
  for (let i = lineIndex + 1; i < lines.length && i <= lineIndex + 3; i++) {
    const below = lines[i]!;
    if (below.page !== line.page || below.y - line.y > BELOW_MAX_DISTANCE) break;
    const column = below.cells.find((c) => Math.abs(c.x - cell.x) <= COLUMN_TOLERANCE);
    if (column) {
      const value = parse(column.text);
      if (value !== null) return value;
    }
  }
  return null;
}

function findLabelled<T>(
  lines: PdfTextLine[],
  field: InvoiceScanHintField,
  hints: HintLabel[],
  parse: (text: string) => T | null
): LabelledValue<T> | null {
  const set = LABELS[field];
  const learned = hints.filter((h) => h.field === field).map((h) => new RegExp(escapeRegExp(h.label), "iu"));
  const attempts: { re: RegExp; source: "rules" | "learned" }[] = [
    ...learned.map((re) => ({ re, source: "learned" as const })),
    ...set.labels.map((re) => ({ re, source: "rules" as const })),
  ];
  for (const { re, source } of attempts) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = re.exec(line.text);
      if (!match) continue;
      // The exclusion is judged on the label's own cell — a header row
      // with Fakturadatum beside Förfallodatum must still answer.
      if (set.exclude) {
        const { index: cellIndex } = cellAt(line, match.index);
        if (set.exclude.test(line.cells[cellIndex]!.text)) continue;
      }
      const value = valueNearLabel(lines, i, match, parse);
      if (value !== null) return { value, source, line };
    }
  }
  return null;
}

function field<T>(value: T | null, confidence: "high" | "low", source: ScanFieldSource): ScanField<T> {
  return value === null ? emptyScanField(source) : { value, confidence, source };
}

// --- The supplier ---

export interface SupplierMatch {
  matchedSupplierId: string | null;
  matchedBy: SupplierMatchedBy | null;
  confidence: "high" | "low";
  candidates: string[];
  // The identifiers on the invoice that are not the company's own.
  found: {
    orgNumbers: string[];
    vatNumbers: string[];
    bankgiros: string[];
    plusgiros: string[];
    ibans: string[];
    bics: string[];
  };
}

function ownIdentifiers(company: CompanyIdentity) {
  return {
    orgNumber: normalizeOrgNumber(company.orgNumber),
    vatNumber: normalizeVatNumber(company.vatNumber),
    bankgiro: normalizeGiro(company.bankgiro),
    plusgiro: normalizeGiro(company.plusgiro),
    iban: normalizeIban(company.iban),
    name: company.name ? normalizeName(company.name) : null,
  };
}

export type FoundIdentifiers = SupplierMatch["found"];

// The identifiers on the invoice's lines that are not the company's own.
function identifiersOnLines(lines: PdfTextLine[], company: CompanyIdentity): FoundIdentifiers {
  const own = ownIdentifiers(company);
  const collect = (finder: (line: string) => string[], ownValue: string | null) => {
    const values = new Set<string>();
    for (const line of lines) for (const v of finder(line.text)) if (v !== ownValue) values.add(v);
    return [...values];
  };
  const vatNumbers = [
    ...collect(findSwedishVatNumbers, own.vatNumber),
    ...collect(findForeignVatNumbers, own.vatNumber),
  ];
  // A Swedish VAT number carries the organisationsnummer.
  const orgFromVat = vatNumbers.filter((v) => v.startsWith("SE")).map((v) => v.slice(2, 12));
  const orgNumbers = [...new Set([...collect(findOrgNumbers, own.orgNumber), ...orgFromVat.filter((o) => o !== own.orgNumber)])];
  return {
    orgNumbers,
    vatNumbers,
    bankgiros: collect(findBankgiros, own.bankgiro),
    plusgiros: collect(findPlusgiros, own.plusgiro),
    ibans: collect(findIbans, own.iban),
    bics: collect(findBics, null),
  };
}

// First unique hit in the order orgnr → momsnr → bankgiro → plusgiro →
// IBAN; without one an exact normalized name match (one supplier only) as
// low. Several suppliers on the same identifier ⇒ candidates, low.
export function matchSupplier(lines: PdfTextLine[], company: CompanyIdentity, suppliers: SupplierIdentity[]): SupplierMatch {
  // Name: a cell (or a whole line) that IS a supplier's name.
  const texts: string[] = [];
  for (const line of lines) {
    texts.push(line.text);
    for (const cell of line.cells) texts.push(cell.text);
  }
  return matchSupplierOnIdentifiers(identifiersOnLines(lines, company), texts, company, suppliers);
}

// The same matching on identifiers read some other way (the AI's answer):
// `found` is normalized (identifiers.ts) — the company's own values are
// dropped here too — and `names` are texts that may BE a supplier's name.
export function matchSupplierOnIdentifiers(
  found: FoundIdentifiers,
  names: string[],
  company: CompanyIdentity,
  suppliers: SupplierIdentity[]
): SupplierMatch {
  const own = ownIdentifiers(company);
  const notOwn = (values: string[], ownValue: string | null) => [...new Set(values)].filter((v) => v !== ownValue);
  found = {
    orgNumbers: notOwn(found.orgNumbers, own.orgNumber),
    vatNumbers: notOwn(found.vatNumbers, own.vatNumber),
    bankgiros: notOwn(found.bankgiros, own.bankgiro),
    plusgiros: notOwn(found.plusgiros, own.plusgiro),
    ibans: notOwn(found.ibans, own.iban),
    bics: [...new Set(found.bics)],
  };

  const tiers: { by: SupplierMatchedBy; values: string[]; of: (s: SupplierIdentity) => string | null }[] = [
    { by: "org_number", values: found.orgNumbers, of: (s) => normalizeOrgNumber(s.orgNumber) },
    { by: "vat_number", values: found.vatNumbers, of: (s) => normalizeVatNumber(s.vatNumber) },
    { by: "bankgiro", values: found.bankgiros, of: (s) => normalizeGiro(s.bankgiro) },
    { by: "plusgiro", values: found.plusgiros, of: (s) => normalizeGiro(s.plusgiro) },
    { by: "iban", values: found.ibans, of: (s) => normalizeIban(s.iban) },
  ];
  for (const tier of tiers) {
    if (tier.values.length === 0) continue;
    const wanted = new Set(tier.values);
    const hits = suppliers.filter((s) => {
      const v = tier.of(s);
      return v !== null && wanted.has(v);
    });
    if (hits.length === 1) {
      return { matchedSupplierId: hits[0]!.id, matchedBy: tier.by, confidence: "high", candidates: [], found };
    }
    if (hits.length > 1) {
      return { matchedSupplierId: null, matchedBy: null, confidence: "low", candidates: hits.map((s) => s.id), found };
    }
  }

  // Name: a text that IS a supplier's name, normalized.
  const texts = new Set(names.map(normalizeName));
  const byName = suppliers.filter((s) => {
    const name = normalizeName(s.name);
    return name !== "" && name !== own.name && texts.has(name);
  });
  if (byName.length === 1) {
    return { matchedSupplierId: byName[0]!.id, matchedBy: "name", confidence: "low", candidates: [], found };
  }
  return {
    matchedSupplierId: null,
    matchedBy: null,
    confidence: "low",
    candidates: byName.length > 1 ? byName.map((s) => s.id) : [],
    found,
  };
}

// The supplier block for Skapa leverantör: what stood on the invoice.
function supplierFields(
  lines: PdfTextLine[],
  match: SupplierMatch,
  company: CompanyIdentity,
  matched: SupplierIdentity | null
): InvoiceScanSupplier {
  const own = ownIdentifiers(company);
  const first = (values: string[]) => (values.length > 0 ? values[0]! : null);
  const firstLines = lines.filter((l) => l.page === 1).slice(0, 15);

  let name: ScanField<string> = emptyScanField();
  if (matched) {
    name = { value: matched.name, confidence: "high", source: "supplier" };
  } else {
    for (const line of firstLines) {
      const cell = line.cells.find((c) => COMPANY_FORM.test(c.text) && normalizeName(c.text) !== own.name && !/faktura|invoice/iu.test(c.text));
      if (cell && cell.text.length <= 100) {
        name = { value: cell.text, confidence: "low", source: "rules" };
        break;
      }
    }
  }

  // Postal code + city (not the company's own), the street on the line above.
  let postalCode: ScanField<string> = emptyScanField();
  let city: ScanField<string> = emptyScanField();
  let address: ScanField<string> = emptyScanField();
  const ownPostal = (company.postalCode ?? "").replace(/\D/g, "");
  outer: for (let i = 0; i < lines.length; i++) {
    for (const cell of lines[i]!.cells) {
      const m = POSTAL_RE.exec(cell.text.trim());
      if (!m) continue;
      const digits = m[1]! + m[2]!;
      if (digits === ownPostal) continue;
      postalCode = { value: `${m[1]} ${m[2]}`, confidence: "low", source: "rules" };
      city = { value: m[3]!.trim(), confidence: "low", source: "rules" };
      const above = lines[i - 1];
      const street = above?.cells.find((c) => Math.abs(c.x - cell.x) <= COLUMN_TOLERANCE);
      if (street && /\d/.test(street.text) && /\p{L}/u.test(street.text) && street.text.length <= 100) {
        address = { value: street.text, confidence: "low", source: "rules" };
      }
      break outer;
    }
  }

  const vat = first(match.found.vatNumbers);
  const iban = first(match.found.ibans);
  const orgNumber = first(match.found.orgNumbers);
  const country = vat && !vat.startsWith("SE") ? (vat.startsWith("EL") ? "GR" : vat.slice(0, 2)) : vat || orgNumber ? "SE" : iban ? iban.slice(0, 2) : null;
  const sure = (value: string | null): ScanField<string> => field(value, "high", "rules");
  return {
    matchedSupplierId: match.matchedSupplierId,
    matchedBy: match.matchedBy,
    confidence: match.confidence,
    candidates: match.candidates,
    name,
    orgNumber: sure(orgNumber ? `${orgNumber.slice(0, 6)}-${orgNumber.slice(6)}` : null),
    vatNumber: sure(vat),
    bankgiro: sure(first(match.found.bankgiros)),
    plusgiro: sure(first(match.found.plusgiros)),
    iban: sure(iban),
    bic: sure(first(match.found.bics)),
    address,
    postalCode,
    city,
    country: field(country, "low", "rules"),
  };
}

// --- The whole interpretation ---

export function interpretRules(input: RulesInput): InvoiceScanResult {
  const { lines, company, suppliers, hints, today } = input;
  const result = emptyInvoiceScanResult();
  const checks: string[] = [];
  const match = input.match ?? matchSupplier(lines, company, suppliers);
  const matched = match.matchedSupplierId ? suppliers.find((s) => s.id === match.matchedSupplierId) ?? null : null;
  result.supplier = supplierFields(lines, match, company, matched);
  if (!matched) {
    checks.push(
      match.candidates.length > 1
        ? "Flera leverantörer i registret passar fakturan — välj rätt leverantör"
        : "Ingen leverantör i registret har fakturans organisationsnummer, momsnummer, bankgiro, plusgiro eller IBAN"
    );
  } else if (match.matchedBy === "name") {
    checks.push("Leverantören hittades bara på namnet — kontrollera att det är rätt leverantör");
  }

  const find = <F extends InvoiceScanHintField>(f: F) =>
    findLabelled(lines, f, hints, PARSERS[f] as (text: string) => ReturnType<(typeof PARSERS)[F]>);

  // Fakturanummer.
  const invoiceNumber = find("invoiceNumber") as LabelledValue<string> | null;
  if (invoiceNumber) result.invoiceNumber = { value: invoiceNumber.value, confidence: "high", source: invoiceNumber.source };

  // Datum, with rimlighet.
  const invoiceDate = find("invoiceDate") as LabelledValue<string> | null;
  if (invoiceDate) {
    const ok = plausibleInvoiceDate(invoiceDate.value, today);
    result.invoiceDate = { value: invoiceDate.value, confidence: ok ? "high" : "low", source: invoiceDate.source };
    if (!ok) checks.push(`Fakturadatumet ${invoiceDate.value} ligger mer än 400 dagar från i dag`);
  }
  const dueDate = find("dueDate") as LabelledValue<string> | null;
  if (dueDate) {
    const ok = plausibleDueDate(dueDate.value, result.invoiceDate.value);
    result.dueDate = { value: dueDate.value, confidence: ok ? "high" : "low", source: dueDate.source };
    if (!ok) checks.push(`Förfallodagen ${dueDate.value} ligger före fakturadatumet eller mer än 180 dagar efter det`);
  }

  // Belopp + summakontrollen.
  const gross = find("grossAmount") as LabelledValue<number> | null;
  const net = find("netAmount") as LabelledValue<number> | null;
  const vat = find("vatAmount") as LabelledValue<number> | null;
  const rounding = lines.some((l) => ROUNDING_LINE.test(l.text));
  const tolerance = rounding ? 0.5 : 0.01;
  let grossValue = gross?.value ?? null;
  let netValue = net?.value ?? null;
  let vatValue = vat?.value ?? null;
  let amountsHigh = false;
  if (grossValue !== null && netValue !== null && vatValue !== null) {
    const diff = round2(netValue + vatValue - grossValue);
    if (Math.abs(diff) <= tolerance + 1e-9) amountsHigh = true;
    else checks.push(`Netto + moms stämmer inte med att betala (diff ${formatAmountSv(Math.abs(diff))})`);
  } else if (grossValue !== null && vatValue !== null) {
    netValue = round2(grossValue - vatValue);
    checks.push("Nettobeloppet hittades inte — beräknat som att betala minus moms");
  } else if (grossValue !== null && netValue !== null) {
    vatValue = round2(grossValue - netValue);
    checks.push("Momsbeloppet hittades inte — beräknat som att betala minus netto");
  } else if (netValue !== null && vatValue !== null) {
    grossValue = round2(netValue + vatValue);
    checks.push("Att betala hittades inte — beräknat som netto plus moms");
  }

  // Kreditnota: the heading says so, or the amount due is negative. LF has no
  // credit flow of its own — negative amounts are how it is entered today.
  const creditHeading = lines.filter((l) => l.page === 1).slice(0, 12).some((l) => CREDIT_LINE.test(l.text));
  const isCredit = creditHeading || (grossValue !== null && grossValue < 0);
  result.isCreditNote = { value: isCredit, confidence: creditHeading || grossValue !== null ? "high" : "low", source: "rules" };
  if (isCredit) {
    const negate = (v: number | null) => (v === null || v <= 0 ? v : -v);
    grossValue = negate(grossValue);
    netValue = negate(netValue);
    vatValue = vatValue === 0 ? 0 : negate(vatValue);
  }
  const amountConfidence = amountsHigh ? "high" : "low";
  const amountSource = (found: LabelledValue<number> | null): ScanFieldSource => found?.source ?? "rules";
  result.grossAmount = field(grossValue, amountConfidence, amountSource(gross));
  result.netAmount = field(netValue, amountConfidence, amountSource(net));
  result.vatAmount = field(vatValue, amountConfidence, amountSource(vat));

  // Momssats: moms/netto ∈ {25, 12, 6} % ±0,5 procentenheter; moms 0 hos en
  // utländsk leverantör ⇒ 0.
  if (netValue !== null && vatValue !== null) {
    if (Math.abs(vatValue) < 0.005) {
      const foreign = matched !== null && matched.country !== "SE";
      result.vatRate = { value: 0, confidence: foreign ? "high" : "low", source: "rules" };
    } else if (Math.abs(netValue) >= 0.005) {
      const rate = (vatValue / netValue) * 100;
      const standard = [25, 12, 6].find((r) => Math.abs(rate - r) <= 0.5);
      if (standard !== undefined) result.vatRate = { value: standard, confidence: amountConfidence, source: "rules" };
      else checks.push(`Momsen är ${rate.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} % av nettot — ingen av 25, 12 eller 6 %`);
    }
  }

  // OCR: Luhn ⇒ ocr/high, otherwise the reference is a message (low).
  const reference = find("paymentReference") as LabelledValue<string> | null;
  if (reference) {
    result.paymentReference = isValidOcr(reference.value)
      ? { value: { kind: "ocr", value: reference.value }, confidence: "high", source: reference.source }
      : { value: { kind: "message", value: reference.value }, confidence: "low", source: reference.source };
    if (!isValidOcr(reference.value)) checks.push("OCR-numret har ingen giltig kontrollsiffra — det föreslås som meddelande");
  }

  // Valuta: an ISO code (or kr) on the amount lines; the supplier invoice
  // always gets the supplier's currency, so a different one is a check.
  const amountLines = [gross?.line, net?.line, vat?.line].filter((l): l is PdfTextLine => l !== undefined);
  let printed: string | null = null;
  for (const line of amountLines) {
    const m = CURRENCY_RE.exec(line.text);
    if (m) {
      printed = m[1]!;
      break;
    }
  }
  if (printed === null) {
    const currencyLine = lines.find((l) => /(?<![\p{L}])(?:valuta|currency)(?![\p{L}])/iu.test(l.text) && CURRENCY_RE.test(l.text));
    if (currencyLine) printed = CURRENCY_RE.exec(currencyLine.text)![1]!;
  }
  if (printed === null && amountLines.some((l) => KRONOR_RE.test(l.text))) printed = "SEK";
  if (matched) {
    if (printed === null || printed === matched.currency) {
      result.currency = { value: matched.currency, confidence: "high", source: printed === null ? "supplier" : "rules" };
    } else {
      result.currency = { value: matched.currency, confidence: "low", source: "supplier" };
      checks.push(`Fakturan anger ${printed} men leverantören har ${matched.currency} — leverantörsfakturan får leverantörens valuta`);
    }
  } else if (printed !== null) {
    result.currency = { value: printed, confidence: "low", source: "rules" };
  }

  // Er order — matched against the purchase orders by the service.
  const po = find("purchaseOrderReference") as LabelledValue<string> | null;
  if (po) result.purchaseOrderReference = { value: po.value, confidence: "high", source: po.source };

  result.checks = checks;
  return result;
}

// --- Leverantörsinlärningen (spec §3.3): where the confirmed value stands,
// and the label before it. ---

export interface FinalValues {
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  paymentReference?: string | null;
  grossAmount?: number | null;
  netAmount?: number | null;
  vatAmount?: number | null;
  purchaseOrderReference?: string | null;
}

// Where in a cell the value stands (start offset), or -1.
function valueOffset(fieldName: InvoiceScanHintField, cellText: string, value: string | number): number {
  switch (fieldName) {
    case "invoiceDate":
    case "dueDate": {
      const hit = findDates(cellText).find((d) => d.value === value);
      return hit ? hit.index : -1;
    }
    case "grossAmount":
    case "netAmount":
    case "vatAmount": {
      const hit = findAmounts(cellText).find((a) => Math.abs(Math.abs(a.value) - Math.abs(value as number)) < 0.005);
      return hit ? hit.index : -1;
    }
    case "paymentReference": {
      const wanted = String(value).replace(/\s/g, "");
      const m = /\d(?:[\d ]{0,40}\d)?/g;
      for (const hit of cellText.matchAll(m)) if (hit[0].replace(/\s/g, "") === wanted) return hit.index!;
      return -1;
    }
    default: {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(String(value))}(?![A-Za-z0-9])`, "i");
      const hit = re.exec(cellText);
      return hit ? hit.index : -1;
    }
  }
}

function usableLabel(raw: string): string | null {
  const normalized = normalizeLabel(raw);
  return normalized.length >= 2 && /\p{L}/u.test(normalized) ? normalized : null;
}

// For each field with a final value: the first place the value stands in
// the text layer with a label on its own line — the text to its left in the
// same cell, or the cell to its left — and only when there is none, the cell
// above it in the same column (a header row). A table column header ("Belopp"
// above a row amount) thereby never beats the summary line's own label.
// Fields whose value is not in the text learn nothing.
export function learnLabels(lines: PdfTextLine[], finals: FinalValues): HintLabel[] {
  const learned: HintLabel[] = [];
  for (const [name, value] of Object.entries(finals) as [InvoiceScanHintField, string | number | null | undefined][]) {
    if (value === null || value === undefined || value === "") continue;
    let fromAbove: string | null = null;
    let found: string | null = null;
    search: for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (let c = 0; c < line.cells.length; c++) {
        const cell = line.cells[c]!;
        const offset = valueOffset(name, cell.text, value);
        if (offset < 0) continue;
        const sameLine = usableLabel(cell.text.slice(0, offset)) ?? (c > 0 ? usableLabel(line.cells[c - 1]!.text) : null);
        if (sameLine) {
          found = sameLine;
          break search;
        }
        if (fromAbove === null) {
          const aboveLine = lines[i - 1];
          const aboveCell =
            aboveLine && aboveLine.page === line.page && line.y - aboveLine.y <= BELOW_MAX_DISTANCE
              ? aboveLine.cells.find((a) => Math.abs(a.x - cell.x) <= COLUMN_TOLERANCE)
              : undefined;
          fromAbove = aboveCell ? usableLabel(aboveCell.text) : null;
        }
      }
    }
    const label = found ?? fromAbove;
    if (label) learned.push({ field: name, label });
  }
  return learned;
}

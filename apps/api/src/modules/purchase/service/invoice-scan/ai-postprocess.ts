import {
  BIC_PATTERN,
  emptyInvoiceScanResult,
  emptyScanField,
  isLuhnValid,
  isValidIban,
  type InvoiceScanResult,
  type InvoiceScanRow,
  type ScanField,
} from "@navet/shared";
import type { AiInvoiceFields } from "./ai-fields.js";
import {
  findForeignVatNumbers,
  isValidOcr,
  isValidOrgNumber,
  normalizeGiro,
  normalizeIban,
  normalizeOrgNumber,
  normalizeVatNumber,
} from "./identifiers.js";
import { formatAmountSv, plausibleDueDate, plausibleInvoiceDate, round2 } from "./invoice-values.js";
import type { PdfTextLine } from "./pdf-text.js";
import {
  matchSupplier,
  matchSupplierOnIdentifiers,
  type CompanyIdentity,
  type FoundIdentifiers,
  type SupplierIdentity,
  type SupplierMatch,
} from "./rules-interpreter.js";

// Fakturaskanning — the AI's answer through the same local checks as the
// rules (spec §3.4): supplier matching on the identifiers it read (the
// company's own dropped), check digits (orgnr/BG/PG Luhn, IBAN mod 97, OCR
// mod 10), date plausibility, the sum check, the VAT rate and the currency.
// The AI's confidence is only ever LOWERED here when a check fails, never
// raised; a value that fails its check digit is kept (for the review) but
// never used for matching. The service then adds the duplicate check and the
// purchase order matching (postProcess), as for the rules. Pure.

export interface AiPostProcessInput {
  fields: AiInvoiceFields;
  company: CompanyIdentity;
  suppliers: SupplierIdentity[];
  today: string;
  // The PDF's text layer when it has one (empty for photos and scans): an
  // öresavrundning line widens the sum check like the rules, and the
  // supplier is matched on the text when the AI's identifiers match none.
  lines: PdfTextLine[];
}

type Conf = "high" | "low";

const ROUNDING_LINE = /öresavrundning|avrundning|rounding/iu;

function ai<T>(value: T | null, confidence: Conf): ScanField<T> {
  return value === null ? emptyScanField("ai") : { value, confidence, source: "ai" };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validVat(normalized: string): boolean {
  const se = /^SE(\d{10})01$/.exec(normalized);
  if (se) return isValidOrgNumber(se[1]!);
  return findForeignVatNumbers(normalized).includes(normalized);
}

const sameDigits = (a: string | null, b: string | null) => a !== null && b !== null && a === b;

export function interpretAiAnswer(input: AiPostProcessInput): InvoiceScanResult {
  const { fields, company, suppliers, today, lines } = input;
  const result = emptyInvoiceScanResult();
  const checks: string[] = [];
  const s = fields.supplier;

  // --- The supplier's identifiers: own ones dropped, check digits verified ---
  const own = {
    orgNumber: normalizeOrgNumber(company.orgNumber),
    vatNumber: normalizeVatNumber(company.vatNumber),
    bankgiro: normalizeGiro(company.bankgiro),
    plusgiro: normalizeGiro(company.plusgiro),
    iban: normalizeIban(company.iban),
  };
  const found: FoundIdentifiers = { orgNumbers: [], vatNumbers: [], bankgiros: [], plusgiros: [], ibans: [], bics: [] };

  const identifier = (
    read: { value: string | null; confidence: Conf },
    label: string,
    normalize: (raw: string) => string | null,
    valid: (normalized: string) => boolean,
    ownValue: string | null,
    into: string[],
    display: (normalized: string) => string = (n) => n
  ): ScanField<string> => {
    if (read.value === null) return emptyScanField("ai");
    const normalized = normalize(read.value);
    if (normalized !== null && sameDigits(normalized, ownValue)) {
      checks.push(`AI-tolkningen angav ert eget ${label} som leverantörens — det används inte`);
      return emptyScanField("ai");
    }
    if (normalized === null || !valid(normalized)) {
      checks.push(`Leverantörens ${label} ${read.value} är inte giltigt — kontrollera det mot fakturan`);
      return { value: read.value, confidence: "low", source: "ai" };
    }
    into.push(normalized);
    return { value: display(normalized), confidence: read.confidence, source: "ai" };
  };

  const orgNumber = identifier(s.orgNumber, "organisationsnummer", normalizeOrgNumber, isValidOrgNumber, own.orgNumber, found.orgNumbers, (n) => `${n.slice(0, 6)}-${n.slice(6)}`);
  const vatNumber = identifier(s.vatNumber, "momsregistreringsnummer", normalizeVatNumber, validVat, own.vatNumber, found.vatNumbers);
  // A Swedish VAT number carries the organisationsnummer.
  for (const vat of found.vatNumbers) {
    const org = /^SE(\d{10})01$/.exec(vat)?.[1];
    if (org && org !== own.orgNumber && !found.orgNumbers.includes(org)) found.orgNumbers.push(org);
  }
  const giro = (len: [number, number]) => (n: string) => n.length >= len[0] && n.length <= len[1] && isLuhnValid(n);
  const bankgiro = identifier(s.bankgiro, "bankgironummer", normalizeGiro, giro([7, 8]), own.bankgiro, found.bankgiros, (n) => `${n.slice(0, -4)}-${n.slice(-4)}`);
  const plusgiro = identifier(s.plusgiro, "plusgironummer", normalizeGiro, giro([2, 8]), own.plusgiro, found.plusgiros, (n) => `${n.slice(0, -1)}-${n.slice(-1)}`);
  const iban = identifier(s.iban, "IBAN", normalizeIban, isValidIban, own.iban, found.ibans);
  const bic = identifier(s.bic, "BIC", (raw) => raw.replace(/\s/g, "").toUpperCase() || null, (n) => BIC_PATTERN.test(n), null, found.bics);

  let match: SupplierMatch = matchSupplierOnIdentifiers(found, s.name.value ? [s.name.value] : [], company, suppliers);
  if (match.matchedSupplierId === null && match.candidates.length === 0 && lines.length > 0) {
    // The text layer may carry what the AI missed.
    const onText = matchSupplier(lines, company, suppliers);
    if (onText.matchedSupplierId !== null || onText.candidates.length > 0) match = { ...onText, found: match.found };
  }
  const matched = match.matchedSupplierId ? suppliers.find((x) => x.id === match.matchedSupplierId) ?? null : null;
  if (!matched) {
    checks.push(
      match.candidates.length > 1
        ? "Flera leverantörer i registret passar fakturan — välj rätt leverantör"
        : "Ingen leverantör i registret har fakturans organisationsnummer, momsnummer, bankgiro, plusgiro eller IBAN"
    );
  } else if (match.matchedBy === "name") {
    checks.push("Leverantören hittades bara på namnet — kontrollera att det är rätt leverantör");
  }
  const country = s.country.value?.trim().toUpperCase() ?? null;
  result.supplier = {
    matchedSupplierId: match.matchedSupplierId,
    matchedBy: match.matchedBy,
    confidence: match.confidence,
    candidates: match.candidates,
    name: matched ? { value: matched.name, confidence: "high", source: "supplier" } : ai(s.name.value?.slice(0, 200) ?? null, s.name.confidence),
    orgNumber,
    vatNumber,
    bankgiro,
    plusgiro,
    iban,
    bic,
    address: ai(s.address.value, s.address.confidence),
    postalCode: ai(s.postalCode.value, s.postalCode.confidence),
    city: ai(s.city.value, s.city.confidence),
    country: country === null ? emptyScanField("ai") : ai(country, /^[A-Z]{2}$/.test(country) ? s.country.confidence : "low"),
  };

  // --- Fakturanummer ---
  const invoiceNumber = fields.invoiceNumber.value;
  if (invoiceNumber !== null) {
    const fits = invoiceNumber.length <= 50;
    result.invoiceNumber = ai(invoiceNumber.slice(0, 50), fits ? fields.invoiceNumber.confidence : "low");
    if (!fits) checks.push("Fakturanumret är längre än 50 tecken — kontrollera det mot fakturan");
  }

  // --- Datum, with rimlighet ---
  const date = (read: { value: string | null; confidence: Conf }, label: string): ScanField<string> => {
    if (read.value === null) return emptyScanField("ai");
    if (!isIsoDate(read.value)) {
      checks.push(`${label} ${read.value} är inget giltigt datum — fyll i det för hand`);
      return emptyScanField("ai");
    }
    return ai(read.value, read.confidence);
  };
  result.invoiceDate = date(fields.invoiceDate, "Fakturadatumet");
  if (result.invoiceDate.value !== null && !plausibleInvoiceDate(result.invoiceDate.value, today)) {
    result.invoiceDate.confidence = "low";
    checks.push(`Fakturadatumet ${result.invoiceDate.value} ligger mer än 400 dagar från i dag`);
  }
  result.dueDate = date(fields.dueDate, "Förfallodagen");
  if (result.dueDate.value !== null && !plausibleDueDate(result.dueDate.value, result.invoiceDate.value)) {
    result.dueDate.confidence = "low";
    checks.push(`Förfallodagen ${result.dueDate.value} ligger före fakturadatumet eller mer än 180 dagar efter det`);
  }

  // --- Belopp + summakontrollen ---
  let gross = fields.grossAmount.value;
  let net = fields.netAmount.value;
  let vat = fields.vatAmount.value;
  const conf = { gross: fields.grossAmount.confidence, net: fields.netAmount.confidence, vat: fields.vatAmount.confidence };
  const creditSaid = fields.isCreditNote.value === true;
  const isCredit = creditSaid || (gross !== null && gross < 0);
  if (isCredit) {
    const negate = (v: number | null) => (v === null || v <= 0 ? v : -v);
    gross = negate(gross);
    net = negate(net);
    vat = vat === 0 ? 0 : negate(vat);
  }
  const tolerance = lines.some((l) => ROUNDING_LINE.test(l.text)) ? 0.5 : 0.01;
  let sumOk = false;
  if (gross !== null && net !== null && vat !== null) {
    const diff = round2(net + vat - gross);
    if (Math.abs(diff) <= tolerance + 1e-9) sumOk = true;
    else checks.push(`Netto + moms stämmer inte med att betala (diff ${formatAmountSv(Math.abs(diff))})`);
  } else if (gross !== null && vat !== null) {
    net = round2(gross - vat);
    conf.net = "low";
    checks.push("Nettobeloppet hittades inte — beräknat som att betala minus moms");
  } else if (gross !== null && net !== null) {
    vat = round2(gross - net);
    conf.vat = "low";
    checks.push("Momsbeloppet hittades inte — beräknat som att betala minus netto");
  } else if (net !== null && vat !== null) {
    gross = round2(net + vat);
    conf.gross = "low";
    checks.push("Att betala hittades inte — beräknat som netto plus moms");
  }
  if (!sumOk) {
    conf.gross = "low";
    conf.net = "low";
    conf.vat = "low";
  }
  result.grossAmount = ai(gross, conf.gross);
  result.netAmount = ai(net, conf.net);
  result.vatAmount = ai(vat, conf.vat);
  result.isCreditNote =
    fields.isCreditNote.value === null && gross === null
      ? emptyScanField("ai")
      : ai(isCredit, fields.isCreditNote.value === null ? "low" : fields.isCreditNote.confidence);

  // --- Momssats: the AI's rate must be a Swedish one and agree with the
  // amounts; without one it is derived like the rules (never above low
  // unless the amounts are sure). ---
  const ratio = net !== null && vat !== null && Math.abs(net) >= 0.005 ? (vat / net) * 100 : null;
  const aiRate = fields.vatRate.value;
  if (aiRate !== null) {
    let rateConf: Conf = fields.vatRate.confidence;
    if (![25, 12, 6, 0].includes(aiRate)) {
      rateConf = "low";
      checks.push(`Momssatsen ${aiRate} % är ingen av 25, 12, 6 eller 0 %`);
    } else if (ratio !== null && Math.abs(ratio - aiRate) > 0.5) {
      rateConf = "low";
      checks.push(`Momsen är ${ratio.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} % av nettot men momssatsen ${aiRate} %`);
    }
    result.vatRate = ai(aiRate, rateConf);
  } else if (vat !== null && Math.abs(vat) < 0.005 && net !== null) {
    result.vatRate = ai(0, matched !== null && matched.country !== "SE" && sumOk ? "high" : "low");
  } else if (ratio !== null) {
    const standard = [25, 12, 6].find((r) => Math.abs(ratio - r) <= 0.5);
    if (standard !== undefined) result.vatRate = ai(standard, sumOk ? "high" : "low");
    else checks.push(`Momsen är ${ratio.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} % av nettot — ingen av 25, 12 eller 6 %`);
  }

  // --- OCR: Luhn decides ocr; otherwise the reference is a message (low) ---
  const ref = fields.paymentReference;
  if (ref.value !== null) {
    const digits = ref.value.replace(/\s/g, "");
    if (ref.kind === "ocr" && /^\d{2,25}$/.test(digits) && isValidOcr(digits)) {
      result.paymentReference = { value: { kind: "ocr", value: digits }, confidence: ref.confidence, source: "ai" };
    } else if (ref.kind === "ocr") {
      result.paymentReference = { value: { kind: "message", value: ref.value.slice(0, 100) }, confidence: "low", source: "ai" };
      checks.push("OCR-numret har ingen giltig kontrollsiffra — det föreslås som meddelande");
    } else {
      result.paymentReference = { value: { kind: "message", value: ref.value.slice(0, 100) }, confidence: ref.confidence, source: "ai" };
    }
  }

  // --- Valuta: the supplier invoice always gets the supplier's ---
  const printedRaw = fields.currency.value?.trim().toUpperCase() ?? null;
  const printed = printedRaw === "KR" ? "SEK" : printedRaw !== null && /^[A-Z]{3}$/.test(printedRaw) ? printedRaw : null;
  if (matched) {
    if (printed === null) {
      result.currency = { value: matched.currency, confidence: "high", source: "supplier" };
    } else if (printed === matched.currency) {
      result.currency = ai(matched.currency, fields.currency.confidence);
    } else {
      result.currency = { value: matched.currency, confidence: "low", source: "supplier" };
      checks.push(`Fakturan anger ${printed} men leverantören har ${matched.currency} — leverantörsfakturan får leverantörens valuta`);
    }
  } else if (printed !== null) {
    result.currency = ai(printed, "low");
  }

  // --- Er order (matched against the purchase orders by the service) ---
  if (fields.purchaseOrderReference.value !== null) {
    result.purchaseOrderReference = ai(fields.purchaseOrderReference.value.slice(0, 50), fields.purchaseOrderReference.confidence);
  }

  // --- Rader: antal × à-pris must give the line amount (±1 %, min 0,01) ---
  result.rows = fields.rows.map((row): InvoiceScanRow => {
    let confidence: Conf = row.confidence;
    if (row.quantity !== null && row.unitPrice !== null && row.lineAmount !== null) {
      const expected = row.quantity * row.unitPrice;
      if (Math.abs(expected - row.lineAmount) > Math.max(0.01, Math.abs(row.lineAmount) * 0.01)) confidence = "low";
    } else {
      confidence = "low";
    }
    return {
      description: row.description.slice(0, 500),
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineAmount: row.lineAmount,
      vatRate: row.vatRate,
      supplierArticleNumber: row.supplierArticleNumber,
      articleId: null,
      purchaseOrderRowId: null,
      confidence,
    };
  });
  if (result.rows.length > 0 && net !== null && result.rows.every((r) => r.lineAmount !== null)) {
    const sum = round2(result.rows.reduce((acc, r) => acc + r.lineAmount!, 0));
    if (Math.abs(Math.abs(sum) - Math.abs(net)) > 1) {
      checks.push(`Radernas summa ${formatAmountSv(sum)} stämmer inte med nettot ${formatAmountSv(net)}`);
    }
  }

  result.checks = checks;
  return result;
}

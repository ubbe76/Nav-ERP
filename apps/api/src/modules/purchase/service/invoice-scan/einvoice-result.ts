import { emptyInvoiceScanResult, emptyScanField, isLuhnValid, isValidIban, type InvoiceScanResult, type InvoiceScanRow, type ScanField, round4 } from "@navet/shared";
import type { ReceivedEInvoice } from "../../../einvoice/service/ubl/received-einvoice.js";
import { isValidOcr, isValidOrgNumber, normalizeGiro, normalizeIban, normalizeOrgNumber, normalizeVatNumber } from "./identifiers.js";
import { formatAmountSv, round2 } from "./invoice-values.js";
import { matchSupplierOnIdentifiers, type CompanyIdentity, type FoundIdentifiers, type SupplierIdentity } from "./rules-interpreter.js";

// Fakturaskanning — a received e-invoice (ReceivedEInvoice, read out of the
// UBL) as the inbox's InvoiceScanResult (spec 2026-11-05-e-faktura-
// mottagning, "Tolkningen till inkorgens resultat"). Everything the document
// states is `high` with the source `einvoice`; the supplier is matched
// locally through the same matchSupplierOnIdentifiers as the AI's answer
// (the company's own identifiers dropped), the currency always becomes the
// supplier's, a PaymentID that passes mod 10 is an OCR number, and the
// buyer's item number (our article number) gives articleId. The service
// then runs the purchase order matching (postProcess) as for the rules.
// Pure: no DB.

export interface EInvoiceResultInput {
  einvoice: ReceivedEInvoice;
  company: CompanyIdentity;
  suppliers: SupplierIdentity[];
  // Our articles whose number equals a line's BuyersItemIdentification/ID.
  articles: { articleNumber: string; id: string }[];
  // Checks the reception adds (an attachment too large to use …).
  extraChecks?: string[];
}

type Conf = "high" | "low";

function field<T>(value: T | null, confidence: Conf = "high"): ScanField<T> {
  return value === null ? emptyScanField("einvoice") : { value, confidence, source: "einvoice" };
}

const canon = (value: string) => value.trim().toUpperCase();

export function interpretEInvoice(input: EInvoiceResultInput): InvoiceScanResult {
  const { einvoice: doc, company, suppliers } = input;
  const result = emptyInvoiceScanResult();
  const checks: string[] = [...(input.extraChecks ?? [])];
  const seller = doc.seller;

  // --- The seller's identifiers (the company's own are dropped by the matcher) ---
  const found: FoundIdentifiers = { orgNumbers: [], vatNumbers: [], bankgiros: [], plusgiros: [], ibans: [], bics: [] };
  const orgCandidate = seller.companyId && (seller.companyId.scheme === "0007" || seller.companyId.scheme === null) ? seller.companyId.value : null;
  const orgNormalized = normalizeOrgNumber(orgCandidate);
  const orgNumber = orgNormalized !== null && isValidOrgNumber(orgNormalized) ? orgNormalized : null;
  if (orgNumber) found.orgNumbers.push(orgNumber);
  const vatNormalized = normalizeVatNumber(seller.vatNumber);
  if (vatNormalized) {
    found.vatNumbers.push(vatNormalized);
    const fromVat = /^SE(\d{10})01$/.exec(vatNormalized)?.[1];
    if (fromVat && isValidOrgNumber(fromVat) && !found.orgNumbers.includes(fromVat)) found.orgNumbers.push(fromVat);
  }
  // Every account the document names feeds the matching; the first of each
  // kind is what the proposal shows.
  let bankgiro: string | null = null;
  let plusgiro: string | null = null;
  let iban: string | null = null;
  let bic: string | null = null;
  for (const account of doc.payment.accounts) {
    if (account.kind === "bankgiro") {
      const normalized = normalizeGiro(account.account);
      if (normalized && normalized.length >= 7 && normalized.length <= 8 && isLuhnValid(normalized)) {
        found.bankgiros.push(normalized);
        bankgiro ??= normalized;
      }
    } else if (account.kind === "plusgiro") {
      const normalized = normalizeGiro(account.account);
      if (normalized && normalized.length >= 2 && normalized.length <= 8 && isLuhnValid(normalized)) {
        found.plusgiros.push(normalized);
        plusgiro ??= normalized;
      }
    } else if (account.kind === "iban") {
      const normalized = normalizeIban(account.iban);
      if (normalized && isValidIban(normalized)) {
        found.ibans.push(normalized);
        iban ??= normalized;
      }
      bic ??= account.bic;
    } else {
      bic ??= account.bic;
    }
  }

  const match = matchSupplierOnIdentifiers(found, [seller.name], company, suppliers);
  const matched = match.matchedSupplierId ? (suppliers.find((s) => s.id === match.matchedSupplierId) ?? null) : null;
  if (!matched) {
    checks.push(
      match.candidates.length > 1
        ? "Flera leverantörer i registret passar e-fakturan — välj rätt leverantör"
        : "Ingen leverantör i registret har e-fakturans organisationsnummer, momsnummer, bankgiro, plusgiro eller IBAN — skapa leverantören eller välj rätt"
    );
  } else if (match.matchedBy === "name") {
    checks.push("Leverantören hittades bara på namnet — kontrollera att det är rätt leverantör");
  }
  const displayOrg = orgNumber ? `${orgNumber.slice(0, 6)}-${orgNumber.slice(6)}` : (orgCandidate ?? null);
  result.supplier = {
    matchedSupplierId: match.matchedSupplierId,
    matchedBy: match.matchedBy,
    confidence: match.confidence,
    candidates: match.candidates,
    name: matched ? { value: matched.name, confidence: "high", source: "supplier" } : field(seller.name.slice(0, 200)),
    orgNumber: field(displayOrg, orgNumber ? "high" : "low"),
    vatNumber: field(vatNormalized ?? seller.vatNumber),
    bankgiro: field(bankgiro ? `${bankgiro.slice(0, -4)}-${bankgiro.slice(-4)}` : null),
    plusgiro: field(plusgiro ? `${plusgiro.slice(0, -1)}-${plusgiro.slice(-1)}` : null),
    iban: field(iban),
    bic: field(bic),
    address: field(seller.address.lines.length > 0 ? seller.address.lines.join(", ") : null),
    postalCode: field(seller.address.postalCode),
    city: field(seller.address.city),
    country: field(seller.address.country),
  };

  // --- Fakturanummer, datum ---
  result.invoiceNumber = field(doc.number.slice(0, 50));
  result.invoiceDate = field(doc.issueDate);
  result.dueDate = field(doc.dueDate);

  // --- Belopp + summakontrollen (a credit note's amounts turn negative) ---
  const credit = doc.type === "credit_note";
  const sign = credit ? -1 : 1;
  const vatFromBreakdown = doc.vat.length > 0 ? round2(doc.vat.reduce((sum, v) => sum + v.taxAmount, 0)) : null;
  const vatRaw = doc.totals.taxAmount ?? vatFromBreakdown ?? 0;
  const grossRaw = doc.totals.payableAmount;
  const rounding = doc.totals.payableRoundingAmount ?? 0;
  // BT-113: payable = tax inclusive − prepaid + rounding.
  const prepaid = doc.totals.prepaidAmount ?? 0;
  const netRaw = doc.totals.taxExclusiveAmount ?? doc.totals.lineExtensionAmount ?? round2(grossRaw + prepaid - rounding - vatRaw);
  const diff = round2(netRaw + vatRaw - prepaid + rounding - grossRaw);
  const sumOk = Math.abs(diff) <= 0.01 + 1e-9;
  if (!sumOk) checks.push(`Netto + moms stämmer inte med att betala (diff ${formatAmountSv(Math.abs(diff))})`);
  if (prepaid > 0) checks.push(`E-fakturan anger ${formatAmountSv(prepaid)} som redan betalt — att betala är resten`);
  const conf: Conf = sumOk ? "high" : "low";
  result.grossAmount = field(round2(sign * grossRaw), conf);
  result.netAmount = field(round2(sign * netRaw), conf);
  result.vatAmount = field(vatRaw === 0 ? 0 : round2(sign * vatRaw), conf);
  result.isCreditNote = field(credit);

  // --- Momssats: set when the breakdown has exactly one rate ---
  const rates = [...new Set(doc.vat.map((v) => v.percent ?? 0))];
  if (rates.length === 1) result.vatRate = field(rates[0]!);
  else if (rates.length === 0 && doc.lines.length > 0) {
    const lineRates = [...new Set(doc.lines.map((l) => l.vatRate ?? 0))];
    if (lineRates.length === 1) result.vatRate = field(lineRates[0]!);
  }

  // --- OCR (mod 10) or a message ---
  const paymentId = doc.payment.paymentId?.trim() ?? null;
  if (paymentId) {
    const digits = paymentId.replace(/\s/g, "");
    if (/^\d{2,25}$/.test(digits) && isValidOcr(digits)) result.paymentReference = field({ kind: "ocr", value: digits });
    else result.paymentReference = field({ kind: "message", value: paymentId.slice(0, 100) });
  }

  // --- Valuta: the supplier invoice always gets the supplier's ---
  if (matched) {
    if (doc.currency === matched.currency) result.currency = field(matched.currency);
    else {
      result.currency = { value: matched.currency, confidence: "low", source: "supplier" };
      checks.push(`E-fakturan är i ${doc.currency} men leverantören har ${matched.currency} — leverantörsfakturan får leverantörens valuta`);
    }
  } else {
    result.currency = field(doc.currency, "low");
  }

  // --- Er order ---
  if (doc.orderReference) result.purchaseOrderReference = field(doc.orderReference.slice(0, 50));

  // --- Rader ---
  const byNumber = new Map(input.articles.map((a) => [canon(a.articleNumber), a.id]));
  result.rows = doc.lines.map((line): InvoiceScanRow => {
    const adjusted = line.allowanceAmount !== 0 || line.chargeAmount !== 0;
    let unitPrice: number | null = line.unitPrice;
    if ((adjusted || unitPrice === null) && line.quantity !== 0) unitPrice = round4(line.lineAmount / line.quantity);
    return {
      description: (line.description || line.sellerItemNumber || `Rad ${line.id}`).slice(0, 500),
      quantity: line.quantity,
      unitPrice,
      lineAmount: line.lineAmount,
      vatRate: line.vatRate,
      supplierArticleNumber: line.sellerItemNumber,
      articleId: line.buyerItemNumber ? (byNumber.get(canon(line.buyerItemNumber)) ?? null) : null,
      purchaseOrderRowId: null,
      confidence: "high",
    };
  });
  if (result.rows.length > 0) {
    const sum = round2(result.rows.reduce((acc, r) => acc + r.lineAmount!, 0));
    const lineTotal = doc.totals.lineExtensionAmount ?? netRaw;
    if (Math.abs(sum - lineTotal) > 1) checks.push(`Radernas summa ${formatAmountSv(sum)} stämmer inte med nettot ${formatAmountSv(lineTotal)}`);
  }

  result.checks = checks;
  return result;
}

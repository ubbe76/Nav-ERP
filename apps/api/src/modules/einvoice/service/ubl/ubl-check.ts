// Structural check of a UblInvoiceInput before anything leaves Nav — the
// e-invoice counterpart of pain001-check.ts. The builder's element order is
// fixed in code and pinned by the XSD test, so data is all that can be wrong:
// this is the list of what Peppol (or the access point's schematron) would
// refuse, in Swedish, one sentence per finding, so the user can fix the
// company data / customer / invoice instead of reading a schematron id.
//
// It checks the INPUT plus the figures the builder will print (computeTotals,
// linePricing — the same functions, so check and document can never
// disagree), never the XML. Real schematron validation is the access point's
// job at import; the rules verified here are the ones that depend on Nav's
// data: PEPPOL-EN16931-R003 (BT-10/BT-13), R008 (no empty elements), R010/
// R020 (endpoints), R120/R040 (line arithmetic within 0.02), BR-CO-17 /
// BR-S-09 (category VAT within ±1), BR-E-09 (exempt ⇒ 0 VAT), BR-CO-25 (due
// date or payment terms), BR-27 (price ≥ 0), SE-R-001/002 (VAT number),
// SE-R-003/004/013 (org number: 10 digits, Luhn), SE-R-006 (S only for
// 25/12/6), SE-R-007..010 (bankgiro/plusgiro digits and length — only when
// there is an account; PaymentMeans itself is optional), and for foreign
// customers and currencies (spec 2026-11-05): BR-IC-02/11/12 (K needs the
// buyer's VAT number, a delivery date and the deliver-to country), BR-O-11..
// 14 (O alone on the invoice), BR-53/R005/R055 (VAT in SEK on a foreign-
// currency invoice that carries VAT).
import { BIC_PATTERN, isLuhnValid, isValidIban, isValidOcrReference } from "@navet/shared";
import { identifierProblem } from "../peppol-schemes.js";
import { computeTotals, linePricing, toCents } from "./ubl-invoice-builder.js";
import type { UblCheckResult, UblInvoiceInput, UblLine, UblPostalAddress } from "./ubl-types.js";
import { isOutOfScopeVatCode, isSupportedLineVat, isSupportedVatCode, lineVatCategory } from "./vat-categories.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// xs:date rejects 2026-13-01 and 2026-02-30, so the pattern is not enough.
function isCalendarDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
const blank = (value: string | null | undefined) => (value ?? "").trim() === "";
const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");
const SE_VAT = /^SE\d{12}$/;
const SCHEME = /^\d{4}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;

// Peppol's R120/R040 slack; BR-CO-17/BR-S-09 allow |diff| < 1.
const LINE_SLACK = 0.02;
const VAT_SLACK = 1;
// A stored amount has two decimals; anything else means the service passed
// an unrounded figure (toCents would silently round it).
const isMoney = (value: number) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

function checkAddress(address: UblPostalAddress, who: string, problems: string[]): void {
  if (!COUNTRY.test((address.country ?? "").trim().toUpperCase())) problems.push(`${who} land saknas eller är inte en landskod med två bokstäver.`);
}

function checkLine(line: UblLine, problems: string[]): void {
  const row = `Rad ${line.lineNumber}`;
  if (blank(line.description)) problems.push(`${row} saknar benämning.`);
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) problems.push(`${row} måste ha ett antal större än 0.`);
  if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) problems.push(`${row} har ett negativt à-pris.`);
  if (!Number.isFinite(line.discountPercent) || line.discountPercent < 0 || line.discountPercent > 100) problems.push(`${row} har en rabatt utanför 0–100 %.`);
  if (!isMoney(line.lineAmount)) problems.push(`${row} har ett radbelopp som inte är ett belopp med två decimaler.`);
  if (!isMoney(line.vatAmount) || line.vatAmount < 0) problems.push(`${row} har ett momsbelopp som inte är ett belopp med två decimaler.`);
  // Momskoder (spec 4.5): the code decides the category (vat-categories.ts);
  // UTM (räntefakturor) and unknown codes have none.
  if (line.vatCode != null && !isSupportedVatCode(line.vatCode)) {
    problems.push(`${row} har momskoden ${line.vatCode} som inte stöds i e-faktura.`);
  } else if (!isSupportedLineVat(line)) {
    problems.push(`${row} har en momssats som inte stöds i e-faktura (${line.vatRate} %).`);
  } else if (line.vatRate === 0 && toCents(line.vatAmount) !== 0) {
    problems.push(`${row} har 0 % moms men ändå ett momsbelopp.`);
  }
  for (const property of line.properties) {
    if (blank(property.name) || blank(property.value)) problems.push(`${row} har en konfigurationsrad utan namn eller värde.`);
  }
  // Only when the basics hold is the arithmetic meaningful.
  if (line.quantity > 0 && line.unitPrice >= 0 && isMoney(line.lineAmount) && line.discountPercent >= 0 && line.discountPercent <= 100) {
    const pricing = linePricing(line);
    if (pricing.allowance && pricing.allowance.amountCents < 0) problems.push(`${row}: rabatten stämmer inte med radbeloppet.`);
    if (Math.abs(pricing.residual) > LINE_SLACK) problems.push(`${row}: antal × à-pris − rabatt stämmer inte med radbeloppet (avvikelse ${pricing.residual.toFixed(2)} kr).`);
  }
}

export function checkUblInput(input: UblInvoiceInput): UblCheckResult {
  const problems: string[] = [];
  const credit = input.type === "credit";
  const document = credit ? "Kreditfakturan" : "Fakturan";

  if (blank(input.invoiceNumber)) problems.push(`${document} saknar fakturanummer.`);
  if (!isCalendarDate(input.issueDate)) problems.push(`${document} saknar giltigt fakturadatum.`);
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!CURRENCY.test(currency)) problems.push(`${document} saknar giltig valutakod.`);
  if (blank(input.buyerReference) && blank(input.orderReference)) {
    problems.push("Peppol kräver er referens eller ert ordernummer på fakturan — ange minst ett av dem (kundnumret används annars som referens).");
  }
  if (credit) {
    if (blank(input.creditedInvoiceNumber)) problems.push("Kreditfakturan saknar hänvisning till den krediterade fakturan.");
  } else if (input.dueDate !== null && !isCalendarDate(input.dueDate)) {
    problems.push("Fakturans förfallodatum är ogiltigt.");
  }

  // Seller — company_info.
  const seller = input.seller;
  if (blank(seller.name)) problems.push("Företagets namn saknas i Företagsuppgifter.");
  const orgNumber = digits(seller.orgNumber);
  if (orgNumber.length !== 10) problems.push("Företagets organisationsnummer måste vara tio siffror (Företagsuppgifter).");
  else if (!isLuhnValid(orgNumber)) problems.push("Företagets organisationsnummer har fel kontrollsiffra (Företagsuppgifter).");
  const vatNumber = (seller.vatNumber ?? "").toUpperCase().replace(/\s/g, "");
  if (!SE_VAT.test(vatNumber)) problems.push("Företagets momsregistreringsnummer måste ha formen SE + 12 siffror, t.ex. SE556677889901 (Företagsuppgifter).");
  if ((seller.address.country ?? "").trim().toUpperCase() !== "SE") problems.push("Företagets land måste vara SE (Företagsuppgifter).");

  // Buyer — the customer and the invoice snapshot.
  const buyer = input.buyer;
  if (blank(buyer.name)) problems.push("Kundens namn saknas på fakturan.");
  const scheme = (buyer.endpoint.scheme ?? "").trim();
  const endpointValue = scheme === "0007" ? digits(buyer.endpoint.value) : (buyer.endpoint.value ?? "").trim();
  if (!SCHEME.test(scheme)) problems.push("Kundens Peppol-id måste börja med ett fyrsiffrigt schema, t.ex. 0007:5566778899.");
  // PEPPOL-COMMON-R040..R049: the known schemes' formats and check digits,
  // on the endpoint and on the registration number written with a scheme.
  const endpointProblem = endpointValue === "" ? null : identifierProblem(scheme, endpointValue);
  if (endpointValue === "") problems.push("Kundens Peppol-id saknas — ange Peppol-id eller organisationsnummer på kunden.");
  else if (endpointProblem) problems.push(`Kundens Peppol-id med schema ${scheme} måste vara ${endpointProblem}.`);
  const orgScheme = (buyer.orgNumberScheme ?? "").trim();
  if (orgScheme && !blank(buyer.orgNumber)) {
    const value = orgScheme === "0007" ? digits(buyer.orgNumber) : (buyer.orgNumber ?? "").trim();
    const orgProblem = identifierProblem(orgScheme, value);
    if (orgProblem) problems.push(`Kundens organisationsnummer måste vara ${orgProblem}.`);
  }
  checkAddress(buyer.address, "Kundens", problems);

  const categories = new Set(
    input.lines.filter((line) => isSupportedLineVat(line)).map((line) => lineVatCategory(line, input.language).id)
  );
  // BR-AE-02: omvänd betalningsskyldighet (OB, EUT) needs the buyer's VAT
  // identifier — Utfärda has already demanded it; the snapshot is checked.
  if (categories.has("AE") && blank(buyer.vatNumber)) {
    problems.push("Omvänd betalningsskyldighet kräver kundens momsregistreringsnummer på fakturan.");
  }
  // BR-IC-02/11/12: an intra-community supply names the buyer's VAT number,
  // the delivery date and the country the goods went to.
  if (categories.has("K")) {
    if (blank(buyer.vatNumber)) problems.push("Unionsintern leverans kräver kundens momsregistreringsnummer på fakturan.");
    if (!input.delivery || !isCalendarDate(input.delivery.date)) problems.push("Unionsintern leverans kräver leveransdatum på fakturan.");
    if (!input.delivery || !COUNTRY.test((input.delivery.country ?? "").trim().toUpperCase())) problems.push("Unionsintern leverans kräver leveranslandet på fakturan.");
  }
  // BR-O-11..14: "Not subject to VAT" is the only category on its invoice.
  if (categories.has("O") && (categories.size > 1 || input.lines.some((line) => !isOutOfScopeVatCode(line.vatCode)))) {
    problems.push("Export av tjänster (momskod EXT) kan inte stå på samma e-faktura som andra momskoder — fakturera tjänsterna för sig.");
  }

  // Payment — company_info; only an invoice asks for money. PaymentMeans is
  // optional in Peppol BIS (BR-CO-25 wants a due date or terms, not an
  // account): without one the builder omits the whole group, OCR included,
  // and the settings page has already warned about it.
  const account = input.payment.account;
  if (account) {
    if (account.kind === "bankgiro") {
      const number = digits(account.account);
      if (!/^\d{7,8}$/.test(number) || !isLuhnValid(number)) problems.push("Företagets bankgiro är ogiltigt (Företagsuppgifter).");
    } else if (account.kind === "plusgiro") {
      const number = digits(account.account);
      if (!/^\d{2,8}$/.test(number) || !isLuhnValid(number)) problems.push("Företagets plusgiro är ogiltigt (Företagsuppgifter).");
    } else {
      if (!isValidIban((account.iban ?? "").toUpperCase().replace(/\s/g, ""))) problems.push("Företagets IBAN är ogiltigt (Företagsuppgifter).");
      if (account.bic !== null && !BIC_PATTERN.test(account.bic.trim().toUpperCase())) problems.push("Företagets BIC är ogiltigt (Företagsuppgifter).");
    }
  }
  if (input.payment.ocrNumber !== null && !isValidOcrReference(input.payment.ocrNumber.trim())) problems.push("Fakturans OCR-nummer är ogiltigt.");

  // Attachment.
  const file = input.attachment;
  if (file) {
    if (blank(file.filename)) problems.push("PDF-bilagan saknar filnamn.");
    if (file.content.length === 0) problems.push("PDF-bilagan är tom.");
  }

  // Lines.
  if (input.lines.length === 0) problems.push(`${document} har inga rader.`);
  const seen = new Set<number>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.lineNumber) || line.lineNumber < 1 || seen.has(line.lineNumber)) problems.push(`Radnumret ${line.lineNumber} är inte ett unikt positivt heltal.`);
    seen.add(line.lineNumber);
    checkLine(line, problems);
  }

  // Totals — only computable when every rate is supported.
  if (input.lines.length > 0 && input.lines.every((line) => isSupportedLineVat(line) && isMoney(line.lineAmount) && isMoney(line.vatAmount))) {
    const totals = computeTotals(input.lines, input.language);
    // BR-53 / R005 / R055: the VAT in SEK on another currency's invoice
    // (ML 17 kap. 29 §) — present exactly when there is VAT to state.
    const tax = input.taxCurrency;
    if (currency !== "SEK" && totals.taxTotalCents !== 0 && !tax) problems.push(`${document} i ${currency} saknar momsen i SEK.`);
    if (tax) {
      if (tax.currency === currency) problems.push("Momsen i redovisningsvalutan kan inte anges i fakturans egen valuta.");
      if (!isMoney(tax.vatAmount) || Math.sign(tax.vatAmount) !== Math.sign(totals.taxTotalCents)) {
        problems.push("Momsen i SEK stämmer inte med fakturans moms.");
      }
    }
    for (const subtotal of totals.subtotals) {
      const expectedCents = Math.round(subtotal.taxableCents * (subtotal.category.percent / 100));
      if (Math.abs(subtotal.taxCents - expectedCents) / 100 >= VAT_SLACK) {
        problems.push(
          `Momsen för ${subtotal.category.percent} % (${(subtotal.taxCents / 100).toFixed(2)} kr) avviker mer än en krona från ${subtotal.category.percent} % av underlaget ${(subtotal.taxableCents / 100).toFixed(2)} kr.`
        );
      }
    }
    // BR-CO-25: a positive amount due needs a due date or payment terms.
    if (!credit && totals.grossCents > 0 && blank(input.dueDate) && blank(input.paymentTermsNote)) {
      problems.push("Fakturan saknar både förfallodatum och betalningsvillkor.");
    }
  }
  return problems;
}

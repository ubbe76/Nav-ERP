import { CLEARING_SYSTEMS, isClearingSystem, isEeaCountry, paymentKind, type ChargeBearer, type DebitAccountKind, type PaymentKind, type SupplierPaymentMethod } from "@navet/shared";
import type { CreditorSnapshot } from "@navet/db";
import { stockholmDateTime } from "../banking-dates.js";
import type { BankProfile, DomesticMethod } from "./bank-profiles.js";
import { sanitizeText, type CharsetHolder } from "./sanitize.js";
import { el, renderXml, type XmlChild, type XmlElement } from "./xml-writer.js";

export interface Pain001Creditor {
  name: string;
  postalCode: string | null;
  city: string | null;
  method: SupplierPaymentMethod;
  bankgiro: string | null;
  plusgiro: string | null;
  clearing: string | null;
  account: string | null;
  iban: string | null;
  bic: string | null;
  // Valuta steg 2 — a payee abroad. Omitted = a Swedish payee (SE, SHAR).
  street?: string | null;
  country?: string;
  foreignAccount?: string | null;
  clearingSystem?: string | null;
  clearingMemberId?: string | null;
  bankName?: string | null;
  chargeBearer?: ChargeBearer;
}
export interface Pain001Item {
  endToEndId: string;
  amount: number;
  executionDate: string;
  creditor: Pain001Creditor;
  // generated = Nav's own default message, truncated silently to fit.
  reference: { kind: "ocr" | "message"; value: string; generated?: boolean };
  // The invoice's currency — InstdAmt Ccy (omitted = SEK).
  currency?: string;
  // KU81: Skatteverkets betalningskod when the payment is reported (the
  // service decides on the 150 000 kr threshold), else null/omitted.
  regulatoryReportingCode?: string | null;
}
export interface Pain001Input {
  messageId: string;
  createdAt: Date;
  debtor: {
    name: string;
    orgNumber: string | null;
    postalCode: string | null;
    city: string | null;
    account: { kind: DebitAccountKind; value: string };
    // The account a payment abroad is drawn from (the profile's
    // foreign.debitAccountKinds) — null when the company has none.
    foreignAccount?: { kind: DebitAccountKind; value: string } | null;
    initiatingPartyId: string | null;
    agreementId: string | null;
  };
  items: Pain001Item[];
}
export interface BuiltPain001Item {
  endToEndId: string;
  snapshot: CreditorSnapshot;
  warnings: string[];
}

// ISO 4217 currencies without minor units (exponent 0). Their amounts are
// written without decimals — the banks validate the fraction digits against
// the currency (CGI-MP) — and pain001-check refuses one that has öre-like
// decimals (Nav stores every amount with two, spec §9).
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
// An amount as the file writes it: two decimals, none for a currency
// without minor units. CtrlSum (a plain decimal over all currencies) keeps two.
const amountText = (amount: number, currency = "SEK") => amount.toFixed(ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2);
const digits = (value: string | null) => (value ?? "").replace(/\D/g, "");

const KIND_ORDER: Record<PaymentKind, number> = { domestic: 0, sepa: 1, international: 2 };
// PmtInfId suffix per group: domestic keeps `${MsgId}-${YYYYMMDD}` exactly.
const GROUP_SUFFIX = { domestic: "", sepa: "S", SHAR: "I", DEBT: "D" } as const;

export function defaultPaymentMessage(invoiceNumber: string, messageMax: number, kind: PaymentKind = "domestic"): string {
  // A payee abroad reads English ("Invoice"), a Swedish one Swedish.
  const word = kind === "domestic" ? "Faktura" : "Invoice";
  const text = messageMax >= 20 ? `${word} ${invoiceNumber}` : invoiceNumber;
  return text.slice(0, messageMax);
}

export function initiatingPartyIdFor(input: Pain001Input, profile: BankProfile): string | null {
  if (input.debtor.initiatingPartyId) return input.debtor.initiatingPartyId;
  return profile.initiatingParty.fallback === "orgNumber" ? digits(input.debtor.orgNumber) || null : null;
}

// The item's betalningstyp — the same pure rule the batch card shows.
export function itemKind(item: Pick<Pain001Item, "currency" | "creditor">): PaymentKind {
  return paymentKind({ currency: item.currency ?? "SEK", method: item.creditor.method, iban: item.creditor.iban });
}

// The creditor's country: an IBAN names it, otherwise the supplier's.
export function creditorCountry(creditor: Pain001Creditor): string {
  return (creditor.country ?? "SE").toUpperCase();
}

// Where the receiving bank is — the IBAN's country, a foreign account's
// clearing system or BIC, else the supplier's country (Nordea's EU/EEA rule).
export function creditorBankCountry(creditor: Pain001Creditor): string {
  if (creditor.method === "iban" && creditor.iban) return creditor.iban.slice(0, 2).toUpperCase();
  if (creditor.bic && creditor.bic.length >= 6) return creditor.bic.slice(4, 6).toUpperCase();
  if (creditor.clearingSystem && isClearingSystem(creditor.clearingSystem)) return CLEARING_SYSTEMS[creditor.clearingSystem].country;
  return creditorCountry(creditor);
}

// ChrgBr: SEPA always SLEV, international the supplier's SHAR/DEBT, none
// for a domestic payment.
export function chargeBearerFor(item: Pain001Item, kind: PaymentKind = itemKind(item)): "SLEV" | ChargeBearer | null {
  if (kind === "domestic") return null;
  if (kind === "sepa") return "SLEV";
  return item.creditor.chargeBearer ?? "SHAR";
}

// The length limits and character set a text of the item is fitted into.
export function itemRule(item: Pain001Item, profile: BankProfile, kind: PaymentKind = itemKind(item)) {
  if (kind === "domestic") {
    const rule = profile.creditor[item.creditor.method as DomesticMethod];
    return { nameMax: rule.nameMax, messageMax: rule.messageMax, ocrMax: rule.ocrMax, charset: profile as CharsetHolder };
  }
  return { nameMax: profile.foreign.nameMax, messageMax: profile.foreign.messageMax, ocrMax: 25, charset: { charset: profile.foreign.charset } as CharsetHolder };
}

// The value written in CdtrAcct for the creditor's method.
export function creditorAccount(creditor: Pain001Creditor, profile: BankProfile): string {
  switch (creditor.method) {
    case "bankgiro":
      return creditor.bankgiro ?? "";
    case "plusgiro":
      return creditor.plusgiro ?? "";
    case "iban":
      return creditor.iban ?? "";
    case "foreign_account":
      return creditor.foreignAccount ?? "";
    case "bank_account": {
      const clearing = creditor.clearing ?? "";
      const account = creditor.account ?? "";
      if (!profile.bban.includeClearing) return account;
      const four = clearing.slice(0, 4);
      if ((profile.bban.withoutClearing ?? []).some(([from, to]) => four >= from && four <= to)) return account;
      // Swedbank: "8CCCCznnnnnnnnn (always 15 digits)", zero fill between.
      if (profile.bban.padSwedbank8To15 && clearing.startsWith("8")) return clearing + account.padStart(15 - clearing.length, "0");
      return clearing + account;
    }
  }
}

// The town as written in TwnNm (Max35Text) — "" when nothing survives the
// bank's character set; the structural check treats that as a missing town.
export function townName(city: string | null, profile: CharsetHolder): string {
  return city ? sanitizeText(city, profile, 35).value : "";
}

// A payee abroad: StrtNm (Max70Text) from the supplier's street address —
// its lines joined — and PstCd as text (UK and Canadian codes have letters).
export function streetName(street: string | null | undefined, charset: CharsetHolder) {
  return sanitizeText((street ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(", "), charset, 70);
}
export function foreignPostalCode(code: string | null, charset: CharsetHolder): string {
  return code ? sanitizeText(code, charset, 16).value : "";
}

// Swedish postal codes are digits ("802 22" → 80222). An element is written
// only when it has content: an empty PstCd/TwnNm would break Max16Text/
// Max35Text (minLength 1).
function postalAddress(postalCode: string | null, city: string | null, profile: BankProfile): XmlElement {
  const code = digits(postalCode);
  const town = townName(city, profile);
  return el("PstlAdr", [
    profile.address.fields.includes("PstCd") && code ? el("PstCd", code) : null,
    profile.address.fields.includes("TwnNm") && town ? el("TwnNm", town) : null,
    el("Ctry", "SE"),
  ]);
}

function orgOther(id: string, scheme: "BANK" | "CUST"): XmlElement {
  return el("Id", [el("OrgId", [el("Othr", [el("Id", id), el("SchmeNm", [el("Cd", scheme)])])])]);
}

function debtorAccount(account: { kind: DebitAccountKind; value: string }, withCurrency = true): XmlElement {
  const id =
    account.kind === "iban"
      ? el("Id", [el("IBAN", account.value)])
      : el("Id", [el("Othr", [el("Id", account.value), el("SchmeNm", [account.kind === "bankgiro" ? el("Prtry", "BGNR") : el("Cd", "BBAN")])])]);
  return el("DbtrAcct", [id, withCurrency ? el("Ccy", "SEK") : null]);
}

function creditorAgent(creditor: Pain001Creditor, profile: BankProfile): XmlChild {
  const agent = profile.creditor[creditor.method as DomesticMethod].agent;
  const clearing = (memberId: string) =>
    el("CdtrAgt", [el("FinInstnId", [el("ClrSysMmbId", [el("ClrSysId", [el("Cd", "SESBA")]), el("MmbId", memberId)])])]);
  switch (agent.kind) {
    case "clearing":
      return clearing(agent.memberId);
    case "clearing_from_account":
      return clearing(agent.memberIdDigits ? (creditor.clearing ?? "").slice(0, agent.memberIdDigits) : creditor.clearing ?? "");
    case "bic":
      return el("CdtrAgt", [el("FinInstnId", [el("BIC", agent.bic)])]);
    case "bic_from_supplier":
      return creditor.bic ? el("CdtrAgt", [el("FinInstnId", [el("BIC", creditor.bic)])]) : null;
    case "none":
      return null;
  }
}

// The bank name a creditor agent carries next to a bare national bank id
// (profiles with creditorAgentNameWithClearing) — "" when none is written.
export function foreignAgentName(creditor: Pain001Creditor, profile: BankProfile): string {
  if (creditor.method !== "foreign_account" || creditor.bic || !creditor.clearingSystem || !profile.foreign.creditorAgentNameWithClearing) return "";
  return creditor.bankName ? sanitizeText(creditor.bankName, { charset: profile.foreign.charset }, 70).value : "";
}

// Abroad: an IBAN in SEPA is IBAN-only (no agent at all — SEB: "Creditor
// Agent should not be used at all for IBAN only"); any other IBAN carries its
// BIC; a foreign account carries the BIC and/or the national bank id, plus
// the bank's name and country where the profile wants them.
function foreignCreditorAgent(creditor: Pain001Creditor, kind: PaymentKind, profile: BankProfile): XmlChild {
  if (creditor.method === "iban") {
    if (kind === "sepa" || !creditor.bic) return null;
    return el("CdtrAgt", [el("FinInstnId", [el("BIC", creditor.bic)])]);
  }
  if (creditor.method !== "foreign_account") return null;
  const system = creditor.clearingSystem && isClearingSystem(creditor.clearingSystem) ? creditor.clearingSystem : null;
  const name = foreignAgentName(creditor, profile);
  const children: XmlChild[] = [
    creditor.bic ? el("BIC", creditor.bic) : null,
    system && creditor.clearingMemberId ? el("ClrSysMmbId", [el("ClrSysId", [el("Cd", system)]), el("MmbId", creditor.clearingMemberId)]) : null,
    name ? el("Nm", name) : null,
    name && system ? el("PstlAdr", [el("Ctry", CLEARING_SYSTEMS[system].country)]) : null,
  ];
  return children.some(Boolean) ? el("CdtrAgt", [el("FinInstnId", children)]) : null;
}

function creditorAccountElement(creditor: Pain001Creditor, profile: BankProfile): XmlElement {
  const scheme = profile.creditor[creditor.method as DomesticMethod].scheme;
  const value = creditorAccount(creditor, profile);
  if (scheme === "IBAN") return el("CdtrAcct", [el("Id", [el("IBAN", value)])]);
  return el("CdtrAcct", [
    el("Id", [el("Othr", [el("Id", value), el("SchmeNm", [scheme === "BGNR" ? el("Prtry", "BGNR") : el("Cd", "BBAN")])])]),
  ]);
}

// Abroad: IBAN, or the account number as Othr/Id with SchmeNm/Cd BBAN.
function foreignCreditorAccountElement(creditor: Pain001Creditor, profile: BankProfile): XmlElement {
  const value = creditorAccount(creditor, profile);
  if (creditor.method === "iban") return el("CdtrAcct", [el("Id", [el("IBAN", value)])]);
  return el("CdtrAcct", [el("Id", [el("Othr", [el("Id", value), el("SchmeNm", [el("Cd", "BBAN")])])])]);
}

// KU81 in the profile's form (pain.001.001.03 RegulatoryReporting3:
// DbtCdtRptgInd, Authrty, Dtls(Tp, Dt, Ctry, Cd, Amt, Inf)).
function regulatoryReportingElement(code: string, info: string, profile: BankProfile): XmlElement {
  switch (profile.foreign.regulatoryReporting) {
    case "code":
      return el("RgltryRptg", [el("Dtls", [el("Cd", code)])]);
    case "indicator_code":
      return el("RgltryRptg", [el("DbtCdtRptgInd", "DEBT"), el("Dtls", [el("Cd", code)])]);
    case "country_code_info":
      return el("RgltryRptg", [el("Dtls", [el("Ctry", "SE"), el("Cd", code), info ? el("Inf", info) : null])]);
  }
}

function remittanceElement(item: Pain001Item, referenceValue: string, profile: BankProfile, currency: string): XmlElement {
  return item.reference.kind === "ocr"
    ? el("RmtInf", [
        el("Strd", [
          profile.remittance.scorWithRemittedAmount ? el("RfrdDocAmt", [el("RmtdAmt", amountText(item.amount, currency), { Ccy: currency })]) : null,
          el("CdtrRefInf", [el("Tp", [el("CdOrPrtry", [el("Cd", "SCOR")])]), el("Ref", referenceValue)]),
        ]),
      ])
    : el("RmtInf", [el("Ustrd", referenceValue)]);
}

interface PaymentGroup {
  date: string;
  kind: PaymentKind;
  chargeBearer: "SLEV" | ChargeBearer | null;
  items: Pain001Item[];
}

// PmtInf per (utförandedag, betalningstyp, avgiftsfördelning) — the debit
// account follows the kind (domestic: the bank settings' account; abroad:
// the profile's foreign debit account). Ascending date, then domestic →
// SEPA → international, SHAR before DEBT. An all-domestic batch gets exactly
// the PmtInfs of before (one per date).
export function paymentGroups(items: Pain001Item[]): PaymentGroup[] {
  const groups = new Map<string, PaymentGroup>();
  for (const item of items) {
    const kind = itemKind(item);
    const chargeBearer = chargeBearerFor(item, kind);
    const key = `${item.executionDate}|${kind}|${chargeBearer ?? ""}`;
    const group = groups.get(key) ?? { date: item.executionDate, kind, chargeBearer, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const bearerOrder = (b: PaymentGroup["chargeBearer"]) => (b === "DEBT" ? 1 : 0);
  return [...groups.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || bearerOrder(a.chargeBearer) - bearerOrder(b.chargeBearer)
  );
}

export function paymentInfoId(messageId: string, group: Pick<PaymentGroup, "date" | "kind" | "chargeBearer">): string {
  const suffix = group.kind === "domestic" ? GROUP_SUFFIX.domestic : group.kind === "sepa" ? GROUP_SUFFIX.sepa : GROUP_SUFFIX[group.chargeBearer === "DEBT" ? "DEBT" : "SHAR"];
  return `${messageId}-${group.date.replace(/-/g, "")}${suffix}`;
}

export function buildPain001(input: Pain001Input, profile: BankProfile): { xml: string; items: BuiltPain001Item[] } {
  const built: BuiltPain001Item[] = [];
  const total = input.items.reduce((sum, item) => sum + item.amount, 0);
  const initiatingId = initiatingPartyIdFor(input, profile);
  const debtorName = sanitizeText(input.debtor.name, profile, 70).value;

  const domesticTransaction = (item: Pain001Item) => {
    const rule = profile.creditor[item.creditor.method as DomesticMethod];
    const warnings: string[] = [];
    const name = sanitizeText(item.creditor.name, profile, rule.nameMax);
    if (name.truncated) warnings.push(`Mottagarens namn kortas till ${rule.nameMax} tecken: "${name.value}"`);
    else if (name.changed) warnings.push(`Mottagarens namn skickas som "${name.value}"`);
    let referenceValue = item.reference.value;
    if (item.reference.kind === "message") {
      const message = sanitizeText(item.reference.value, profile, rule.messageMax);
      if (message.changed && !item.reference.generated) warnings.push(`Meddelandet skickas som "${message.value}"`);
      referenceValue = message.value;
    }
    built.push({
      endToEndId: item.endToEndId,
      warnings,
      snapshot: {
        method: item.creditor.method,
        account: creditorAccount(item.creditor, profile),
        clearing: item.creditor.method === "bank_account" ? item.creditor.clearing : null,
        bic: item.creditor.method === "iban" ? item.creditor.bic : null,
        name: name.value,
        postalCode: digits(item.creditor.postalCode) || null,
        // What was sent in TwnNm — null when the profile writes none.
        city: profile.address.fields.includes("TwnNm") ? townName(item.creditor.city, profile) || null : null,
        referenceKind: item.reference.kind,
        reference: referenceValue,
        kind: "domestic",
        currency: "SEK",
      },
    });
    return el("CdtTrfTxInf", [
      el("PmtId", [el("InstrId", item.endToEndId), el("EndToEndId", item.endToEndId)]),
      el("Amt", [el("InstdAmt", amountText(item.amount), { Ccy: "SEK" })]),
      creditorAgent(item.creditor, profile),
      el("Cdtr", [el("Nm", name.value), postalAddress(item.creditor.postalCode, item.creditor.city, profile)]),
      creditorAccountElement(item.creditor, profile),
      remittanceElement(item, referenceValue, profile, "SEK"),
    ]);
  };

  const foreignTransaction = (item: Pain001Item, kind: PaymentKind, chargeBearer: "SLEV" | ChargeBearer) => {
    const c = item.creditor;
    const currency = (item.currency ?? "SEK").toUpperCase();
    const charset: CharsetHolder = { charset: profile.foreign.charset };
    const { nameMax, messageMax } = profile.foreign;
    const warnings: string[] = [];
    const name = sanitizeText(c.name, charset, nameMax);
    if (name.truncated) warnings.push(`Mottagarens namn kortas till ${nameMax} tecken: "${name.value}"`);
    else if (name.changed) warnings.push(`Mottagarens namn skickas som "${name.value}"`);
    const street = streetName(c.street, charset);
    if (street.truncated) warnings.push(`Mottagarens gatuadress kortas till 70 tecken: "${street.value}"`);
    else if (street.changed && street.value !== "") warnings.push(`Mottagarens gatuadress skickas som "${street.value}"`);
    const town = townName(c.city, charset);
    if (town && c.city && town !== c.city.normalize("NFC").trim()) warnings.push(`Mottagarens ort skickas som "${town}"`);
    const postalCode = foreignPostalCode(c.postalCode, charset);
    let referenceValue = item.reference.value;
    if (item.reference.kind === "message") {
      const message = sanitizeText(item.reference.value, charset, messageMax);
      if (message.changed && !item.reference.generated) warnings.push(`Meddelandet skickas som "${message.value}"`);
      referenceValue = message.value;
    }
    const country = creditorCountry(c);
    const agentName = foreignAgentName(c, profile);
    const code = item.regulatoryReportingCode ?? null;
    built.push({
      endToEndId: item.endToEndId,
      warnings,
      snapshot: {
        method: c.method,
        account: creditorAccount(c, profile),
        clearing: c.method === "foreign_account" ? c.clearingMemberId ?? null : null,
        bic: c.method === "iban" && kind === "sepa" ? null : c.bic,
        name: name.value,
        postalCode: postalCode || null,
        city: town || null,
        referenceKind: item.reference.kind,
        reference: referenceValue,
        kind,
        currency,
        street: street.value || null,
        country,
        clearingSystem: c.method === "foreign_account" ? c.clearingSystem ?? null : null,
        bankName: agentName || null,
        chargeBearer,
        regulatoryReporting: code ? { code, amountSek: null, rate: null, rateDate: null } : null,
      },
    });
    return el("CdtTrfTxInf", [
      el("PmtId", [el("InstrId", item.endToEndId), el("EndToEndId", item.endToEndId)]),
      el("Amt", [el("InstdAmt", amountText(item.amount, currency), { Ccy: currency })]),
      foreignCreditorAgent(c, kind, profile),
      el("Cdtr", [
        el("Nm", name.value),
        el("PstlAdr", [
          street.value ? el("StrtNm", street.value) : null,
          postalCode ? el("PstCd", postalCode) : null,
          town ? el("TwnNm", town) : null,
          el("Ctry", country),
        ]),
      ]),
      foreignCreditorAccountElement(c, profile),
      code ? regulatoryReportingElement(code, item.reference.kind === "message" ? sanitizeText(referenceValue, charset, 35).value : "", profile) : null,
      remittanceElement(item, referenceValue, profile, currency),
    ]);
  };

  const paymentInfos = paymentGroups(input.items).map((group) => {
    const { items, kind } = group;
    const foreign = kind !== "domestic";
    const domesticLevel = profile.domesticServiceLevel;
    const serviceLevel =
      kind === "sepa"
        ? el("Cd", profile.foreign.sepaServiceLevel)
        : kind === "international"
          ? el("Cd", "NURG")
          : "proprietary" in domesticLevel
            ? el("Prtry", domesticLevel.proprietary)
            : el("Cd", domesticLevel.code);
    const localInstrumentIn = kind === "sepa" ? profile.foreign.localInstrumentIn.sepa : kind === "international" && profile.foreign.localInstrumentIn.international;
    const debit = foreign ? input.debtor.foreignAccount ?? input.debtor.account : input.debtor.account;
    return el("PmtInf", [
      el("PmtInfId", paymentInfoId(input.messageId, group)),
      el("PmtMtd", "TRF"),
      el("NbOfTxs", String(items.length)),
      el("CtrlSum", amountText(items.reduce((sum, item) => sum + item.amount, 0))),
      el("PmtTpInf", [
        el("SvcLvl", [serviceLevel]),
        localInstrumentIn ? el("LclInstrm", [el("Cd", "IN")]) : null,
        kind === "sepa" && !profile.foreign.sepaCategoryPurpose ? null : el("CtgyPurp", [el("Cd", "SUPP")]),
      ]),
      el("ReqdExctnDt", group.date),
      el("Dbtr", [
        el("Nm", debtorName),
        postalAddress(input.debtor.postalCode, input.debtor.city, profile),
        profile.debtorIdentification && input.debtor.agreementId ? orgOther(input.debtor.agreementId, profile.debtorIdentification.scheme) : null,
      ]),
      debtorAccount(debit, foreign ? profile.foreign.debtorAccountCurrency : true),
      el("DbtrAgt", [el("FinInstnId", [el("BIC", profile.debtorAgentBic)])]),
      foreign && group.chargeBearer ? el("ChrgBr", group.chargeBearer) : null,
      ...items.map((item) => (foreign ? foreignTransaction(item, kind, group.chargeBearer as "SLEV" | ChargeBearer) : domesticTransaction(item))),
    ]);
  });

  const root = el(
    "Document",
    [
      el("CstmrCdtTrfInitn", [
        el("GrpHdr", [
          el("MsgId", input.messageId),
          el("CreDtTm", stockholmDateTime(input.createdAt)),
          el("NbOfTxs", String(input.items.length)),
          el("CtrlSum", amountText(total)),
          el("InitgPty", [initiatingId ? orgOther(initiatingId, profile.initiatingParty.scheme) : null]),
        ]),
        ...paymentInfos,
      ]),
    ],
    { xmlns: "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03", "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" }
  );
  // built[] was filled in group order; return it in the input's order.
  const order = new Map(input.items.map((item, index) => [item.endToEndId, index]));
  built.sort((a, b) => order.get(a.endToEndId)! - order.get(b.endToEndId)!);
  return { xml: renderXml(root), items: built };
}

// Nordea's EU/EEA charge rule needs to know whether the receiving bank is in
// the EEA — exported for the check.
export function receivingBankInEea(creditor: Pain001Creditor): boolean {
  return isEeaCountry(creditorBankCountry(creditor));
}

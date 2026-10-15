import type { DebitAccountKind, SupplierPaymentMethod } from "@navet/shared";
import type { CreditorSnapshot } from "@navet/db";
import { stockholmDateTime } from "../banking-dates.js";
import type { BankProfile } from "./bank-profiles.js";
import { sanitizeText } from "./sanitize.js";
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
}
export interface Pain001Item {
  endToEndId: string;
  amount: number;
  executionDate: string;
  creditor: Pain001Creditor;
  // generated = Nav's own default message, truncated silently to fit.
  reference: { kind: "ocr" | "message"; value: string; generated?: boolean };
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

const amountText = (amount: number) => amount.toFixed(2);
const digits = (value: string | null) => (value ?? "").replace(/\D/g, "");

export function defaultPaymentMessage(invoiceNumber: string, messageMax: number): string {
  const text = messageMax >= 20 ? `Faktura ${invoiceNumber}` : invoiceNumber;
  return text.slice(0, messageMax);
}

export function initiatingPartyIdFor(input: Pain001Input, profile: BankProfile): string | null {
  if (input.debtor.initiatingPartyId) return input.debtor.initiatingPartyId;
  return profile.initiatingParty.fallback === "orgNumber" ? digits(input.debtor.orgNumber) || null : null;
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
    case "bank_account": {
      const clearing = creditor.clearing ?? "";
      const account = creditor.account ?? "";
      if (!profile.bban.includeClearing) return account;
      // Swedbank: "8CCCCznnnnnnnnn (always 15 digits)", zero fill between.
      if (profile.bban.padSwedbank8To15 && clearing.startsWith("8")) return clearing + account.padStart(15 - clearing.length, "0");
      return clearing + account;
    }
  }
}

// The town as written in TwnNm (Max35Text) — "" when nothing survives the
// bank's character set; the structural check treats that as a missing town.
export function townName(city: string | null, profile: BankProfile): string {
  return city ? sanitizeText(city, profile, 35).value : "";
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

function debtorAccount(account: { kind: DebitAccountKind; value: string }): XmlElement {
  const id =
    account.kind === "iban"
      ? el("Id", [el("IBAN", account.value)])
      : el("Id", [el("Othr", [el("Id", account.value), el("SchmeNm", [account.kind === "bankgiro" ? el("Prtry", "BGNR") : el("Cd", "BBAN")])])]);
  return el("DbtrAcct", [id, el("Ccy", "SEK")]);
}

function creditorAgent(creditor: Pain001Creditor, profile: BankProfile): XmlChild {
  const agent = profile.creditor[creditor.method].agent;
  const clearing = (memberId: string) =>
    el("CdtrAgt", [el("FinInstnId", [el("ClrSysMmbId", [el("ClrSysId", [el("Cd", "SESBA")]), el("MmbId", memberId)])])]);
  switch (agent.kind) {
    case "clearing":
      return clearing(agent.memberId);
    case "clearing_from_account":
      return clearing(creditor.clearing ?? "");
    case "bic":
      return el("CdtrAgt", [el("FinInstnId", [el("BIC", agent.bic)])]);
    case "bic_from_supplier":
      return creditor.bic ? el("CdtrAgt", [el("FinInstnId", [el("BIC", creditor.bic)])]) : null;
    case "none":
      return null;
  }
}

function creditorAccountElement(creditor: Pain001Creditor, profile: BankProfile): XmlElement {
  const scheme = profile.creditor[creditor.method].scheme;
  const value = creditorAccount(creditor, profile);
  if (scheme === "IBAN") return el("CdtrAcct", [el("Id", [el("IBAN", value)])]);
  return el("CdtrAcct", [
    el("Id", [el("Othr", [el("Id", value), el("SchmeNm", [scheme === "BGNR" ? el("Prtry", "BGNR") : el("Cd", "BBAN")])])]),
  ]);
}

export function buildPain001(input: Pain001Input, profile: BankProfile): { xml: string; items: BuiltPain001Item[] } {
  const built: BuiltPain001Item[] = [];
  const total = input.items.reduce((sum, item) => sum + item.amount, 0);
  const initiatingId = initiatingPartyIdFor(input, profile);

  const byDate = new Map<string, Pain001Item[]>();
  for (const item of input.items) byDate.set(item.executionDate, [...(byDate.get(item.executionDate) ?? []), item]);
  const dates = [...byDate.keys()].sort();

  const debtorName = sanitizeText(input.debtor.name, profile, 70).value;
  const transactions = (items: Pain001Item[]) =>
    items.map((item) => {
      const rule = profile.creditor[item.creditor.method];
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
      const remittance =
        item.reference.kind === "ocr"
          ? el("RmtInf", [
              el("Strd", [
                profile.remittance.scorWithRemittedAmount
                  ? el("RfrdDocAmt", [el("RmtdAmt", amountText(item.amount), { Ccy: "SEK" })])
                  : null,
                el("CdtrRefInf", [el("Tp", [el("CdOrPrtry", [el("Cd", "SCOR")])]), el("Ref", referenceValue)]),
              ]),
            ])
          : el("RmtInf", [el("Ustrd", referenceValue)]);
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
        },
      });
      return el("CdtTrfTxInf", [
        el("PmtId", [el("InstrId", item.endToEndId), el("EndToEndId", item.endToEndId)]),
        el("Amt", [el("InstdAmt", amountText(item.amount), { Ccy: "SEK" })]),
        creditorAgent(item.creditor, profile),
        el("Cdtr", [el("Nm", name.value), postalAddress(item.creditor.postalCode, item.creditor.city, profile)]),
        creditorAccountElement(item.creditor, profile),
        remittance,
      ]);
    });

  const paymentInfos = dates.map((date) => {
    const items = byDate.get(date)!;
    return el("PmtInf", [
      el("PmtInfId", `${input.messageId}-${date.replace(/-/g, "")}`),
      el("PmtMtd", "TRF"),
      el("NbOfTxs", String(items.length)),
      el("CtrlSum", amountText(items.reduce((sum, item) => sum + item.amount, 0))),
      el("PmtTpInf", [el("SvcLvl", [el("Cd", "NURG")]), el("CtgyPurp", [el("Cd", "SUPP")])]),
      el("ReqdExctnDt", date),
      el("Dbtr", [
        el("Nm", debtorName),
        postalAddress(input.debtor.postalCode, input.debtor.city, profile),
        profile.debtorIdentification && input.debtor.agreementId ? orgOther(input.debtor.agreementId, profile.debtorIdentification.scheme) : null,
      ]),
      debtorAccount(input.debtor.account),
      el("DbtrAgt", [el("FinInstnId", [el("BIC", profile.debtorAgentBic)])]),
      ...transactions(items),
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
  // built[] was filled in date order; return it in the input's order.
  const order = new Map(input.items.map((item, index) => [item.endToEndId, index]));
  built.sort((a, b) => order.get(a.endToEndId)! - order.get(b.endToEndId)!);
  return { xml: renderXml(root), items: built };
}

import { BIC_PATTERN, isLuhnValid, isValidIban, isValidOcrReference } from "@navet/shared";
import { addDays } from "../banking-dates.js";
import type { BankProfile } from "./bank-profiles.js";
import { creditorAccount, initiatingPartyIdFor, townName, type Pain001Input } from "./pain001-builder.js";
import { sanitizeText } from "./sanitize.js";

export interface Pain001Violation {
  endToEndId: string | null;
  field: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// PmtInfId is `${messageId}-YYYYMMDD` and Max35Text, so MsgId gets 26.
const MESSAGE_ID = /^[A-Z0-9-]{1,26}$/;
// xs:date rejects 2026-13-01 and 2026-02-30, so the pattern is not enough.
const isCalendarDate = (date: string) => ISO_DATE.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && addDays(date, 0) === date;
// PstCd is written as the code's digits (Max16Text).
const postalCodeTooLong = (code: string | null) => (code ?? "").replace(/\D/g, "").length > 16;
// Clearing: 4 digits, except Swedbank's 8-series which carries a fifth
// (check) digit — "8CCCC" (Nordea Account structures; Swedbank MIG).
const CLEARING = /^(?:8\d{4}|[0-79]\d{3})$/;
const DEBIT_LABEL = { iban: "IBAN", bankgiro: "bankgiro", plusgiro: "plusgiro" } as const;

// The facets of pain.001.001.03 for every element the builder writes, plus
// the profile's own limits and the cross rules (spec §3.4). The builder's
// element order is fixed in code, so data is all that can be wrong — this
// list is what the bank would reject. Order: header first, then items in
// input order, each item's checks in a fixed order (the test pins it).
export function checkPain001(input: Pain001Input, profile: BankProfile, today: string): Pain001Violation[] {
  const violations: Pain001Violation[] = [];
  const header = (field: string, message: string) => violations.push({ endToEndId: null, field, message });

  if (!MESSAGE_ID.test(input.messageId)) header("messageId", "Omgångens nummer kan inte användas som MsgId");
  if (input.items.length === 0) header("items", "Omgången har inga poster");
  const initiatingId = initiatingPartyIdFor(input, profile);
  if (initiatingId === null) {
    if (profile.initiatingParty.required || profile.initiatingParty.fallback) header("initiatingPartyId", `${profile.initiatingParty.label} saknas`);
  } else if (initiatingId.length > 35 || (profile.initiatingParty.pattern && !profile.initiatingParty.pattern.test(initiatingId))) {
    header("initiatingPartyId", `${profile.initiatingParty.label} har fel format`);
  }
  const debit = input.debtor.account;
  if (!profile.debitAccountKinds.includes(debit.kind)) {
    header("debtorAccount", `${profile.name} tar inte ${DEBIT_LABEL[debit.kind]} som debiteringskonto`);
  } else if (debit.kind === "iban" && isValidIban(debit.value) && !debit.value.startsWith("SE")) {
    header("debtorAccount", "Utlandskonto stöds inte som debiteringskonto — bara svenska IBAN (SE…)");
  } else if (
    (debit.kind === "iban" && !isValidIban(debit.value)) ||
    (debit.kind === "bankgiro" && !(/^\d{7,8}$/.test(debit.value) && isLuhnValid(debit.value))) ||
    (debit.kind === "plusgiro" && !(/^\d{2,8}$/.test(debit.value) && isLuhnValid(debit.value)))
  ) {
    header("debtorAccount", "Företagets debiteringskonto är ogiltigt");
  }
  if (sanitizeText(input.debtor.name, profile, 70).value === "") header("debtorName", "Företagets namn saknas");
  if (profile.address.creditorTownRequired && townName(input.debtor.city, profile) === "") header("debtorCity", "Företagets ort saknas");
  if (input.debtor.agreementId && input.debtor.agreementId.length > 35) header("agreementId", "Avtals-ID:t är för långt");
  if (profile.address.fields.includes("PstCd") && postalCodeTooLong(input.debtor.postalCode)) header("debtorPostalCode", "Företagets postnummer är för långt");

  const seen = new Set<string>();
  for (const item of input.items) {
    const add = (field: string, message: string) => violations.push({ endToEndId: item.endToEndId, field, message });
    const rule = profile.creditor[item.creditor.method];
    const c = item.creditor;

    if (!/^[A-Z0-9-]{1,35}$/.test(item.endToEndId) || seen.has(item.endToEndId)) add("endToEndId", "EndToEndId saknas, är för långt eller förekommer två gånger");
    seen.add(item.endToEndId);
    if (!(item.amount > 0) || item.amount > 999_999_999_999.99 || Math.round(item.amount * 100) / 100 !== item.amount) {
      add("amount", "Beloppet måste vara större än 0 och ha högst två decimaler");
    }
    if (!isCalendarDate(item.executionDate) || item.executionDate < today || item.executionDate > addDays(today, 365)) {
      add("executionDate", "Betalningsdagen måste ligga mellan idag och ett år framåt");
    }
    if (c.method === "bankgiro" && !(/^\d{7,8}$/.test(c.bankgiro ?? "") && isLuhnValid(c.bankgiro ?? ""))) add("creditorAccount", "Mottagarens bankgiro är ogiltigt");
    if (c.method === "plusgiro" && !(/^\d{2,8}$/.test(c.plusgiro ?? "") && isLuhnValid(c.plusgiro ?? ""))) add("creditorAccount", "Mottagarens plusgiro är ogiltigt");
    if (c.method === "bank_account") {
      const bban = creditorAccount(c, profile);
      // Swedbank: an 8-series BBAN is "always 15 digits" — an account too
      // long to pad to 15 cannot be sent.
      const swedbank8 = profile.bban.padSwedbank8To15 && (c.clearing ?? "").startsWith("8");
      if (!CLEARING.test(c.clearing ?? "") || !/^\d{1,15}$/.test(c.account ?? "") || bban.length > 34 || (swedbank8 && bban.length !== 15)) {
        add("creditorAccount", "Mottagarens clearing- eller kontonummer är ogiltigt");
      }
    }
    if (c.method === "iban") {
      if (!isValidIban(c.iban ?? "")) add("creditorAccount", "Mottagarens IBAN är ogiltigt");
      else if (!(c.iban ?? "").startsWith("SE")) add("creditorAccount", "Utlandsbetalningar stöds inte — bara svenska IBAN (SE…)");
      if (c.bic && !BIC_PATTERN.test(c.bic)) add("creditorAccount", "Mottagarens BIC är ogiltigt");
    }
    if (sanitizeText(c.name, profile, rule.nameMax).value === "") add("creditorName", "Mottagarens namn saknas");
    if (item.reference.kind === "ocr") {
      if (!isValidOcrReference(item.reference.value) || item.reference.value.length > rule.ocrMax) add("reference", "OCR-numret är ogiltigt");
      if (c.method === "bank_account" || c.method === "iban") add("reference", "OCR kan bara skickas till bankgiro eller plusgiro");
    } else {
      // Nav's own default message (generated) is cut to fit by the builder;
      // a typed one is never cut silently. Either must leave text behind —
      // an empty Ustrd breaks Max140Text.
      const message = sanitizeText(item.reference.value, profile, Number.MAX_SAFE_INTEGER).value;
      if (message === "") add("reference", "Meddelande till mottagaren saknas");
      else if (!item.reference.generated && message.length > rule.messageMax) {
        add("reference", `Meddelandet får vara högst ${rule.messageMax} tecken för det här betalsättet`);
      }
    }
    if (profile.address.creditorTownRequired && townName(c.city, profile) === "") add("creditorCity", "Mottagarens ort saknas (krävs av banken)");
    if (profile.address.fields.includes("PstCd") && postalCodeTooLong(c.postalCode)) add("creditorPostalCode", "Mottagarens postnummer är för långt");
  }
  return violations;
}

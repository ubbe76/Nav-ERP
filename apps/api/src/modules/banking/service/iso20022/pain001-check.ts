import { BIC_PATTERN, CLEARING_SYSTEMS, PAYMENT_REPORTING_CODE_PATTERN, isClearingSystem, isLuhnValid, isSepaCountry, isValidIban, isValidOcrReference } from "@navet/shared";
import { addDays } from "../banking-dates.js";
import type { BankProfile } from "./bank-profiles.js";
import {
  chargeBearerFor,
  creditorAccount,
  creditorCountry,
  foreignAgentName,
  foreignPostalCode,
  initiatingPartyIdFor,
  itemKind,
  itemRule,
  receivingBankInEea,
  streetName,
  townName,
  type Pain001Input,
} from "./pain001-builder.js";
import { sanitizeText, type CharsetHolder } from "./sanitize.js";

export interface Pain001Violation {
  endToEndId: string | null;
  field: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// PmtInfId is `${messageId}-YYYYMMDD` and Max35Text, so MsgId gets 26 — 25
// when a payment abroad adds its one-letter group suffix (S/I/D).
const MESSAGE_ID = /^[A-Z0-9-]{1,26}$/;
const MESSAGE_ID_FOREIGN = /^[A-Z0-9-]{1,25}$/;
// xs:date rejects 2026-13-01 and 2026-02-30, so the pattern is not enough.
const isCalendarDate = (date: string) => ISO_DATE.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && addDays(date, 0) === date;
// PstCd is written as the code's digits (Max16Text).
const postalCodeTooLong = (code: string | null) => (code ?? "").replace(/\D/g, "").length > 16;
// Clearing: 4 digits, except Swedbank's 8-series which carries a fifth
// (check) digit — "8CCCC" (Nordea Account structures; Swedbank MIG).
const CLEARING = /^(?:8\d{4}|[0-79]\d{3})$/;
const CURRENCY = /^[A-Z]{3}$/;
// CountryCode in pain.001.001.03: [A-Z]{2,2}.
const COUNTRY = /^[A-Z]{2}$/;
const DEBIT_LABEL = { iban: "IBAN", bankgiro: "bankgiro", plusgiro: "plusgiro" } as const;

function debitAccountProblem(debit: { kind: keyof typeof DEBIT_LABEL; value: string }): "foreign" | "invalid" | null {
  if (debit.kind === "iban" && isValidIban(debit.value) && !debit.value.startsWith("SE")) return "foreign";
  if (
    (debit.kind === "iban" && !isValidIban(debit.value)) ||
    (debit.kind === "bankgiro" && !(/^\d{7,8}$/.test(debit.value) && isLuhnValid(debit.value))) ||
    (debit.kind === "plusgiro" && !(/^\d{2,8}$/.test(debit.value) && isLuhnValid(debit.value)))
  ) {
    return "invalid";
  }
  return null;
}

// The facets of pain.001.001.03 for every element the builder writes, plus
// the profile's own limits and the cross rules (spec §3.4). The builder's
// element order is fixed in code, so data is all that can be wrong — this
// list is what the bank would reject. Order: header first, then items in
// input order, each item's checks in a fixed order (the test pins it).
export function checkPain001(input: Pain001Input, profile: BankProfile, today: string): Pain001Violation[] {
  const violations: Pain001Violation[] = [];
  const header = (field: string, message: string) => violations.push({ endToEndId: null, field, message });
  const anyForeign = input.items.some((item) => itemKind(item) !== "domestic");

  if (!(anyForeign ? MESSAGE_ID_FOREIGN : MESSAGE_ID).test(input.messageId)) header("messageId", "Omgångens nummer kan inte användas som MsgId");
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
  } else if (debitAccountProblem(debit) === "foreign") {
    header("debtorAccount", "Utlandskonto stöds inte som debiteringskonto — bara svenska IBAN (SE…)");
  } else if (debitAccountProblem(debit) === "invalid") {
    header("debtorAccount", "Företagets debiteringskonto är ogiltigt");
  }
  // A payment abroad is drawn from the profile's foreign debit account
  // (Swedbank: IBAN, never the bankgiro).
  if (anyForeign) {
    const foreign = input.debtor.foreignAccount ?? null;
    const kinds = profile.foreign.debitAccountKinds.map((kind) => DEBIT_LABEL[kind]).join(" eller ");
    if (!foreign || !profile.foreign.debitAccountKinds.includes(foreign.kind)) {
      header("debtorForeignAccount", `${profile.name} kräver ${kinds} som debiteringskonto för utlandsbetalningar — lägg in det i Företagsinformation`);
    } else if (debitAccountProblem(foreign) === "foreign") {
      header("debtorForeignAccount", "Utlandskonto stöds inte som debiteringskonto — bara svenska IBAN (SE…)");
    } else if (debitAccountProblem(foreign) === "invalid") {
      header("debtorForeignAccount", "Företagets debiteringskonto för utlandsbetalningar är ogiltigt");
    }
  }
  if (sanitizeText(input.debtor.name, profile, 70).value === "") header("debtorName", "Företagets namn saknas");
  if (profile.address.creditorTownRequired && townName(input.debtor.city, profile) === "") header("debtorCity", "Företagets ort saknas");
  if (input.debtor.agreementId && input.debtor.agreementId.length > 35) header("agreementId", "Avtals-ID:t är för långt");
  if (profile.address.fields.includes("PstCd") && postalCodeTooLong(input.debtor.postalCode)) header("debtorPostalCode", "Företagets postnummer är för långt");

  const seen = new Set<string>();
  for (const item of input.items) {
    const add = (field: string, message: string) => violations.push({ endToEndId: item.endToEndId, field, message });
    const kind = itemKind(item);
    const rule = itemRule(item, profile, kind);
    const c = item.creditor;
    const currency = (item.currency ?? "SEK").toUpperCase();

    if (!/^[A-Z0-9-]{1,35}$/.test(item.endToEndId) || seen.has(item.endToEndId)) add("endToEndId", "EndToEndId saknas, är för långt eller förekommer två gånger");
    seen.add(item.endToEndId);
    if (!(item.amount > 0) || item.amount > 999_999_999_999.99 || Math.round(item.amount * 100) / 100 !== item.amount) {
      add("amount", "Beloppet måste vara större än 0 och ha högst två decimaler");
    }
    if (!CURRENCY.test(currency)) add("currency", "Valutan måste vara en ISO-kod med tre bokstäver");
    if (!isCalendarDate(item.executionDate) || item.executionDate < today || item.executionDate > addDays(today, profile.executionDateMaxDays)) {
      add(
        "executionDate",
        profile.executionDateMaxDays >= 365
          ? "Betalningsdagen måste ligga mellan idag och ett år framåt"
          : `Betalningsdagen måste ligga mellan idag och ${profile.executionDateMaxDays} dagar framåt (${profile.name})`
      );
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
    // Bankgiro, plusgiro and Swedish bank accounts are SEK-only routes.
    if ((c.method === "bankgiro" || c.method === "plusgiro" || c.method === "bank_account") && currency !== "SEK") {
      add("currency", "Bankgiro, plusgiro och svenska bankkonton tar bara emot SEK — leverantören behöver IBAN för en betalning i annan valuta");
    }
    if (c.method === "iban") {
      if (!isValidIban(c.iban ?? "")) add("creditorAccount", "Mottagarens IBAN är ogiltigt");
      else if (!isSepaCountry((c.iban ?? "").slice(0, 2)) && !c.bic) add("creditorAgent", "BIC krävs för IBAN utanför SEPA-området");
      if (c.bic && !BIC_PATTERN.test(c.bic)) add("creditorAccount", "Mottagarens BIC är ogiltigt");
    }
    if (c.method === "foreign_account") {
      if (!/^[A-Z0-9]{1,34}$/.test(c.foreignAccount ?? "")) add("creditorAccount", "Mottagarens kontonummer är ogiltigt");
      if (c.bic && !BIC_PATTERN.test(c.bic)) add("creditorAgent", "Mottagarens BIC är ogiltigt");
      const system = c.clearingSystem ?? null;
      if (system !== null) {
        if (!isClearingSystem(system) || !(profile.foreign.clearingSystems as readonly string[]).includes(system)) {
          add("creditorAgent", `${profile.name} tar inte bank-id av typen ${system} — ange mottagarbankens BIC`);
        } else if (!CLEARING_SYSTEMS[system].pattern.test(c.clearingMemberId ?? "")) {
          add("creditorAgent", `Mottagarbankens ${system}-nummer har fel format`);
        }
      }
      if (!c.bic && system === null) add("creditorAgent", "Mottagarbanken saknar BIC och bank-id");
      if (!c.bic && system !== null && profile.foreign.creditorAgentNameWithClearing && foreignAgentName(c, profile) === "") {
        add("creditorAgent", `${profile.name} kräver mottagarbankens namn när banken bara anges med bank-id`);
      }
      if (creditorCountry(c) === "SE") add("creditorCountry", "Ett utländskt kontonummer kräver att mottagarens land inte är Sverige");
    }
    const name = sanitizeText(c.name, rule.charset, rule.nameMax).value;
    if (name === "") add("creditorName", "Mottagarens namn saknas");
    if (item.reference.kind === "ocr") {
      if (!isValidOcrReference(item.reference.value) || item.reference.value.length > rule.ocrMax) add("reference", "OCR-numret är ogiltigt");
      if (c.method === "bank_account" || c.method === "iban" || c.method === "foreign_account") add("reference", "OCR kan bara skickas till bankgiro eller plusgiro");
    } else {
      // Nav's own default message (generated) is cut to fit by the builder;
      // a typed one is never cut silently. Either must leave text behind —
      // an empty Ustrd breaks Max140Text.
      const message = sanitizeText(item.reference.value, rule.charset, Number.MAX_SAFE_INTEGER).value;
      if (message === "") add("reference", "Meddelande till mottagaren saknas");
      else if (!item.reference.generated && message.length > rule.messageMax) {
        add("reference", `Meddelandet får vara högst ${rule.messageMax} tecken för det här betalsättet`);
      }
    }
    if (kind === "domestic") {
      if (profile.address.creditorTownRequired && townName(c.city, profile) === "") add("creditorCity", "Mottagarens ort saknas (krävs av banken)");
      if (profile.address.fields.includes("PstCd") && postalCodeTooLong(c.postalCode)) add("creditorPostalCode", "Mottagarens postnummer är för långt");
      continue;
    }

    // A payment abroad (SEPA or international).
    const charset: CharsetHolder = { charset: profile.foreign.charset };
    const country = creditorCountry(c);
    const street = streetName(c.street, charset).value;
    const town = townName(c.city, charset);
    if (!COUNTRY.test(country)) add("creditorCountry", "Mottagarens land måste vara en landskod med två bokstäver");
    if (street === "") add("creditorStreet", "Mottagarens gatuadress saknas (krävs för utlandsbetalningar)");
    if (profile.foreign.townRequired && town === "") add("creditorCity", "Mottagarens ort saknas (krävs av banken)");
    if (foreignPostalCode(c.postalCode, charset).length === 0 && (c.postalCode ?? "").trim() !== "") add("creditorPostalCode", "Mottagarens postnummer kan inte skickas");
    if (profile.foreign.nameStreetTownMax !== null && name.length + street.length + town.length > profile.foreign.nameStreetTownMax) {
      add(
        "creditorAddress",
        `${profile.name} tar högst ${profile.foreign.nameStreetTownMax} tecken för mottagarens namn, gatuadress och ort tillsammans (nu ${name.length + street.length + town.length})`
      );
    }
    if (kind === "international" && profile.foreign.internationalBicRequired && !c.bic && !violations.some((v) => v.endToEndId === item.endToEndId && v.field === "creditorAgent")) {
      add("creditorAgent", `${profile.name} kräver mottagarbankens BIC för utlandsbetalningar`);
    }
    const chargeBearer = chargeBearerFor(item, kind);
    if (kind === "international" && chargeBearer !== null && chargeBearer !== "SLEV") {
      const allowed = receivingBankInEea(c) ? profile.foreign.chargeBearerCodes.internationalWithinEea : profile.foreign.chargeBearerCodes.international;
      if (!allowed.includes(chargeBearer)) {
        add("chargeBearer", `${profile.name} tar inte avgiftsfördelningen ${chargeBearer} till en bank inom EU/EES — välj delade avgifter (SHAR)`);
      }
    }
    const code = item.regulatoryReportingCode ?? null;
    if (code !== null && !PAYMENT_REPORTING_CODE_PATTERN.test(code)) add("regulatoryReporting", "Betalningskoden till Skatteverket ska vara tre siffror");
  }
  return violations;
}

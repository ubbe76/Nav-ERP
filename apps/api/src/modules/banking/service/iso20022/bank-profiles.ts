import type { BankProfileId, ChargeBearer, ClearingSystem, DebitAccountKind, SupplierPaymentMethod } from "@navet/shared";

// The four banks' ISO 20022 variants as DATA (spec §2). One generic builder
// and one generic parser read this table; a bank-specific gap is a table
// entry, never new code. Sources per value: the spec's "Källor".
export type AgentRule =
  | { kind: "clearing"; memberId: string } // SESBA + fixed MmbId (9900/9960/9500)
  | { kind: "clearing_from_account"; memberIdDigits?: 4 } // SESBA + the supplier's clearing number (SEB: its first 4 digits)
  | { kind: "bic"; bic: string } // fixed BIC (BGABSESS/NDEASESS)
  | { kind: "bic_from_supplier" } // the supplier's BIC when present, else no agent
  | { kind: "none" };
export type AccountScheme = "BGNR" | "BBAN" | "IBAN";
export type DomesticMethod = Exclude<SupplierPaymentMethod, "foreign_account">;

export interface CreditorRule {
  agent: AgentRule;
  scheme: AccountScheme;
  messageMax: number;
  ocrMax: number;
  nameMax: number;
}

// Payments abroad (valuta steg 2, spec §4) — the bank's rules as data. The
// builder writes SEPA and international payments from these and nothing
// else; a bank that differs is a table edit. Sources: the research note
// private/superpowers/specs/research-utlandsbetalningar-2026-10-24.md (the
// banks' MIGs, quoted per value below).
export type RegulatoryReportingForm =
  // <RgltryRptg><Dtls><Cd>101</Cd></Dtls></RgltryRptg>
  | "code"
  // <RgltryRptg><Dtls><Ctry>SE</Ctry><Cd>101</Cd><Inf>…</Inf></Dtls></RgltryRptg>
  | "country_code_info"
  // <RgltryRptg><DbtCdtRptgInd>DEBT</DbtCdtRptgInd><Dtls><Cd>101</Cd></Dtls></RgltryRptg>
  | "indicator_code";

export interface ForeignRules {
  // SvcLvl/Cd on a SEPA PmtInf. Swedbank and SEB act on "SEPA"; Handelsbanken
  // and Nordea classify the payment themselves and take NURG.
  sepaServiceLevel: "SEPA" | "NURG";
  // LclInstrm/Cd "IN" (cross border) on the PmtInf, per kind.
  localInstrumentIn: { sepa: boolean; international: boolean };
  // ChrgBr: SEPA always SLEV; an international payment carries the
  // supplier's SHAR/DEBT when the bank takes it — `internationalWithinEea`
  // narrows it for a receiving bank inside the EU/EEA (Nordea).
  chargeBearerCodes: { international: readonly ChargeBearer[]; internationalWithinEea: readonly ChargeBearer[] };
  regulatoryReporting: RegulatoryReportingForm;
  // The debit account kinds a payment abroad may be drawn from.
  debitAccountKinds: readonly DebitAccountKind[];
  // DbtrAcct/Ccy on the foreign PmtInf.
  debtorAccountCurrency: boolean;
  // A creditor agent identified by a national bank id only also carries
  // FinInstnId/Nm and PstlAdr/Ctry.
  creditorAgentNameWithClearing: boolean;
  // TwnNm required for the payee.
  townRequired: boolean;
  // CtgyPurp SUPP on a SEPA PmtInf (SEB: "NU" — not used for SEPA).
  sepaCategoryPurpose: boolean;
  // An international payment (not SEPA) must name the receiving bank by BIC
  // (SEB: "Creditor Agent BIC is required by SEB").
  internationalBicRequired: boolean;
  // Name + street + town in characters at most (SWIFT field 59, 4×35), null
  // = no combined limit.
  nameStreetTownMax: number | null;
  // The national bank ids the bank takes for an account without IBAN.
  clearingSystems: readonly ClearingSystem[];
  nameMax: number;
  messageMax: number;
  charset: { allowed: RegExp; substitutions: Readonly<Record<string, string>> };
}

export interface BankProfile {
  id: BankProfileId;
  name: string;
  verified: boolean;
  painVersion: "pain.001.001.03";
  camtVersions: readonly string[];
  debtorAgentBic: string;
  initiatingParty: { scheme: "BANK" | "CUST"; required: boolean; fallback: "orgNumber" | null; pattern: RegExp | null; label: string };
  debtorIdentification: { scheme: "BANK"; label: string } | null;
  debitAccountKinds: readonly DebitAccountKind[];
  // Domestic payments per method (an IBAN abroad and a foreign account
  // follow `foreign`).
  creditor: Record<DomesticMethod, CreditorRule>;
  // withoutClearing: clearing ranges [from, to] whose BBAN is the account
  // number alone even though the profile otherwise includes the clearing.
  bban: { includeClearing: boolean; padSwedbank8To15: boolean; withoutClearing?: readonly (readonly [string, string])[] };
  // SvcLvl on a domestic PmtInf: Cd NURG, or SEB's Prtry MPNS.
  domesticServiceLevel: { code: "NURG" } | { proprietary: "MPNS" };
  // ReqdExctnDt at most this many days ahead.
  executionDateMaxDays: number;
  address: { fields: readonly ("PstCd" | "TwnNm")[]; creditorTownRequired: boolean };
  remittance: { scorWithRemittedAmount: boolean };
  charset: { allowed: RegExp; substitutions: Readonly<Record<string, string>> };
  foreign: ForeignRules;
}

// Latin set + åäö (Swedbank MIG "Character set"; HB converts to EBCDIC and
// Nordea blanks what it can't carry, so the same set is safe for all).
const LATIN_SE = /^[A-Za-z0-9\/\-?:().,'+ åäöÅÄÖ]$/;
const COMMON_CHARSET = { allowed: LATIN_SE, substitutions: { "&": " och " } } as const;

// Payments abroad: the same Latin set WITHOUT åäö — Swedbank: "For Swedish
// domestic payments it is also allowed to use: åÅäÄöÖ" (so not abroad); SEB:
// "Nordic characters should not be used for non-domestic payments"; Nordea
// Payment Guide: replace Å/Ä/Ö/Æ/Ø/Ü/ß with the nearest English letter and
// write `&` as "and". The substitutions are explicit (æ, ø and ß have no
// base letter to fall back on).
const LATIN = /^[A-Za-z0-9\/\-?:().,'+ ]$/;
const FOREIGN_CHARSET = {
  allowed: LATIN,
  substitutions: {
    "&": " and ",
    å: "a",
    Å: "A",
    ä: "a",
    Ä: "A",
    æ: "a",
    Æ: "A",
    ö: "o",
    Ö: "O",
    ø: "o",
    Ø: "O",
    ü: "u",
    Ü: "U",
    ß: "ss",
  },
} as const;

// Every MIG: Cdtr/Nm max 70 abroad (Nordea 70 for SEPA), Ustrd one
// occurrence of 140 (Nordea: "Only one occurrence of 140 characters (4*35)").
const FOREIGN_LIMITS = { nameMax: 70, messageMax: 140 } as const;
const ALL_CLEARING: readonly ClearingSystem[] = ["USABA", "CACPA", "AUBSB", "GBDSC", "HKNCC", "INFSC", "NZNCC", "ZANCC", "CNAPS"];

// Account payments carry 12 characters until the new Swedish infrastructure
// raises it to 140 (HB: "31st May 2026 (estimated)") — one table edit.
const ACCOUNT_MESSAGE_MAX = 12;

function giroRule(agent: AgentRule, scheme: AccountScheme, nameMax = 70): CreditorRule {
  return { agent, scheme, messageMax: 140, ocrMax: 25, nameMax };
}
function accountRule(agent: AgentRule, scheme: AccountScheme): CreditorRule {
  return { agent, scheme, messageMax: ACCOUNT_MESSAGE_MAX, ocrMax: 25, nameMax: 70 };
}

export const BANK_PROFILES: Record<BankProfileId, BankProfile> = {
  swedbank: {
    id: "swedbank",
    name: "Swedbank",
    verified: true,
    painVersion: "pain.001.001.03",
    camtVersions: ["camt.054.001.02"],
    debtorAgentBic: "SWEDSESS",
    initiatingParty: { scheme: "BANK", required: true, fallback: null, pattern: /^\d{12}[A-Z]\d{3}$/, label: "Avtals-ID för betalfil (t.ex. 123456789123B001)" },
    debtorIdentification: null,
    // "For Domestic payments use Othr/BGNR" — debit from IBAN without a
    // bankgiro is undocumented, so bankgiro only (spec §14.8).
    debitAccountKinds: ["bankgiro"],
    creditor: {
      bankgiro: giroRule({ kind: "clearing", memberId: "9900" }, "BGNR", 35),
      plusgiro: giroRule({ kind: "clearing", memberId: "9960" }, "BBAN"),
      bank_account: accountRule({ kind: "clearing_from_account" }, "BBAN"),
      iban: accountRule({ kind: "bic_from_supplier" }, "IBAN"),
    },
    bban: { includeClearing: true, padSwedbank8To15: true },
    domesticServiceLevel: { code: "NURG" },
    // "Cannot be more than 365 days in future".
    executionDateMaxDays: 365,
    address: { fields: ["PstCd", "TwnNm"], creditorTownRequired: true },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
    foreign: {
      // MIG SvcLvl: "“SEPA” SEPA Credit Transfer [EUR]"; LclInstrm: "“IN”
      // for cross border payments" (Appendix: NURG for international).
      sepaServiceLevel: "SEPA",
      localInstrumentIn: { sepa: false, international: true },
      // "SEPA CT: Only "SLEV" is allowed. If missing, will be treated as
      // SHAR"; SHAR and DEBT are the camt MIG's Br values.
      chargeBearerCodes: { international: ["SHAR", "DEBT"], internationalWithinEea: ["SHAR", "DEBT"] },
      // "Sweden: Required for international payments above a counter value
      // of 150.000 SEK" — <Dtls><Cd>101</Cd></Dtls>, "Only one code".
      regulatoryReporting: "code",
      // "For Domestic payments use Othr/BGNR other type of payments use IBAN
      // or BBAN" — a payment abroad is never drawn from the bankgiro.
      debitAccountKinds: ["iban"],
      // DbtrAcct/Ccy: "Required according to CGI-MP rules. Accepted but ignored."
      debtorAccountCurrency: true,
      creditorAgentNameWithClearing: false,
      // TwnNm "required from November 2026"; Appendix: "town name and
      // country must always be provided".
      townRequired: true,
      // "A payment without a category purpose code will be treated as SUPP".
      sepaCategoryPurpose: true,
      internationalBicRequired: false,
      nameStreetTownMax: null,
      // CdtrAgt ClrSysId codes in the MIG: SESBA, USABA, CACPA.
      clearingSystems: ["USABA", "CACPA"],
      ...FOREIGN_LIMITS,
      charset: FOREIGN_CHARSET,
    },
  },
  handelsbanken: {
    id: "handelsbanken",
    name: "Handelsbanken",
    verified: true,
    painVersion: "pain.001.001.03",
    camtVersions: ["camt.054.001.02"],
    debtorAgentBic: "HANDSESS",
    initiatingParty: { scheme: "BANK", required: false, fallback: "orgNumber", pattern: null, label: "Organisationsnummer eller Handelsbankens kundnummer" },
    debtorIdentification: null,
    debitAccountKinds: ["iban"],
    creditor: {
      bankgiro: giroRule({ kind: "clearing", memberId: "9900" }, "BGNR"),
      plusgiro: giroRule({ kind: "clearing", memberId: "9500" }, "BBAN"),
      bank_account: accountRule({ kind: "clearing_from_account" }, "BBAN"),
      iban: accountRule({ kind: "bic_from_supplier" }, "IBAN"),
    },
    bban: { includeClearing: false, padSwedbank8To15: false },
    domesticServiceLevel: { code: "NURG" },
    // Implementation guide 2.2: up to 12 months ahead.
    executionDateMaxDays: 365,
    address: { fields: ["PstCd", "TwnNm"], creditorTownRequired: false },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
    foreign: {
      // Implementation guide 2.6: "Handelsbanken does not act on the code
      // SEPA in <SvcLvl> as the bank automatically classifies the payment"
      // — ServiceLevel "NURG (non-urgent) or SEPA".
      sepaServiceLevel: "NURG",
      // Country Specific 6.2: normal = TRF/NURG/SUPP; "If code IN is used,
      // all transfer in this PaymentInformation will be executed as
      // crossborder payments" — optional, left out.
      localInstrumentIn: { sepa: false, international: false },
      // SHAR, CRED, DEBT, SLEV; "Charge Bearer <ChrgBr> is mandatory for all
      // cross-border payments".
      chargeBearerCodes: { international: ["SHAR", "DEBT"], internationalWithinEea: ["SHAR", "DEBT"] },
      // Country Specific 6.2: <RgltryRptg><Dtls><Cd>101</Cd></Dtls></RgltryRptg>.
      regulatoryReporting: "code",
      debitAccountKinds: ["iban"],
      debtorAccountCurrency: true,
      creditorAgentNameWithClearing: false,
      // "The Creditor´s address <PstlAdrs> including Country Code, is
      // mandatory for all cross-border payments"; structured address.
      townRequired: true,
      sepaCategoryPurpose: true,
      // "It is optional to enter Creditor Agent when creditor account is
      // stated as an IBAN"; a national bank id is accepted.
      internationalBicRequired: false,
      nameStreetTownMax: null,
      // 8.4: AUBSB, CACPA, CNAPS, HKNCC, USABA, ZANCC (GBDSC "not allowed
      // for Cross border payments").
      clearingSystems: ["AUBSB", "CACPA", "CNAPS", "HKNCC", "USABA", "ZANCC"],
      ...FOREIGN_LIMITS,
      charset: FOREIGN_CHARSET,
    },
  },
  seb: {
    id: "seb",
    name: "SEB",
    // Verified 2026-10-24 against SEB's public MIG "SEB ISO 20022 MIG for the
    // messages pain.001.001.03 and pain.002.001.03" v26.4.0.0 (valid from
    // 2026-10-05), its PmtTypes sheet and sample files (Test Bench page,
    // sebgroup.com). Columns: 7.10.1 Giro, 7.10.3 Credit transfer via
    // Bankgirot, 6.1 SEPA, 6.2.1 International.
    verified: true,
    painVersion: "pain.001.001.03",
    camtVersions: ["camt.054.001.02"],
    // "recommended Debtor Agent identification … ESSESESS".
    debtorAgentBic: "ESSESESS",
    // InitgPty Id: "Identifies the customer in SEB's system" — given by SEB,
    // "either 14 or 10 letters long or it can be agreed to be any common
    // identifier"; BANK, file rejected without it.
    initiatingParty: { scheme: "BANK", required: true, fallback: null, pattern: null, label: "Kund-ID enligt avtalet med SEB (vanligen 14 eller 10 tecken)" },
    debtorIdentification: null,
    // Bankgiro "the recommended choice … BBAN or IBAN also accepted" (an
    // IBAN for domestic payments needs SEB's conversion service, set up at
    // implementation); "PlusGiro account is not available on Debtor Account".
    debitAccountKinds: ["iban", "bankgiro"],
    creditor: {
      // "Swedish clearing code must be populated for the Swedish Giro
      // payments" — 9900 + BGNR; plusgiro "always has Member Id 9960" + BBAN.
      bankgiro: giroRule({ kind: "clearing", memberId: "9900" }, "BGNR"),
      plusgiro: giroRule({ kind: "clearing", memberId: "9960" }, "BBAN"),
      // 7.10.3 MmbId: "It should only be 4 digits here and it is the
      // clearing number, 4 digits" (a Swedbank 8-series 83279 sends 8327).
      bank_account: accountRule({ kind: "clearing_from_account", memberIdDigits: 4 }, "BBAN"),
      iban: accountRule({ kind: "bic_from_supplier" }, "IBAN"),
    },
    // Annex 5 "How to enter Swedish bank account numbers": clearing +
    // account, except Handelsbanken ("only account number without clearing
    // number"), Danske Bank 9180–9189 ("only account number"), Nordea
    // personkonto ("personal number … (10 digits)" — clearing 3300/3782) and
    // Swedbank's 8-series ("add zeros between the clearing number and the
    // account number" to 15 digits).
    bban: {
      includeClearing: true,
      padSwedbank8To15: true,
      withoutClearing: [
        ["3300", "3300"],
        ["3782", "3782"],
        ["6000", "6999"],
        ["9180", "9189"],
      ],
    },
    // Every Swedish sample: <SvcLvl><Prtry>MPNS</Prtry></SvcLvl> (7.10.1
    // "MPNS - required", the alternative NURG "no impact"); MPNS routes a
    // payment with Creditor Agent BIC and IBAN to Bankgirot — without it an
    // IBAN payee with BIC may settle via SWIFT.
    domesticServiceLevel: { proprietary: "MPNS" },
    // ReqdExctnDt "must be in the limits of -60 - +180 calendar days".
    executionDateMaxDays: 180,
    // Creditor PstlAdr optional; "TwnNm and Ctry in their dedicated fields";
    // the debtor's address comes from SEB's register.
    address: { fields: ["TwnNm"], creditorTownRequired: false },
    // "RemittedAmount … is requested for structured invoices and SCOR".
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
    foreign: {
      // 6.1: "SEB requires SEPA code value usage in the initiations of the
      // SEPA payments"; LclInstrm "can be omitted"; CtgyPurp "NU".
      sepaServiceLevel: "SEPA",
      // 6.2.1: LclInstrm "IN - may be used in the international payment
      // initiation, but is not requierd" — the samples omit it.
      localInstrumentIn: { sepa: false, international: false },
      // SEPA SLEV; international SHAR/DEBT/CRED with "no default value".
      chargeBearerCodes: { international: ["SHAR", "DEBT"], internationalWithinEea: ["SHAR", "DEBT"] },
      // Samples 6.1/6.2.1: <RgltryRptg><DbtCdtRptgInd>DEBT</DbtCdtRptgInd>
      // <Dtls><Cd>101</Cd></Dtls></RgltryRptg>; Annex 2: "The amount limit
      // to instruct the tax authority reporting codes is SEK 150,000.00".
      regulatoryReporting: "indicator_code",
      // 6.1/6.2.1 DbtrAcct: "BBAN or IBAN accepted"; the bankgiro only "for
      // domestic low value payments in SEK".
      debitAccountKinds: ["iban"],
      debtorAccountCurrency: true,
      // BIC is mandatory abroad, so the bank name is never needed.
      creditorAgentNameWithClearing: false,
      // TwnNm optional: SEB fills "NOTPROVIDED" (the 2026 deadline for
      // structured addresses is postponed, §1.5).
      townRequired: false,
      sepaCategoryPurpose: false,
      // 6.2.1 CdtrAgt BIC: "Creditor Agent BIC is required by SEB".
      internationalBicRequired: true,
      nameStreetTownMax: null,
      clearingSystems: ALL_CLEARING,
      ...FOREIGN_LIMITS,
      charset: FOREIGN_CHARSET,
    },
  },
  nordea: {
    id: "nordea",
    name: "Nordea",
    verified: true,
    painVersion: "pain.001.001.03",
    camtVersions: ["camt.054.001.02"],
    debtorAgentBic: "NDEASESS",
    initiatingParty: { scheme: "CUST", required: true, fallback: null, pattern: /^\d{1,13}$/, label: "Signer-ID (högst 13 siffror)" },
    // Corporate Access MIG: CCM agreement mandatory (BANK); the eGateway
    // examples omit it — written only when set.
    debtorIdentification: { scheme: "BANK", label: "CCM-avtals-ID (frivilligt)" },
    debitAccountKinds: ["iban", "plusgiro"],
    creditor: {
      bankgiro: giroRule({ kind: "bic", bic: "BGABSESS" }, "BGNR"),
      plusgiro: giroRule({ kind: "bic", bic: "NDEASESS" }, "BBAN"),
      // SESBA is not among Nordea's CdtrAgt clearing codes; the BBAN with
      // clearing identifies the bank (unverified for other banks, spec §2.2).
      bank_account: accountRule({ kind: "none" }, "BBAN"),
      iban: accountRule({ kind: "bic_from_supplier" }, "IBAN"),
    },
    bban: { includeClearing: true, padSwedbank8To15: false },
    domesticServiceLevel: { code: "NURG" },
    executionDateMaxDays: 365,
    // "If address is used for Domestic payments, PostCode and TownName must be
    // present" — country only is the safe minimum.
    address: { fields: [], creditorTownRequired: false },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
    foreign: {
      // MIG SvcLvl: "SEPA will be treated by Nordea as NURG"; Payment types
      // (Sverige): "Standard utlandsbetalning inkl. … SEPA betalning" =
      // TRF/NURG/IN/SUPP — so NURG + IN for both kinds.
      sepaServiceLevel: "NURG",
      localInstrumentIn: { sepa: true, international: true },
      // "Within EU/EES area: Only SHAR or SLEV can be used … Outside EU/EES
      // area: DEBT, SHAR or SLEV"; CRED is never offered.
      chargeBearerCodes: { international: ["SHAR", "DEBT"], internationalWithinEea: ["SHAR"] },
      // MIG example: <Dtls><Ctry>SE</Ctry><Cd>101</Cd><Inf>…</Inf></Dtls>.
      regulatoryReporting: "country_code_info",
      // Appendix 2.3.4: "Bankgiro number is not to be used as a debtors account".
      debitAccountKinds: ["iban"],
      // "Currency of the debtor account must be present."
      debtorAccountCurrency: true,
      // Example 6.2: ClrSysMmbId USABA + <Nm>Citibank</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr>.
      creditorAgentNameWithClearing: true,
      // "For Cross-border payments and RfT Name, Town Name and Country must be stated."
      townRequired: true,
      sepaCategoryPurpose: true,
      // "BIC, or ClrSysId + Creditor Agent Name".
      internationalBicRequired: false,
      // Appendix 2.4: "If full length of “Creditor Name” used (i.e. 70
      // characters) then StreetName & TownName altogether cannot exceed 35
      // characters" — SWIFT field 59 is 4×35 and the country takes the last
      // line, so name + street + town stays within 3×35.
      nameStreetTownMax: 105,
      clearingSystems: ALL_CLEARING,
      ...FOREIGN_LIMITS,
      charset: FOREIGN_CHARSET,
    },
  },
};

export function bankProfile(id: BankProfileId): BankProfile {
  return BANK_PROFILES[id];
}

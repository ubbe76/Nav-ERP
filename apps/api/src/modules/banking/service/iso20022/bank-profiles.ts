import type { BankProfileId, DebitAccountKind, SupplierPaymentMethod } from "@navet/shared";

// The four banks' ISO 20022 variants as DATA (spec §2). One generic builder
// and one generic parser read this table; a bank-specific gap is a table
// entry, never new code. Sources per value: the spec's "Källor".
export type AgentRule =
  | { kind: "clearing"; memberId: string } // SESBA + fixed MmbId (9900/9960/9500)
  | { kind: "clearing_from_account" } // SESBA + the supplier's clearing number
  | { kind: "bic"; bic: string } // fixed BIC (BGABSESS/NDEASESS)
  | { kind: "bic_from_supplier" } // the supplier's BIC when present, else no agent
  | { kind: "none" };
export type AccountScheme = "BGNR" | "BBAN" | "IBAN";

export interface CreditorRule {
  agent: AgentRule;
  scheme: AccountScheme;
  messageMax: number;
  ocrMax: number;
  nameMax: number;
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
  creditor: Record<SupplierPaymentMethod, CreditorRule>;
  bban: { includeClearing: boolean; padSwedbank8To15: boolean };
  address: { fields: readonly ("PstCd" | "TwnNm")[]; creditorTownRequired: boolean };
  remittance: { scorWithRemittedAmount: boolean };
  charset: { allowed: RegExp; substitutions: Readonly<Record<string, string>> };
}

// Latin set + åäö (Swedbank MIG "Character set"; HB converts to EBCDIC and
// Nordea blanks what it can't carry, so the same set is safe for all).
const LATIN_SE = /^[A-Za-z0-9\/\-?:().,'+ åäöÅÄÖ]$/;
const COMMON_CHARSET = { allowed: LATIN_SE, substitutions: { "&": "och" } } as const;

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
    address: { fields: ["PstCd", "TwnNm"], creditorTownRequired: true },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
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
    address: { fields: ["PstCd", "TwnNm"], creditorTownRequired: false },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
  },
  seb: {
    id: "seb",
    name: "SEB",
    // SEB's MIG sits behind the SEB Test Bench login: this profile follows the
    // common Swedish interpretation and must be confirmed (spec §2.2).
    verified: false,
    painVersion: "pain.001.001.03",
    camtVersions: ["camt.054.001.02"],
    debtorAgentBic: "ESSESESS",
    initiatingParty: { scheme: "BANK", required: true, fallback: null, pattern: null, label: "Avtals-ID / kund-ID hos SEB" },
    debtorIdentification: null,
    debitAccountKinds: ["iban", "bankgiro"],
    creditor: {
      bankgiro: giroRule({ kind: "clearing", memberId: "9900" }, "BGNR"),
      plusgiro: giroRule({ kind: "clearing", memberId: "9960" }, "BBAN"),
      bank_account: accountRule({ kind: "clearing_from_account" }, "BBAN"),
      iban: accountRule({ kind: "bic_from_supplier" }, "IBAN"),
    },
    bban: { includeClearing: true, padSwedbank8To15: false },
    address: { fields: ["TwnNm"], creditorTownRequired: false },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
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
    // "If address is used for Domestic payments, PostCode and TownName must be
    // present" — country only is the safe minimum.
    address: { fields: [], creditorTownRequired: false },
    remittance: { scorWithRemittedAmount: true },
    charset: COMMON_CHARSET,
  },
};

export function bankProfile(id: BankProfileId): BankProfile {
  return BANK_PROFILES[id];
}

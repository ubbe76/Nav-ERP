// Bankfiler — labels and formatting for the web. Mirror of the parts of
// packages/shared/src/banking.ts the web needs (the web can't import
// @navet/shared). NO imports: banking.shared.test.ts loads this file.

export const SUPPLIER_PAYMENT_METHODS = ["bankgiro", "plusgiro", "bank_account", "iban", "foreign_account"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  bankgiro: "Bankgiro",
  plusgiro: "Plusgiro",
  bank_account: "Bankkonto",
  iban: "IBAN",
  foreign_account: "Utländskt kontonummer",
};

// Utlandsbetalningar (valuta steg 2). National bank identifiers for an account
// without IBAN (country, label and the format shown under the Bank-id field —
// the server checks the format).
export const CLEARING_SYSTEMS = {
  USABA: { country: "US", label: "USA – ABA routing number", format: "9 siffror" },
  CACPA: { country: "CA", label: "Kanada – CPA routing number", format: "9 siffror" },
  AUBSB: { country: "AU", label: "Australien – BSB", format: "6 siffror" },
  GBDSC: { country: "GB", label: "Storbritannien – sort code", format: "6 siffror" },
  HKNCC: { country: "HK", label: "Hongkong – bank code", format: "3–6 siffror" },
  INFSC: { country: "IN", label: "Indien – IFSC", format: "11 tecken, t.ex. ABCD0123456" },
  NZNCC: { country: "NZ", label: "Nya Zeeland – bank/branch", format: "6 siffror" },
  ZANCC: { country: "ZA", label: "Sydafrika – branch code", format: "6 siffror" },
  CNAPS: { country: "CN", label: "Kina – CNAPS", format: "12 siffror" },
} as const;
export type ClearingSystem = keyof typeof CLEARING_SYSTEMS;
export const CLEARING_SYSTEM_CODES = Object.keys(CLEARING_SYSTEMS) as ClearingSystem[];

// Avgiftsfördelning on a payment abroad (SLEV is set by the file on SEPA
// payments — it is never a choice).
export const CHARGE_BEARERS = ["SHAR", "DEBT"] as const;
export type ChargeBearer = (typeof CHARGE_BEARERS)[number];
export const CHARGE_BEARER_LABELS: Record<ChargeBearer, string> = {
  SHAR: "Delade avgifter (SHA)",
  DEBT: "Vi betalar alla avgifter (OUR)",
};
// What a payment-file row says about the charges it was sent with.
export const SENT_CHARGE_BEARER_LABELS: Record<"SLEV" | ChargeBearer, string> = {
  SLEV: "SEPA-avgifter (SLEV)",
  SHAR: "Delade avgifter (SHA)",
  DEBT: "Vi betalar alla avgifter (OUR)",
};

// Skatteverkets betalningskod for KU81 — 101 Varuexport/varuimport.
export const DEFAULT_PAYMENT_REPORTING_CODE = "101";
export const PAYMENT_REPORTING_THRESHOLD_SEK = 150_000;

// Betalningstyp per post in a payment batch.
export const PAYMENT_KINDS = ["domestic", "sepa", "international"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  domestic: "Inrikes",
  sepa: "SEPA",
  international: "Utland",
};

// A payee abroad: an IBAN of another country or a foreign account number —
// needs street, town and country on the supplier card. `iban` normalized
// (no spaces), null when there is none.
export function isForeignPayee(method: SupplierPaymentMethod | "" | null, iban: string | null): boolean {
  if (method === "foreign_account") return true;
  return method === "iban" && iban !== null && !iban.toUpperCase().startsWith("SE");
}

export type Pill = "running" | "delayed" | "stopped" | "done" | "draft";

export function formatBankgiro(digits: string): string {
  return digits.length > 4 ? `${digits.slice(0, -4)}-${digits.slice(-4)}` : digits;
}
export function formatPlusgiro(digits: string): string {
  return digits.length > 1 ? `${digits.slice(0, -1)}-${digits.slice(-1)}` : digits;
}

export function describeCreditor(c: {
  method: SupplierPaymentMethod;
  account: string | null;
  clearing: string | null;
  // Foreign account only: which kind of bank id `clearing` is (USABA …).
  clearingSystem?: string | null;
}): string {
  const account = c.account ?? "";
  switch (c.method) {
    case "bankgiro":
      return `Bankgiro ${formatBankgiro(account)}`;
    case "plusgiro":
      return `Plusgiro ${formatPlusgiro(account)}`;
    case "iban":
      return `IBAN ${account.replace(/(.{4})/g, "$1 ").trim()}`;
    case "foreign_account": {
      const bankId = c.clearing ? `${c.clearingSystem ?? "bank-id"} ${c.clearing}` : null;
      return `Utländskt konto ${account}${bankId ? ` (${bankId})` : ""}`;
    }
    case "bank_account": {
      const clearing = c.clearing ?? "";
      const rest = clearing && account.startsWith(clearing) ? account.slice(clearing.length).replace(/^0+/, "") : account;
      return `Bankkonto ${clearing}${clearing ? ", " : ""}${rest}`;
    }
  }
}

export const PAYMENT_BATCH_STATUS: Record<string, { pill: Pill; label: string }> = {
  draft: { pill: "draft", label: "Utkast" },
  exported: { pill: "running", label: "Exporterad" },
  confirmed: { pill: "done", label: "Bekräftad" },
  cancelled: { pill: "stopped", label: "Makulerad" },
};
export const PAYMENT_ITEM_STATUS: Record<string, { pill: Pill; label: string }> = {
  pending: { pill: "draft", label: "Utkast" },
  exported: { pill: "running", label: "Skickad" },
  confirmed: { pill: "done", label: "Bekräftad" },
  rejected: { pill: "stopped", label: "Avvisad" },
  returned: { pill: "delayed", label: "Återförd" },
  cancelled: { pill: "stopped", label: "Makulerad" },
};
export const OUTGOING_STATE: Record<string, { pill: Pill; label: string }> = {
  matched: { pill: "running", label: "Matchad" },
  return: { pill: "delayed", label: "Retur" },
  amount_mismatch: { pill: "stopped", label: "Beloppet avviker" },
  already_confirmed: { pill: "done", label: "Redan bekräftad" },
  not_waiting: { pill: "stopped", label: "Väntar inte på banken" },
  unknown: { pill: "draft", label: "Okänd" },
  booked: { pill: "done", label: "Bokförd" },
  ignored: { pill: "draft", label: "Hanterad utanför Nav" },
};
export const INCOMING_STATE: Record<string, { pill: Pill; label: string }> = {
  matched: { pill: "running", label: "Matchad" },
  suggested: { pill: "delayed", label: "Förslag" },
  unmatched: { pill: "stopped", label: "Omatchad" },
  not_sek: { pill: "stopped", label: "Annan valuta" },
  booked: { pill: "done", label: "Bokförd" },
  ignored: { pill: "draft", label: "Hanterad utanför Nav" },
};

// Bankfiler — labels and formatting for the web. Mirror of the parts of
// packages/shared/src/banking.ts the web needs (the web can't import
// @navet/shared). NO imports: banking.shared.test.ts loads this file.

export const SUPPLIER_PAYMENT_METHODS = ["bankgiro", "plusgiro", "bank_account", "iban"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  bankgiro: "Bankgiro",
  plusgiro: "Plusgiro",
  bank_account: "Bankkonto",
  iban: "IBAN",
};

export type Pill = "running" | "delayed" | "stopped" | "done" | "draft";

export function formatBankgiro(digits: string): string {
  return digits.length > 4 ? `${digits.slice(0, -4)}-${digits.slice(-4)}` : digits;
}
export function formatPlusgiro(digits: string): string {
  return digits.length > 1 ? `${digits.slice(0, -1)}-${digits.slice(-1)}` : digits;
}

export function describeCreditor(c: { method: SupplierPaymentMethod; account: string | null; clearing: string | null }): string {
  const account = c.account ?? "";
  switch (c.method) {
    case "bankgiro":
      return `Bankgiro ${formatBankgiro(account)}`;
    case "plusgiro":
      return `Plusgiro ${formatPlusgiro(account)}`;
    case "iban":
      return `IBAN ${account.replace(/(.{4})/g, "$1 ").trim()}`;
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

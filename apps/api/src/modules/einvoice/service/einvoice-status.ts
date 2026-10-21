// Nav's e-invoice transmission states and their mapping from the access
// point's raw `state` (spec §3.4). Pure: the status job and the service import
// it, the tests pin the table.
//
// Nav's five states are deliberately coarse. `delivered` is FINAL for Nav —
// whether the customer pays is the receivable ledger's business, never the
// access point's — so B2Brouter's paid/closed states collapse into it.

export const EINVOICE_STATUSES = ["sending", "sent", "delivered", "rejected", "failed"] as const;
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];

// B2Brouter `state` ⇒ Nav status (spec §3.4, verified against their OpenAPI
// 2026-06-26). The keys are matched case-insensitively and trimmed.
export const PROVIDER_STATE_MAP: Readonly<Record<string, EInvoiceStatus>> = {
  new: "sending",
  sending: "sending",
  sent: "sent",
  downloaded: "sent",
  registered: "delivered",
  accepted: "delivered",
  paid: "delivered",
  closed: "delivered",
  allegedly_paid: "delivered",
  refused: "rejected",
  error: "failed",
};

// A state we have never seen must NEVER read as delivered (the invoice would
// look settled on the card) and must not read as failed either (that frees
// the invoice for a second send — a possible duplicate). "sending" keeps the
// transmission live: the job keeps polling it, the raw state is stored in
// provider_state for the card, and nobody can send the invoice again until a
// known terminal state arrives. The service treats a known-unknown state as a
// reason to log, not to act.
export const UNKNOWN_PROVIDER_STATE_STATUS: EInvoiceStatus = "sending";

export function isKnownProviderState(state: string): boolean {
  return Object.hasOwn(PROVIDER_STATE_MAP, state.trim().toLowerCase());
}

export function mapProviderState(state: string): EInvoiceStatus {
  return PROVIDER_STATE_MAP[state.trim().toLowerCase()] ?? UNKNOWN_PROVIDER_STATE_STATUS;
}

// Live = blocks a new transmission (the partial unique index
// einvoice_transmissions_live), terminal = the job stops polling.
export function isLiveStatus(status: EInvoiceStatus): boolean {
  return status === "sending" || status === "sent" || status === "delivered";
}

export function isTerminalStatus(status: EInvoiceStatus): boolean {
  return status === "delivered" || status === "rejected" || status === "failed";
}

const STATUS_LABELS: Readonly<Record<EInvoiceStatus, string>> = {
  sending: "Skickas",
  sent: "Skickad",
  delivered: "Mottagen",
  rejected: "Avvisad",
  failed: "Misslyckad",
};

export function einvoiceStatusLabel(status: EInvoiceStatus): string {
  return STATUS_LABELS[status];
}

// B2Brouter error codes that deserve a Swedish sentence on the invoice card.
// Their `error_message` is either the bare code or a sentence containing it,
// so the lookup is a word match. Unknown ⇒ the text as received (it is still
// the best explanation we have). Extend this table as new codes turn up in
// the log — never guess at codes that have not been seen.
const PROVIDER_ERROR_TEXTS: Readonly<Record<string, string>> = {
  PEPPOL_NO_RECEIVER: "Mottagaren finns inte i Peppol",
};

export function providerErrorText(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  for (const [code, swedish] of Object.entries(PROVIDER_ERROR_TEXTS)) {
    if (new RegExp(`(^|[^A-Z0-9_])${code}([^A-Z0-9_]|$)`, "i").test(text)) return swedish;
  }
  return text;
}

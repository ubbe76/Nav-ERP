import type { InvoiceScanStatus } from "@navet/shared";

// Fakturaskanning — the status whitelist (spec §2). Pure.
//
//   new ──tolkning──▶ interpreted ──Skapa leverantörsfaktura──▶ converted
//    │                    │  ▲ (Tolka igen / Tolka med AI: a new result)
//    └──────Avvisa────────┴──▶ rejected ──Återställ──▶ new | interpreted
//                                    └──Radera──▶ (gone)
//
// converted and rejected are read-only except Återställ/Radera on rejected.
// A failed interpretation is not a status: the scan becomes interpreted with
// a result that lacks the fields (or stays new when the extraction crashed).

export const INVOICE_SCAN_ACTIONS = ["interpret", "convert", "reject", "restore", "delete"] as const;
export type InvoiceScanAction = (typeof INVOICE_SCAN_ACTIONS)[number];

// Att granska — the derived "pending" of the list, the alert and the
// guards below.
export const PENDING_SCAN_STATUSES = ["new", "interpreted"] as const satisfies readonly InvoiceScanStatus[];

const ALLOWED_FROM: Record<InvoiceScanAction, readonly InvoiceScanStatus[]> = {
  interpret: PENDING_SCAN_STATUSES,
  convert: PENDING_SCAN_STATUSES,
  reject: PENDING_SCAN_STATUSES,
  restore: ["rejected"],
  delete: ["rejected"],
};

export function canPerform(action: InvoiceScanAction, from: InvoiceScanStatus): boolean {
  return ALLOWED_FROM[action].includes(from);
}

export function allowedFrom(action: InvoiceScanAction): readonly InvoiceScanStatus[] {
  return ALLOWED_FROM[action];
}

// Where an action leaves the scan (null = it is deleted). An interpretation
// never moves a scan backwards: it ends interpreted when it succeeded, and a
// crashed extraction leaves the scan where it was (new stays new).
// Återställ goes back to where the scan was: interpreted when an
// interpretation succeeded on it (interpreted_by is set), else new.
export function statusAfter(
  action: InvoiceScanAction,
  from: InvoiceScanStatus,
  context: { interpretedOk?: boolean; wasInterpreted?: boolean } = {}
): InvoiceScanStatus | null {
  switch (action) {
    case "interpret":
      return context.interpretedOk === false ? from : "interpreted";
    case "convert":
      return "converted";
    case "reject":
      return "rejected";
    case "restore":
      return context.wasInterpreted ? "interpreted" : "new";
    case "delete":
      return null;
  }
}

export function isPendingStatus(status: InvoiceScanStatus): boolean {
  return (PENDING_SCAN_STATUSES as readonly InvoiceScanStatus[]).includes(status);
}

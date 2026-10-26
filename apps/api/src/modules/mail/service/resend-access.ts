import type { AccessRule } from "@navet/shared";

// "Skicka om" on the e-postlogg re-runs the ORIGINAL document send, with its
// status side effects (IO draft→confirmed, KO quote→confirmed, a new
// påminnelse row). The route's module rule (Inköp OR Försäljning) only says
// the user may resend something; this narrows it per logged document type so
// a sales-only user can't confirm a purchase order and vice versa. The test
// mail mirrors /mail/test (admin), and an unknown type fails closed.
export function resendAccessRule(documentType: string): AccessRule {
  // The alert digest is the one type that is never resent: it is a snapshot
  // of that morning's aviseringar and the next working day brings a fresh
  // one. The route answers 409 (AlertDigestResendError) before the rule is
  // consulted; the admin rule here only keeps the fail-closed default.
  switch (documentType) {
    case "inquiry":
    case "purchase_order":
      return ["inkop"];
    case "quote":
    case "order_confirmation":
    case "invoice":
    case "payment_reminder":
      return ["forsaljning"];
    // Avvikelsens reklamationsrapport: Kvalitet.
    case "deviation":
      return ["kvalitet"];
    case "alert_digest":
    default:
      return ["admin"];
  }
}

// Skicka om on an alert_digest row: 409, the Swedish text is what the web
// shows (the button itself is hidden for the type).
export class AlertDigestResendError extends Error {
  constructor() {
    super("Sammanställningen skickas igen nästa arbetsdag");
    this.name = "AlertDigestResendError";
  }
}

import type { AccessRule } from "@navet/shared";

// "Skicka om" on the e-postlogg re-runs the ORIGINAL document send, with its
// status side effects (IO draft→confirmed, KO quote→confirmed, a new
// påminnelse row). The route's module rule (Inköp OR Försäljning) only says
// the user may resend something; this narrows it per logged document type so
// a sales-only user can't confirm a purchase order and vice versa. The test
// mail mirrors /mail/test (admin), and an unknown type fails closed.
export function resendAccessRule(documentType: string): AccessRule {
  switch (documentType) {
    case "inquiry":
    case "purchase_order":
      return ["inkop"];
    case "quote":
    case "order_confirmation":
    case "invoice":
    case "payment_reminder":
      return ["forsaljning"];
    default:
      return ["admin"];
  }
}

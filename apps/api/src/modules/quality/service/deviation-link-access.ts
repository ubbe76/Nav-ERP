import { satisfiesRule, type Permission, type UserRole } from "@navet/shared";
import { ForbiddenError } from "../../auth/middleware/permission.middleware.js";

// The shortcuts' deviationId (POST /invoices/:id/credit, /quotes,
// /purchase-orders, /manufacturing-orders) writes into the case — a Kvalitet
// write on top of the document's own rule. An API client (no user) never
// links. Returns the 403 error to send, or null.
export function deviationLinkForbidden(
  deviationId: string | undefined,
  user: { role: UserRole; permissions?: readonly Permission[] } | undefined
): ForbiddenError | null {
  if (!deviationId) return null;
  if (user && satisfiesRule(user, ["kvalitet"])) return null;
  return new ForbiddenError();
}

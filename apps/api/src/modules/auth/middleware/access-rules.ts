import { satisfiesRule, type AccessRule, type Permission, type UserRole } from "@navet/shared";

// Named per-route overrides (config.access). Reads always include "office":
// reads are shared between office users, so an override must never take a
// read away from them — it only ADDS the workshop profile.

// Writes under /articles served by another module (leverantörskatalog, rutt,
// förkalkyl) belong to the article card, i.e. the Artiklar menu, as well as
// to their own module.
export const articleCardWrite = (moduleWrite: AccessRule): AccessRule => ["artiklar", ...moduleWrite];

// Stämpelterminalen: reads shared with office users; stamping writes need the
// terminal permission (tillverkning implies it).
export const TERMINAL_READ: AccessRule = ["office", "terminal"];
export const TERMINAL_WRITE: AccessRule = ["terminal"];
// Tillverkningsorder i läsläge (and what the terminal needs from an order).
export const MO_READ: AccessRule = ["office", "terminal", "tillverkningsorder_las"];
// Artikelöversikten with its drawings, plus the article picker's search.
export const OVERVIEW_READ: AccessRule = ["office", "artikeloversikt"];
// Names/numbers only — the shop floor's view of the personnel register.
export const DIRECTORY_READ: AccessRule = ["office", "terminal", "tillverkningsorder_las"];
// Personal & lön: the personnel register, frånvaro, attestering, the payroll
// period and the supervisor's attendance corrections. Deliberately NOT an
// office read — this is personal data (personnummer, wage, health) and the
// Personal & lön menu is the only legitimate path to it. The routes' own
// requireRole("admin", "supervisor") still runs after the gate.
export const PERSONAL: AccessRule = ["personal"];
// The personnel card's Schema and ATF tabs write registers that stayed under
// Tillverkning (scheman, ATF-saldon): either menu may write them, so moving
// the card to Personal & lön takes nothing away from a Tillverkning group.
export const PERSONNEL_CARD_WRITE: AccessRule = ["personal", "tillverkning"];
// Ta ut ATF: the terminal's withdrawal, also made from the personnel card.
export const ATF_WITHDRAW: AccessRule = [...TERMINAL_WRITE, "personal"];
// Konfigurera på orderraden: sales, planning and the article card all resolve variants.
export const CONFIGURE_ROW_WRITE: AccessRule = ["forsaljning", "tillverkning", "artiklar"];
// Leveranstidskontroll: a POST that only reads — sales and planning both run
// it. Reused by POST /delivery-time-check/apply, which WRITES (the KO's
// Förväntat leveransdatum and the TOs for what is missing): the seller is the
// one promising the date, so Försäljning alone must reach it; the KO status
// guard and the manufacturing service's own rules are the double check.
export const DELIVERY_CHECK: AccessRule = ["forsaljning", "tillverkning"];

// Prices (standard cost, sales price, lego setup/unit prices) are office data.
// A user without any menu permission — the verkstad profile — reaches a few
// article/MO reads through the overrides above, and gets the price fields
// nulled there (same response shape, so the web and integrations are
// unaffected). Admin and every office user see them as before.
export function canSeePrices(user: { role: UserRole; permissions?: readonly Permission[] }): boolean {
  return satisfiesRule(user, ["office"]);
}

// À-pris and värde in the lagerlogg are cost data: admin and the ekonomi
// permission only (satisfiesRule lets admin through). Everyone else gets the
// same response shape with the fields nulled.
export function canSeeStockCost(user: { role: UserRole; permissions?: readonly Permission[] }): boolean {
  return satisfiesRule(user, ["ekonomi"]);
}

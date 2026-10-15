import { satisfiesRule, type AccessToken, type Permission } from "./permissions";

// Behörighetsgrupper — which pages a user may open. The SINGLE source for the
// proxy's page guard, the sidebar and the module hubs, so a visible link can
// never lead to a refused page. Ordered most specific first; `exact` rules
// match only the path itself, the rest match the path and everything below
// it. "any" = every logged-in user. An unmatched path has no rule (null) and
// is admin-only — page-access.test.ts asserts every real page has a rule.
export type PageRule = readonly (AccessToken | "any")[];
type Entry = { path: string; exact?: boolean; rule: PageRule };

const SHARED_REGISTERS: PageRule = ["artiklar", "inkop", "forsaljning"];

const ENTRIES: readonly Entry[] = [
  { path: "/", exact: true, rule: ["office"] },
  { path: "/hjalp", rule: ["any"] },
  { path: "/ingen-behorighet", rule: ["any"] },
  { path: "/system", rule: ["admin"] },
  { path: "/ekonomi", rule: ["ekonomi"] },
  { path: "/rapporter", rule: ["rapporter"] },
  { path: "/artiklar", exact: true, rule: ["artiklar", "artikeloversikt"] },
  { path: "/artiklar/oversikt", rule: ["artikeloversikt"] },
  { path: "/artiklar", rule: ["artiklar"] },
  { path: "/artikelgrupper", rule: ["artiklar"] },
  { path: "/grunddata", rule: SHARED_REGISTERS },
  { path: "/inkop", rule: ["inkop"] },
  { path: "/leverantorer", rule: ["inkop"] },
  { path: "/forsaljning", rule: ["forsaljning"] },
  { path: "/kunder", rule: ["forsaljning"] },
  { path: "/lager", rule: ["lager"] },
  { path: "/tillverkning", exact: true, rule: ["tillverkning", "terminal", "tillverkningsorder_las"] },
  { path: "/tillverkning/terminal", rule: ["terminal"] },
  { path: "/tillverkning/ordrar", rule: ["tillverkningsorder_las"] },
  { path: "/tillverkning", rule: ["tillverkning"] },
];

function matches(entry: Entry, pathname: string): boolean {
  if (entry.exact) return pathname === entry.path;
  return pathname === entry.path || pathname.startsWith(`${entry.path}/`);
}

export function pageAccessFor(pathname: string): PageRule | null {
  return ENTRIES.find((e) => matches(e, pathname))?.rule ?? null;
}

type PageUser = { role: "admin" | "supervisor" | "user"; permissions?: readonly Permission[] };

export function canOpen(user: PageUser, pathname: string): boolean {
  const rule = pageAccessFor(pathname.split("?")[0]!);
  if (rule === null) return user.role === "admin";
  if (rule.includes("any")) return true;
  return satisfiesRule(user, rule.filter((t): t is AccessToken => t !== "any"));
}

// Where "/" sends someone who can't open the dashboard.
export function landingFor(user: PageUser): "/" | "/tillverkning" | "/artiklar" | "/ingen-behorighet" {
  if (canOpen(user, "/")) return "/";
  if (canOpen(user, "/tillverkning")) return "/tillverkning";
  if (canOpen(user, "/artiklar")) return "/artiklar";
  return "/ingen-behorighet";
}

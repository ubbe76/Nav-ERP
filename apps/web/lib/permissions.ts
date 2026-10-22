// Mirror of packages/shared/src/permissions.ts (the web can't import
// @navet/shared — see apps/web/lib/units.ts). NO imports: the API test suite
// loads this file directly to assert it matches the shared catalog.

// Behörighetsgrupper — the fixed permission catalog. Menu permissions gate a
// whole main menu (writes in that module); workshop permissions are the narrow
// shop-floor profile. Mirrored verbatim in apps/web/lib/permissions.ts (the web
// can't import @navet/shared); permissions.shared.test.ts keeps them in sync.
export const MENU_PERMISSIONS = [
  "artiklar",
  "inkop",
  "forsaljning",
  "tillverkning",
  "lager",
  "personal",
  "ekonomi",
  "rapporter",
] as const;
export const WORKSHOP_PERMISSIONS = ["terminal", "artikeloversikt", "tillverkningsorder_las"] as const;
export const PERMISSIONS = [...MENU_PERMISSIONS, ...WORKSHOP_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  artiklar: "Artiklar",
  inkop: "Inköp",
  forsaljning: "Försäljning",
  tillverkning: "Tillverkning",
  lager: "Lager",
  personal: "Personal & lön",
  ekonomi: "Ekonomi",
  rapporter: "Rapporter",
  terminal: "Stämpelterminal",
  artikeloversikt: "Artikelöversikt",
  tillverkningsorder_las: "Tillverkningsorder (läsläge)",
};

// A menu permission includes its parts.
export const PERMISSION_IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  tillverkning: ["terminal", "tillverkningsorder_las"],
  artiklar: ["artikeloversikt"],
};

// "office" = at least one menu permission; "admin" = the admin role only.
export type AccessToken = Permission | "office" | "admin";
export type AccessRule = readonly AccessToken[];

// Any-of. Admin always passes. A missing permissions field (route tests that
// inject req.user by hand) counts as no permissions.
export function satisfiesRule(
  user: { role: "admin" | "supervisor" | "user"; permissions?: readonly Permission[] },
  rule: AccessRule
): boolean {
  if (user.role === "admin") return true;
  const perms = user.permissions ?? [];
  return rule.some((token) => {
    if (token === "admin") return false;
    if (token === "office") return perms.some((p) => (MENU_PERMISSIONS as readonly string[]).includes(p));
    return perms.includes(token);
  });
}

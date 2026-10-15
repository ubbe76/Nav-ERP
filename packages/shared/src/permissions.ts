import { z } from "zod";
import type { UserRole } from "./auth.js";

// Behörighetsgrupper — the fixed permission catalog. Menu permissions gate a
// whole main menu (writes in that module); workshop permissions are the narrow
// shop-floor profile. Mirrored verbatim in apps/web/lib/permissions.ts (the web
// can't import @navet/shared); permissions.shared.test.ts keeps them in sync.
export const MENU_PERMISSIONS = ["artiklar", "inkop", "forsaljning", "tillverkning", "lager", "ekonomi", "rapporter"] as const;
export const WORKSHOP_PERMISSIONS = ["terminal", "artikeloversikt", "tillverkningsorder_las"] as const;
export const PERMISSIONS = [...MENU_PERMISSIONS, ...WORKSHOP_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  artiklar: "Artiklar",
  inkop: "Inköp",
  forsaljning: "Försäljning",
  tillverkning: "Tillverkning",
  lager: "Lager",
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

const KNOWN = new Set<string>(PERMISSIONS);

// The ONLY place implications are expanded. Admin gets everything and ignores
// the group; a non-admin without a group gets nothing. Unknown codes (a
// permission removed from the catalog but still stored in a group) are dropped.
export function effectivePermissions(role: UserRole, groupPermissions: readonly string[] | null): Permission[] {
  if (role === "admin") return [...PERMISSIONS];
  const granted = new Set<Permission>();
  for (const code of groupPermissions ?? []) {
    if (!KNOWN.has(code)) continue;
    granted.add(code as Permission);
    for (const implied of PERMISSION_IMPLIES[code as Permission] ?? []) granted.add(implied);
  }
  return PERMISSIONS.filter((p) => granted.has(p));
}

// Any-of. Admin always passes. A missing permissions field (route tests that
// inject req.user by hand) counts as no permissions.
export function satisfiesRule(
  user: { role: UserRole; permissions?: readonly Permission[] },
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

export const permissionSchema = z.enum(PERMISSIONS);

const permissionListSchema = z
  .array(permissionSchema)
  .refine((list) => new Set(list).size === list.length, { message: "Duplicate permission" });

export const createPermissionGroupSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  permissions: permissionListSchema,
});
export type CreatePermissionGroupInput = z.infer<typeof createPermissionGroupSchema>;

export const updatePermissionGroupSchema = createPermissionGroupSchema.partial();
export type UpdatePermissionGroupInput = z.infer<typeof updatePermissionGroupSchema>;

export const deletePermissionGroupQuerySchema = z.object({
  replacementId: z.string().uuid().optional(),
});

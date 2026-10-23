import { PERMISSION_IMPLIES, type Permission } from "../../lib/permissions";

// The permissions a list gives, with the implied ones added (lib has no
// shared helper for this on the client).
export function effectivePermissionsOf(list: readonly Permission[]): Permission[] {
  const out = new Set<Permission>(list);
  for (const p of list) for (const child of PERMISSION_IMPLIES[p] ?? []) out.add(child);
  return [...out];
}

"use client";

import { createContext, useContext, type ReactNode } from "react";
import { satisfiesRule, type AccessRule, type Permission } from "../lib/permissions";
import { canOpen } from "../lib/pageAccess";

type Role = "admin" | "supervisor" | "user";
const Ctx = createContext<{ role: Role; permissions: readonly Permission[] } | null>(null);

// Behörighetsgrupper on the client: hides buttons/links the user can't use.
// Never the boundary — the API refuses regardless. Outside a provider
// everything is denied (safe default).
export function PermissionsProvider({ role, permissions, children }: { role: Role; permissions: readonly Permission[]; children: ReactNode }) {
  return <Ctx.Provider value={{ role, permissions }}>{children}</Ctx.Provider>;
}

export function useCan(): (rule: AccessRule) => boolean {
  const user = useContext(Ctx);
  return (rule) => (user ? satisfiesRule(user, rule) : false);
}

export function useCanOpen(): (href: string) => boolean {
  const user = useContext(Ctx);
  return (href) => (user ? canOpen(user, href) : false);
}

// Personal has a role guard on top of its page rule (admin/arbetsledare), so a
// link to it must pass both — canOpen alone would show it to plain users.
export function useCanOpenPersonal(): boolean {
  const user = useContext(Ctx);
  return !!user && canOpen(user, "/personal/anstallda") && (user.role === "admin" || user.role === "supervisor");
}

// The signed-in role, for rules that are about who you are rather than which
// page you may open (e.g. stamping out someone else). Unconditional hook;
// outside a provider the lowest role is returned.
export function useRole(): Role {
  const user = useContext(Ctx);
  return user ? user.role : "user";
}

import { z } from "zod";

export const userRoleSchema = z.enum(["admin", "supervisor", "user"]);
export type UserRole = z.infer<typeof userRoleSchema>;

// Bootstrap: skapar den allra första användaren (blir alltid admin). Stängs
// automatiskt av service-lagret så snart minst en användare finns.
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(255),
  name: z.string().min(1).max(255),
  // The one-time code from the api log; checked by the service.
  setupCode: z.string().max(100).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Admin-only: skapar ytterligare användare med valfri roll.
export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(255),
  name: z.string().min(1).max(255),
  role: userRoleSchema.default("user"),
  // Behörighetsgrupp — ignored for admins (who have every permission). null =
  // no group = no access beyond Hjälp.
  permissionGroupId: z.string().uuid().nullable().optional(),
  // Endast läsning: may open what the group gives but change nothing. Never
  // together with role admin — the service refuses it (read-only-admin).
  readOnly: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// Admin-only: partiell uppdatering av en användare. `password` sätter ett
// nytt lösenord (lämnas utelämnat för att behålla det gamla), `active: false`
// stänger av kontot utan att radera det (spärras vid inloggning/tokenkoll).
export const updateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(255).optional(),
  role: userRoleSchema.optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(255).optional(),
  // Behörighetsgrupp — ignored for admins (who have every permission). null =
  // no group = no access beyond Hjälp.
  permissionGroupId: z.string().uuid().nullable().optional(),
  // Endast läsning — see createUserSchema.
  readOnly: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// Mjukraderade konton döljs som default (användarregistret ska bara visa
// aktiva/inaktiva-men-existerande konton) — includeDeleted är till för
// callers som behöver slå upp attributionen på en raderad användare (t.ex.
// verifikatkortets "bokfört av <namn>"). NOT z.coerce.boolean() — that turns
// the string "false" into true (same pitfall as stock locations' own
// includeInactive query param).
export const listUsersQuerySchema = z.object({
  includeDeleted: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

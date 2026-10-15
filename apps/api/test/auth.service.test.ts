import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, userSettings } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createUserSettingsRepository } from "../src/modules/auth/repository/user-settings.repository.js";
import {
  createAuthService,
  DuplicateEmailError,
  InvalidCredentialsError,
  LastAdminError,
  RegistrationClosedError,
  SelfDeleteError,
  UserNotFoundError,
} from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const repo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const service = createAuthService(repo, "test-secret", auditRepository);
const settingsRepo = createUserSettingsRepository(db);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, audit_log CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE users, audit_log CASCADE`);
});

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

describe("auth service — bootstrap registration", () => {
  it("registers the first user as admin and returns a session token", async () => {
    const { user, token } = await service.register({
      email: "admin@example.com",
      password: "correcthorsebattery",
      name: "Admin User",
    });

    expect(user.role).toBe("admin");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("stores a bcrypt hash, never the plaintext password", async () => {
    await service.register({
      email: "admin@example.com",
      password: "correcthorsebattery",
      name: "Admin User",
    });

    const row = await repo.findByEmail("admin@example.com");
    expect(row?.passwordHash).not.toBe("correcthorsebattery");
    expect(row?.passwordHash.startsWith("$2")).toBe(true);
  });

  it("refuses to register a second user once one already exists", async () => {
    await service.register({ email: "first@example.com", password: "correcthorsebattery", name: "First" });

    await expect(
      service.register({ email: "second@example.com", password: "correcthorsebattery", name: "Second" })
    ).rejects.toThrow(RegistrationClosedError);
  });
});

describe("auth service — admin-created users", () => {
  it("creates a user with an explicit role", async () => {
    const user = await service.createUser({
      email: "operator@example.com",
      password: "correcthorsebattery",
      name: "Operator",
      role: "user",
    });

    expect(user.role).toBe("user");
  });

  it("rejects duplicate emails", async () => {
    await service.createUser({ email: "dup@example.com", password: "correcthorsebattery", name: "One", role: "user" });

    await expect(
      service.createUser({ email: "dup@example.com", password: "correcthorsebattery", name: "Two", role: "user" })
    ).rejects.toThrow(DuplicateEmailError);
  });
});

describe("auth service — user administration", () => {
  it("lists all users including inactive, with account status", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });
    await service.updateUser(op.id, { active: false });

    const list = await service.listUsers();
    expect(list).toHaveLength(2);
    expect(list.find((u) => u.id === op.id)?.active).toBe(false);
  });

  it("updates name, email and role", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    const updated = await service.updateUser(op.id, { name: "Operator", email: "operator@example.com", role: "admin" });
    expect(updated.name).toBe("Operator");
    expect(updated.email).toBe("operator@example.com");
    expect(updated.role).toBe("admin");
  });

  it("rejects an email change that collides with another user", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    await expect(service.updateUser(op.id, { email: "admin@example.com" })).rejects.toThrow(DuplicateEmailError);
  });

  it("allows saving a user with their own unchanged email", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    const updated = await service.updateUser(op.id, { email: "op@example.com", name: "Op 2" });
    expect(updated.name).toBe("Op 2");
  });

  it("resets the password so the new one logs in and the old one does not", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "old-password-123", name: "Op", role: "user" });

    await service.updateUser(op.id, { password: "new-password-456" });

    await expect(service.login({ email: "op@example.com", password: "old-password-123" })).rejects.toThrow(
      InvalidCredentialsError
    );
    const { user } = await service.login({ email: "op@example.com", password: "new-password-456" });
    expect(user.id).toBe(op.id);
  });

  it("blocks login for a deactivated user", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    await service.updateUser(op.id, { active: false });
    await expect(service.login({ email: "op@example.com", password: "correcthorsebattery" })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it("refuses to demote the last active admin", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(service.updateUser(admin.id, { role: "user" })).rejects.toThrow(LastAdminError);
  });

  it("refuses to deactivate the last active admin", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(service.updateUser(admin.id, { active: false })).rejects.toThrow(LastAdminError);
  });

  it("allows demoting an admin when another active admin remains", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    await service.createUser({ email: "admin2@example.com", password: "correcthorsebattery", name: "Admin 2", role: "admin" });

    const updated = await service.updateUser(admin.id, { role: "user" });
    expect(updated.role).toBe("user");
  });

  it("404s on an unknown user id", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(
      service.updateUser("00000000-0000-0000-0000-000000000000", { name: "Ghost" })
    ).rejects.toThrow(UserNotFoundError);
  });

  it("accepts the supervisor role on create and update", async () => {
    const created = await service.createUser({
      email: `sup-${crypto.randomUUID().slice(0, 8)}@test.se`,
      name: "Arbetsledare", password: "hemligt123", role: "supervisor",
    });
    expect(created.role).toBe("supervisor");
    const updated = await service.updateUser(created.id, { role: "user" });
    expect(updated.role).toBe("user");
  });

  it("excludes soft-deleted users by default and includes them with includeDeleted", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });
    await service.deleteUser(op.id, admin.id);

    const filtered = await service.listUsers();
    expect(filtered.find((u) => u.id === op.id)).toBeUndefined();

    const withDeleted = await service.listUsers(true);
    const deletedRow = withDeleted.find((u) => u.id === op.id);
    expect(deletedRow).toBeDefined();
    expect(deletedRow?.deletedAt).not.toBeNull();
  });

  it("404s patching a soft-deleted user (blocks a pre-deletion JWT from reactivating itself)", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });
    await service.deleteUser(op.id, admin.id);

    await expect(service.updateUser(op.id, { active: true })).rejects.toThrow(UserNotFoundError);
  });
});

describe("auth service — deleteUser (soft delete)", () => {
  it("removes the account from listUsers and blocks login", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    await service.deleteUser(op.id, admin.id);

    const list = await service.listUsers();
    expect(list.find((u) => u.id === op.id)).toBeUndefined();
    await expect(service.login({ email: "op@example.com", password: "correcthorsebattery" })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it("frees up the email for a new account", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });

    await service.deleteUser(op.id, admin.id);

    const reused = await service.createUser({ email: "op@example.com", password: "newpassword123", name: "Op 2", role: "user" });
    expect(reused.email).toBe("op@example.com");
    expect(reused.id).not.toBe(op.id);
  });

  it("cleans up the deleted user's user_settings rows", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });
    await settingsRepo.upsert(op.id, "listPageSize", "100");

    await service.deleteUser(op.id, admin.id);

    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, op.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses to delete your own account", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(service.deleteUser(admin.id, admin.id)).rejects.toThrow(SelfDeleteError);
  });

  it("refuses to delete the last active admin", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const other = await service.createUser({ email: "other@example.com", password: "correcthorsebattery", name: "Other", role: "user" });

    await expect(service.deleteUser(admin.id, other.id)).rejects.toThrow(LastAdminError);
  });

  it("allows deleting an admin when another active admin remains", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const admin2 = await service.createUser({ email: "admin2@example.com", password: "correcthorsebattery", name: "Admin 2", role: "admin" });

    await service.deleteUser(admin2.id, admin.id);

    const list = await service.listUsers();
    expect(list.find((u) => u.id === admin2.id)).toBeUndefined();
  });

  it("404s deleting an unknown user id", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(
      service.deleteUser("00000000-0000-0000-0000-000000000000", admin.id)
    ).rejects.toThrow(UserNotFoundError);
  });

  it("404s deleting an already-deleted user", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" });
    await service.deleteUser(op.id, admin.id);

    await expect(service.deleteUser(op.id, admin.id)).rejects.toThrow(UserNotFoundError);
  });
});

describe("auth service — login", () => {
  it("logs in with correct credentials", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    const { user, token } = await service.login({ email: "admin@example.com", password: "correcthorsebattery" });
    expect(user.email).toBe("admin@example.com");
    expect(typeof token).toBe("string");
  });

  it("rejects an unknown email", async () => {
    await expect(
      service.login({ email: "nobody@example.com", password: "whatever123" })
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("rejects a wrong password", async () => {
    await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });

    await expect(
      service.login({ email: "admin@example.com", password: "wrong-password" })
    ).rejects.toThrow(InvalidCredentialsError);
  });
});

describe("auth service — token verification", () => {
  it("resolves a valid token back to the user", async () => {
    const { token, user } = await service.register({
      email: "admin@example.com",
      password: "correcthorsebattery",
      name: "Admin",
    });

    const resolved = await service.verifyToken(token);
    expect(resolved?.id).toBe(user.id);
  });

  it("rejects a malformed or tampered token", async () => {
    const resolved = await service.verifyToken("not-a-real-token");
    expect(resolved).toBeNull();
  });
});

// G1: audit trail over user administration. entityId is the user's EMAIL
// (readable, and survives a soft delete — softDelete never rewrites the
// email column, only deletedAt/active — see auth.repository.ts), not the
// uuid.
describe("auth service — audit log", () => {
  it("logs createUser with the acting admin, entityId = the new user's email", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" }, admin.id);

    const rows = await auditRows("user", "created");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(op.email);
    expect(rows[0]!.userId).toBe(admin.id);
    expect(rows[0]!.detail).toEqual({ name: "Op", role: "user", permissionGroupId: null });
  });

  it("logs updateUser's role/active with before/after and skips unrelated no-op saves", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" }, admin.id);

    await service.updateUser(op.id, { role: "supervisor", active: false }, admin.id);

    const rows = await auditRows("user", "updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(op.email);
    expect(rows[0]!.userId).toBe(admin.id);
    expect(rows[0]!.detail).toEqual({
      changedFields: ["role", "active"],
      role: { before: "user", after: "supervisor" },
      active: { before: true, after: false },
    });

    // Saving with the SAME values again is a no-op — nothing new is written.
    await service.updateUser(op.id, { role: "supervisor", active: false }, admin.id);
    expect(await auditRows("user", "updated")).toHaveLength(1);
  });

  // The whole point of THE masking rule: a password reset never carries the
  // new (or old) password anywhere in the audit detail — just the fact that
  // it changed.
  it("logs a password reset as password_changed: true, never a value", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" }, admin.id);

    await service.updateUser(op.id, { password: "brand-new-password-999" }, admin.id);

    const rows = await auditRows("user", "updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({ changedFields: ["password"], password_changed: true });
    // Belt and braces: the plaintext password never appears anywhere in the
    // serialized detail, under any key.
    expect(JSON.stringify(rows[0]!.detail)).not.toContain("brand-new-password-999");
  });

  it("logs deleteUser with entityId = the deleted user's (still readable) email", async () => {
    const { user: admin } = await service.register({ email: "admin@example.com", password: "correcthorsebattery", name: "Admin" });
    const op = await service.createUser({ email: "op@example.com", password: "correcthorsebattery", name: "Op", role: "user" }, admin.id);

    await service.deleteUser(op.id, admin.id);

    const rows = await auditRows("user", "deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe("op@example.com");
    expect(rows[0]!.userId).toBe(admin.id);
  });
});

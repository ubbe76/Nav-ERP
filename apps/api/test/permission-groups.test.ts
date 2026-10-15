import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService, PermissionGroupNotFoundError } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import jwt from "jsonwebtoken";
import { createPermissionGroupRepository } from "../src/modules/auth/repository/permission-group.repository.js";
import {
  createPermissionGroupService,
  DuplicatePermissionGroupCodeError,
  PermissionGroupInUseError,
} from "../src/modules/auth/service/permission-group.service.js";
import { InvalidReplacementError } from "../src/modules/register/service/register.errors.js";

const SECRET = "test-secret";
const authService = createAuthService(createAuthRepository(db), SECRET, createAuditRepository(db));
const groups = createPermissionGroupService(createPermissionGroupRepository(db));

// Never TRUNCATE permission_groups: the migration's seed rows (ALLA, VERKSTAD)
// must survive for every later test file. Only this file's own groups go.
async function clean() {
  await db.execute(sql`TRUNCATE user_settings, users, audit_log CASCADE`);
  await db.execute(sql`DELETE FROM permission_groups WHERE code NOT IN ('ALLA', 'VERKSTAD')`);
}
beforeEach(clean);
afterAll(clean);

async function makeGroup(code: string, permissions: string[]) {
  const [row] = await db.insert(permissionGroups).values({ code, name: code, permissions }).returning();
  return row!;
}

function tokenFor(userId: string, role: "admin" | "user" | "supervisor") {
  return jwt.sign({ sub: userId, role }, SECRET, { expiresIn: "1h" });
}

describe("migration seed", () => {
  it("creates ALLA and VERKSTAD with the agreed permissions", async () => {
    const rows = await db.execute<{ code: string; permissions: string[] }>(
      sql`SELECT code, permissions FROM permission_groups WHERE code IN ('ALLA','VERKSTAD') ORDER BY code`
    );
    // Spread: postgres-js returns a RowList (Array subclass with count/command).
    expect([...rows]).toEqual([
      { code: "ALLA", permissions: ["artiklar", "inkop", "forsaljning", "tillverkning", "lager"] },
      { code: "VERKSTAD", permissions: ["terminal", "artikeloversikt", "tillverkningsorder_las"] },
    ]);
  });

  // The test database migrates from empty, so the migration's own UPDATE ran
  // against zero users. Re-run that exact statement — read from the
  // migration file, not retyped — against a populated users table, as it
  // ran in production: every non-admin lands in ALLA, admins stay groupless.
  it("places every existing non-admin in ALLA and leaves admins alone (the migration's own UPDATE)", async () => {
    const migration = readFileSync(
      new URL("../../../packages/db/drizzle/0096_permission_groups.sql", import.meta.url),
      "utf8"
    );
    const update = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => /^UPDATE "users"/m.test(statement));
    expect(update, "0096 must contain the seed UPDATE").toBeDefined();
    const updateSql = update!.slice(update!.search(/^UPDATE "users"/m));

    const admin = await authService.createUser({ email: "seed-a@example.com", password: "correcthorse", name: "A", role: "admin" });
    const supervisor = await authService.createUser({ email: "seed-s@example.com", password: "correcthorse", name: "S", role: "supervisor" });
    const user = await authService.createUser({ email: "seed-u@example.com", password: "correcthorse", name: "U", role: "user" });

    await db.execute(sql.raw(updateSql));

    const rows = await db.execute<{ id: string; code: string | null }>(sql`
      SELECT u.id, g.code FROM users u LEFT JOIN permission_groups g ON g.id = u.permission_group_id
      WHERE u.id IN (${admin.id}, ${supervisor.id}, ${user.id})
    `);
    expect(Object.fromEntries([...rows].map((r) => [r.id, r.code]))).toEqual({
      [admin.id]: null,
      [supervisor.id]: "ALLA",
      [user.id]: "ALLA",
    });
    // And the sessions now carry ALLA's effective permissions.
    expect((await authService.verifyToken(tokenFor(user.id, "user")))!.permissions).toEqual([
      "artiklar", "inkop", "forsaljning", "tillverkning", "lager", "terminal", "artikeloversikt", "tillverkningsorder_las",
    ]);
  });
});

describe("permissions in the session", () => {
  it("expands the group's permissions with implications", async () => {
    const group = await makeGroup("T-PROD", ["tillverkning"]);
    const user = await authService.createUser({
      email: "p@example.com", password: "correcthorse", name: "P", role: "user", permissionGroupId: group.id,
    });
    expect(user.permissions).toEqual(["tillverkning", "terminal", "tillverkningsorder_las"]);
    const session = await authService.verifyToken(tokenFor(user.id, "user"));
    expect(session!.permissions).toEqual(["tillverkning", "terminal", "tillverkningsorder_las"]);
  });

  it("gives a user without a group no permissions, and admin all of them", async () => {
    const plain = await authService.createUser({ email: "n@example.com", password: "correcthorse", name: "N", role: "user" });
    expect((await authService.verifyToken(tokenFor(plain.id, "user")))!.permissions).toEqual([]);
    const admin = await authService.createUser({ email: "a@example.com", password: "correcthorse", name: "A", role: "admin" });
    expect((await authService.verifyToken(tokenFor(admin.id, "admin")))!.permissions).toHaveLength(10);
  });

  it("reflects a changed group on the very next request (no re-login)", async () => {
    const group = await makeGroup("T-CHG", ["lager"]);
    const user = await authService.createUser({
      email: "c@example.com", password: "correcthorse", name: "C", role: "user", permissionGroupId: group.id,
    });
    const token = tokenFor(user.id, "user");
    expect((await authService.verifyToken(token))!.permissions).toEqual(["lager"]);
    await db.execute(sql`UPDATE permission_groups SET permissions = '{inkop}' WHERE id = ${group.id}`);
    expect((await authService.verifyToken(token))!.permissions).toEqual(["inkop"]);
  });

  it("rejects an unknown group on create and update", async () => {
    await expect(
      authService.createUser({
        email: "x@example.com", password: "correcthorse", name: "X", role: "user",
        permissionGroupId: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toBeInstanceOf(PermissionGroupNotFoundError);
    const u = await authService.createUser({ email: "y@example.com", password: "correcthorse", name: "Y", role: "user" });
    await expect(
      authService.updateUser(u.id, { permissionGroupId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toBeInstanceOf(PermissionGroupNotFoundError);
  });

  it("lists users with their group and audits a group change", async () => {
    const group = await makeGroup("T-LIST", ["inkop"]);
    const u = await authService.createUser({ email: "l@example.com", password: "correcthorse", name: "L", role: "user" });
    await authService.updateUser(u.id, { permissionGroupId: group.id });
    const listed = (await authService.listUsers()).find((x) => x.id === u.id)!;
    expect(listed.permissionGroupId).toBe(group.id);
    expect(listed.permissionGroupName).toBe("T-LIST");
    const audit = await db.execute<{ detail: Record<string, unknown> }>(
      sql`SELECT detail FROM audit_log WHERE action = 'updated' ORDER BY created_at DESC LIMIT 1`
    );
    expect(audit[0]!.detail).toMatchObject({ permissionGroup: { before: null, after: group.id } });
  });
});

describe("permission group register", () => {
  it("creates, lists with userCount and updates", async () => {
    const g = await groups.create({ code: "T-EKO", name: "Ekonomi", permissions: ["ekonomi"] });
    await authService.createUser({ email: "e@example.com", password: "correcthorse", name: "E", role: "user", permissionGroupId: g.id });
    const listed = (await groups.list()).find((x) => x.id === g.id)!;
    expect(listed).toMatchObject({ code: "T-EKO", permissions: ["ekonomi"], userCount: 1 });
    const updated = await groups.update(g.id, { permissions: ["ekonomi", "rapporter"] });
    expect(updated.permissions).toEqual(["ekonomi", "rapporter"]);
  });

  it("rejects a duplicate code with 409-class error", async () => {
    await groups.create({ code: "T-DUP", name: "A", permissions: [] });
    await expect(groups.create({ code: "T-DUP", name: "B", permissions: [] })).rejects.toBeInstanceOf(
      DuplicatePermissionGroupCodeError
    );
  });

  it("refuses to delete a group in use without a replacement", async () => {
    const g = await groups.create({ code: "T-USED", name: "U", permissions: ["lager"] });
    await authService.createUser({ email: "u@example.com", password: "correcthorse", name: "U", role: "user", permissionGroupId: g.id });
    await expect(groups.remove(g.id)).rejects.toBeInstanceOf(PermissionGroupInUseError);
    expect(await groups.usage(g.id)).toEqual({ users: 1 });
  });

  it("moves users to the replacement, and nulls soft-deleted users instead of blocking", async () => {
    const from = await groups.create({ code: "T-FROM", name: "F", permissions: ["lager"] });
    const to = await groups.create({ code: "T-TO", name: "T", permissions: ["inkop"] });
    const live = await authService.createUser({ email: "v@example.com", password: "correcthorse", name: "V", role: "user", permissionGroupId: from.id });
    const gone = await authService.createUser({ email: "w@example.com", password: "correcthorse", name: "W", role: "user", permissionGroupId: from.id });
    const admin = await authService.createUser({ email: "z@example.com", password: "correcthorse", name: "Z", role: "admin" });
    await authService.deleteUser(gone.id, admin.id);

    expect(await groups.usage(from.id)).toEqual({ users: 1 }); // soft-deleted not counted
    await groups.remove(from.id, to.id);

    const rows = await db.execute<{ id: string; permission_group_id: string | null }>(
      sql`SELECT id, permission_group_id FROM users WHERE id IN (${live.id}, ${gone.id})`
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.permission_group_id]))).toEqual({ [live.id]: to.id, [gone.id]: null });
    expect((await groups.list()).some((g) => g.id === from.id)).toBe(false);
  });

  it("deletes an unused group without a replacement, and rejects a bad replacement", async () => {
    const g = await groups.create({ code: "T-FREE", name: "F", permissions: [] });
    await expect(groups.remove(g.id, g.id)).rejects.toBeInstanceOf(InvalidReplacementError);
    await expect(groups.remove(g.id, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(InvalidReplacementError);
    await groups.remove(g.id);
    expect((await groups.list()).some((x) => x.id === g.id)).toBe(false);
  });
});

import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { permissionGroups, plugins, userSettings, users, type Db, type Tx } from "@navet/db";
import type { UserRole } from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { DuplicateEmailError, LastAdminError } from "../service/auth.service.js";

// Every user read carries the group's raw permission list (expanded in the
// service by effectivePermissions) and name — one join, so verifyToken sees a
// changed group on the very next request.
const userWithGroup = {
  ...getTableColumns(users),
  groupPermissions: permissionGroups.permissions,
  permissionGroupName: permissionGroups.name,
};

// Sista admin (granskningen 2026-11-10): the guard runs in the write's own
// transaction. Every active admin row — the target's too — is locked FOR
// UPDATE in id order first, so two admins demoting each other at the same
// time serialize (the second re-reads the set after the first commits and
// finds itself alone) instead of both passing a count read outside any lock.
// Throws when the target is an active admin and no other one remains.
async function assertAnotherActiveAdmin(tx: Tx, id: string) {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)))
    .orderBy(asc(users.id))
    .for("update");
  if (admins.some((a) => a.id === id) && admins.length <= 1) throw new LastAdminError();
}

// Two concurrent Skapa/Ändra with the same address pass the service's
// findByEmail pre-check; the unique index decides and the loser gets 409.
function duplicateEmail(err: unknown, email: string | undefined): never {
  if (email !== undefined && isUniqueViolation(err, "users_email_unique")) throw new DuplicateEmailError(email);
  throw err;
}

export function createAuthRepository(db: Db) {
  return {
    async create(input: {
      email: string;
      passwordHash: string;
      name: string;
      role: UserRole;
      permissionGroupId?: string | null;
      readOnly?: boolean;
    }) {
      try {
        const [row] = await db
          .insert(users)
          .values({
            email: input.email,
            passwordHash: input.passwordHash,
            name: input.name,
            role: input.role,
            permissionGroupId: input.permissionGroupId ?? null,
            readOnly: input.readOnly ?? false,
          })
          .returning();
        return row!;
      } catch (err) {
        duplicateEmail(err, input.email);
      }
    },

    // Excludes soft-deleted rows so a freed-up email doesn't false-positive
    // as a duplicate at login/registration lookup time. lower() on both
    // sides: the same expression as the unique index (0205).
    async findByEmail(email: string) {
      const [row] = await db
        .select(userWithGroup)
        .from(users)
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)));
      return row ?? null;
    },

    async findById(id: string) {
      const [row] = await db
        .select(userWithGroup)
        .from(users)
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(eq(users.id, id));
      return row ?? null;
    },

    // Tillägg: the technical user behind an API key, with its plugin.
    async findByPluginKeyHash(hash: string) {
      const [row] = await db
        .select({ ...userWithGroup, pluginId: plugins.id, pluginKey: plugins.key, pluginStatus: plugins.status })
        .from(plugins)
        .innerJoin(users, eq(users.id, plugins.userId))
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(eq(plugins.apiKeyHash, hash));
      return row ?? null;
    },

    async groupOwnedByPlugin(id: string) {
      const [row] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.permissionGroupId, id));
      return row !== undefined;
    },

    async groupExists(id: string) {
      const [row] = await db.select({ id: permissionGroups.id }).from(permissionGroups).where(eq(permissionGroups.id, id));
      return row !== undefined;
    },

    async count() {
      const rows = await db.select({ id: users.id }).from(users);
      return rows.length;
    },

    // includeDeleted: soft-deleted accounts stay out of the default list
    // (the user-admin register), but a few cross-module callers (e.g. the
    // verifikat card resolving "bokfört av <namn>") need to see them too, so
    // a deleted user's attribution elsewhere doesn't go nameless.
    async list(includeDeleted = false) {
      return db
        .select(userWithGroup)
        .from(users)
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(includeDeleted ? undefined : isNull(users.deletedAt))
        .orderBy(asc(users.name));
    },

    // losesAdmin: the change demotes or deactivates the account — then the
    // last-admin guard runs under the admin rows' lock (LastAdminError).
    // bumpTokenVersion: a new password ends every session issued before it.
    async update(
      id: string,
      fields: Partial<{
        email: string;
        name: string;
        role: UserRole;
        active: boolean;
        passwordHash: string;
        permissionGroupId: string | null;
        readOnly: boolean;
      }>,
      opts: { losesAdmin?: boolean; bumpTokenVersion?: boolean } = {}
    ) {
      try {
        return await db.transaction(async (tx) => {
          if (opts.losesAdmin) await assertAnotherActiveAdmin(tx, id);
          const [row] = await tx
            .update(users)
            .set({
              ...fields,
              ...(opts.bumpTokenVersion ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
              updatedAt: new Date(),
            })
            .where(eq(users.id, id))
            .returning();
          return row ?? null;
        });
      } catch (err) {
        duplicateEmail(err, fields.email);
      }
    },

    // Soft delete: the row stays (attribution on the ~30 created_by/locked_by/
    // attested_by FKs elsewhere is preserved), but the account disappears from
    // the list/login (active=false, deleted_at set) and its email is freed up
    // (partial unique index in the schema). user_settings rows are cleaned up
    // in the same transaction since ON DELETE CASCADE only fires on a hard
    // delete.
    async softDelete(id: string) {
      return db.transaction(async (tx) => {
        await assertAnotherActiveAdmin(tx, id);
        await tx.delete(userSettings).where(eq(userSettings.userId, id));
        const [row] = await tx
          .update(users)
          .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
          .where(eq(users.id, id))
          .returning();
        return row ?? null;
      });
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;

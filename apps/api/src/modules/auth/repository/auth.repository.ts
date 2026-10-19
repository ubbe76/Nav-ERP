import { and, asc, eq, getTableColumns, isNull } from "drizzle-orm";
import { permissionGroups, userSettings, users, type Db } from "@navet/db";
import type { UserRole } from "@navet/shared";

// Every user read carries the group's raw permission list (expanded in the
// service by effectivePermissions) and name — one join, so verifyToken sees a
// changed group on the very next request.
const userWithGroup = {
  ...getTableColumns(users),
  groupPermissions: permissionGroups.permissions,
  permissionGroupName: permissionGroups.name,
};

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
    },

    // Excludes soft-deleted rows so a freed-up email doesn't false-positive
    // as a duplicate at login/registration lookup time.
    async findByEmail(email: string) {
      const [row] = await db
        .select(userWithGroup)
        .from(users)
        .leftJoin(permissionGroups, eq(users.permissionGroupId, permissionGroups.id))
        .where(and(eq(users.email, email), isNull(users.deletedAt)));
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
      }>
    ) {
      const [row] = await db
        .update(users)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return row ?? null;
    },

    async countActiveAdmins() {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true)));
      return rows.length;
    },

    // Soft delete: the row stays (attribution on the ~30 created_by/locked_by/
    // attested_by FKs elsewhere is preserved), but the account disappears from
    // the list/login (active=false, deleted_at set) and its email is freed up
    // (partial unique index in the schema). user_settings rows are cleaned up
    // in the same transaction since ON DELETE CASCADE only fires on a hard
    // delete.
    async softDelete(id: string) {
      return db.transaction(async (tx) => {
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

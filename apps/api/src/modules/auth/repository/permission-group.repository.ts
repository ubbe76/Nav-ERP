import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { permissionGroups, users, type Db } from "@navet/db";

export function createPermissionGroupRepository(db: Db) {
  // userCount: live accounts only — a soft-deleted user can't log in, so it
  // doesn't make a group "in use" (remove() nulls their link instead). The outer
  // id is written qualified by hand: drizzle renders a single-table column
  // unqualified, which inside the subquery would resolve to users.id.
  const liveUserCount = sql<number>`(
    select count(*)::int from ${users}
    where ${users.permissionGroupId} = "permission_groups"."id" and ${users.deletedAt} is null
  )`;

  return {
    async list() {
      return db
        .select({
          id: permissionGroups.id,
          code: permissionGroups.code,
          name: permissionGroups.name,
          permissions: permissionGroups.permissions,
          userCount: liveUserCount,
        })
        .from(permissionGroups)
        .orderBy(asc(permissionGroups.code));
    },

    async get(id: string) {
      const [row] = await db.select().from(permissionGroups).where(eq(permissionGroups.id, id));
      return row ?? null;
    },

    async create(values: { code: string; name: string; permissions: string[] }) {
      const [row] = await db.insert(permissionGroups).values(values).returning();
      return row!;
    },

    async update(id: string, fields: Partial<{ code: string; name: string; permissions: string[] }>) {
      const [row] = await db
        .update(permissionGroups)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(permissionGroups.id, id))
        .returning();
      return row ?? null;
    },

    async liveUsers(id: string) {
      const [row] = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.permissionGroupId, id), isNull(users.deletedAt)));
      return row?.n ?? 0;
    },

    // One transaction: soft-deleted users lose the link (they'd otherwise
    // block the restrict FK forever), live users move to the replacement if
    // one is given, then the group goes. Returns false when live users remain
    // and no replacement was given — the service turns that into a 409.
    async removeWithReplacement(id: string, replacementId: string | undefined) {
      return db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ permissionGroupId: null })
          .where(and(eq(users.permissionGroupId, id), isNotNull(users.deletedAt)));
        if (replacementId) {
          await tx.update(users).set({ permissionGroupId: replacementId }).where(eq(users.permissionGroupId, id));
        } else {
          const [row] = await tx.select({ n: count() }).from(users).where(eq(users.permissionGroupId, id));
          if ((row?.n ?? 0) > 0) return false;
        }
        await tx.delete(permissionGroups).where(eq(permissionGroups.id, id));
        return true;
      });
    },
  };
}

export type PermissionGroupRepository = ReturnType<typeof createPermissionGroupRepository>;

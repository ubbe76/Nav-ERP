import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { auditLog, permissionGroups, plugins, users, type Db } from "@navet/db";

// Händelseloggen (granskningen 2026-11-10): a group's permission list is
// what every member may do, so creating, changing and removing a group is
// logged in the write's own transaction — entityId the group's code at the
// time, like the user log's email.

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
          // Tillägg: the plugin that owns the group (its technical user's
          // group), null for an ordinary group.
          pluginId: sql<string | null>`(select p.id from ${plugins} p where p.permission_group_id = "permission_groups"."id")`,
        })
        .from(permissionGroups)
        .orderBy(asc(permissionGroups.code));
    },

    async get(id: string) {
      const [row] = await db.select().from(permissionGroups).where(eq(permissionGroups.id, id));
      return row ?? null;
    },

    async create(values: { code: string; name: string; permissions: string[] }, userId: string | null) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(permissionGroups).values(values).returning();
        await tx.insert(auditLog).values({
          entityType: "permission_group",
          entityId: row!.code,
          action: "created",
          detail: { name: row!.name, permissions: row!.permissions },
          userId,
        });
        return row!;
      });
    },

    // Logged only when a field actually changes; code/name/permissions each
    // get a before/after.
    async update(id: string, fields: Partial<{ code: string; name: string; permissions: string[] }>, userId: string | null) {
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(permissionGroups).where(eq(permissionGroups.id, id)).for("update");
        if (!before) return null;
        const [row] = await tx
          .update(permissionGroups)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(permissionGroups.id, id))
          .returning();
        const detail: Record<string, { before: unknown; after: unknown }> = {};
        if (row!.code !== before.code) detail.code = { before: before.code, after: row!.code };
        if (row!.name !== before.name) detail.name = { before: before.name, after: row!.name };
        const asSet = (list: string[]) => [...list].sort().join(",");
        if (asSet(row!.permissions) !== asSet(before.permissions)) detail.permissions = { before: before.permissions, after: row!.permissions };
        if (Object.keys(detail).length > 0) {
          await tx.insert(auditLog).values({
            entityType: "permission_group",
            entityId: row!.code,
            action: "updated",
            detail: { changedFields: Object.keys(detail), ...detail },
            userId,
          });
        }
        return row!;
      });
    },

    async ownedByPlugin(id: string) {
      const [row] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.permissionGroupId, id));
      return row !== undefined;
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
    async removeWithReplacement(id: string, replacementId: string | undefined, userId: string | null) {
      return db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ permissionGroupId: null })
          .where(and(eq(users.permissionGroupId, id), isNotNull(users.deletedAt)));
        let movedUsers = 0;
        if (replacementId) {
          const moved = await tx
            .update(users)
            .set({ permissionGroupId: replacementId })
            .where(eq(users.permissionGroupId, id))
            .returning({ id: users.id });
          movedUsers = moved.length;
        } else {
          const [row] = await tx.select({ n: count() }).from(users).where(eq(users.permissionGroupId, id));
          if ((row?.n ?? 0) > 0) return false;
        }
        const [removed] = await tx.delete(permissionGroups).where(eq(permissionGroups.id, id)).returning();
        if (removed) {
          const replacement = replacementId
            ? (await tx.select({ code: permissionGroups.code }).from(permissionGroups).where(eq(permissionGroups.id, replacementId)))[0]
            : undefined;
          await tx.insert(auditLog).values({
            entityType: "permission_group",
            entityId: removed.code,
            action: "deleted",
            detail: {
              name: removed.name,
              permissions: removed.permissions,
              ...(replacementId ? { replacement: replacement?.code ?? replacementId, movedUsers } : {}),
            },
            userId,
          });
        }
        return true;
      });
    },
  };
}

export type PermissionGroupRepository = ReturnType<typeof createPermissionGroupRepository>;

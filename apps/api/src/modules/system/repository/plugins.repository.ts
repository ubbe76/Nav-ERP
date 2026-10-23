import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, max, notExists, or, sql } from "drizzle-orm";
import { permissionGroups, pluginDeliveries, pluginEvents, plugins, users, type Db, type Tx } from "@navet/db";
import { PLUGIN_TEST_EVENT_TYPE, type Permission, type PluginManifest, type PluginStatus } from "@navet/shared";

// Tillägg — the plugins, their technical users and groups, and the webhook
// outbox. Every multi-table write runs in ONE transaction; nothing here ever
// calls out over HTTP.

export type PluginRow = typeof plugins.$inferSelect;

export interface PluginWithAccess {
  plugin: PluginRow;
  groupPermissions: string[];
  readOnly: boolean;
  userActive: boolean;
}

export interface ClaimedDelivery {
  id: string;
  claimedUntil: Date;
  attempts: number;
  pluginId: string;
  pluginKey: string;
  pluginStatus: PluginStatus;
  baseUrl: string;
  manifest: PluginManifest;
  webhookSecret: string;
  groupPermissions: string[];
  eventId: string;
  eventType: string;
  entityId: string;
  entityNumber: string | null;
  data: Record<string, string | null> | null;
  occurredAt: Date;
}

const deliveryColumns = {
  id: pluginDeliveries.id,
  eventId: pluginEvents.id,
  eventType: pluginEvents.type,
  entityId: pluginEvents.entityId,
  entityNumber: pluginEvents.entityNumber,
  occurredAt: pluginEvents.occurredAt,
  status: pluginDeliveries.status,
  attempts: pluginDeliveries.attempts,
  nextAttemptAt: pluginDeliveries.nextAttemptAt,
  lastAttemptAt: pluginDeliveries.lastAttemptAt,
  lastStatusCode: pluginDeliveries.lastStatusCode,
  lastError: pluginDeliveries.lastError,
  deliveredAt: pluginDeliveries.deliveredAt,
};

export type DeliveryRow = {
  id: string;
  eventId: string;
  eventType: string;
  entityId: string;
  entityNumber: string | null;
  occurredAt: Date;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
};

export interface InstallValues {
  key: string;
  name: string;
  baseUrl: string;
  manifest: PluginManifest;
  permissions: Permission[];
  readOnly: boolean;
  apiKeyHash: string;
  apiKeyPrefix: string;
  webhookSecret: string;
  installedBy: string | null;
}

export const pluginUserName = (name: string) => `Tillägg: ${name}`;

// permission_groups.code is varchar(20) and unique: "plg-<key>" when it fits
// and is free, otherwise "plg-" + random hex.
async function freeGroupCode(tx: Tx, key: string): Promise<string> {
  const preferred = `plg-${key}`;
  if (preferred.length <= 20) {
    const [taken] = await tx.select({ id: permissionGroups.id }).from(permissionGroups).where(eq(permissionGroups.code, preferred));
    if (!taken) return preferred;
  }
  return `plg-${randomBytes(6).toString("hex")}`;
}

// The technical user's e-mail: <key>@tillagg.invalid (a reserved TLD — mail
// can never go there), suffixed when an earlier install of the same key left
// its deactivated user behind.
async function freeUserEmail(tx: Tx, key: string): Promise<string> {
  const preferred = `${key}@tillagg.invalid`;
  const [taken] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, preferred), isNull(users.deletedAt)));
  return taken ? `${key}-${randomBytes(4).toString("hex")}@tillagg.invalid` : preferred;
}

export function createPluginsRepository(db: Db) {
  async function withAccess(where: ReturnType<typeof eq>): Promise<PluginWithAccess[]> {
    const rows = await db
      .select({
        plugin: plugins,
        groupPermissions: permissionGroups.permissions,
        readOnly: users.readOnly,
        userActive: users.active,
      })
      .from(plugins)
      .innerJoin(users, eq(users.id, plugins.userId))
      .innerJoin(permissionGroups, eq(permissionGroups.id, plugins.permissionGroupId))
      .where(where)
      .orderBy(asc(plugins.name));
    return rows;
  }

  return {
    async list(failedSince: Date) {
      const lastDelivered = db
        .select({ pluginId: pluginDeliveries.pluginId, at: max(pluginDeliveries.deliveredAt).as("last_delivered_at") })
        .from(pluginDeliveries)
        .groupBy(pluginDeliveries.pluginId)
        .as("last_delivered");
      const failed = db
        .select({ pluginId: pluginDeliveries.pluginId, n: count().as("failed_count") })
        .from(pluginDeliveries)
        .where(and(eq(pluginDeliveries.status, "failed"), gte(pluginDeliveries.lastAttemptAt, failedSince)))
        .groupBy(pluginDeliveries.pluginId)
        .as("failed");
      return db
        .select({
          plugin: plugins,
          lastDeliveredAt: lastDelivered.at,
          failedLast7Days: sql<number>`coalesce(${failed.n}, 0)::int`,
        })
        .from(plugins)
        .leftJoin(lastDelivered, eq(lastDelivered.pluginId, plugins.id))
        .leftJoin(failed, eq(failed.pluginId, plugins.id))
        .orderBy(asc(plugins.name));
    },

    async get(id: string): Promise<PluginWithAccess | null> {
      return (await withAccess(eq(plugins.id, id)))[0] ?? null;
    },

    async listActive(): Promise<PluginWithAccess[]> {
      return withAccess(eq(plugins.status, "active"));
    },

    async keyExists(key: string): Promise<boolean> {
      const [row] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.key, key));
      return row !== undefined;
    },

    async deliveryStats(pluginId: string, failedSince: Date) {
      const [row] = await db
        .select({
          lastDeliveredAt: max(pluginDeliveries.deliveredAt),
          failed: sql<number>`count(*) filter (where ${pluginDeliveries.status} = 'failed' and ${pluginDeliveries.lastAttemptAt} >= ${failedSince.toISOString()}::timestamptz)::int`,
          pending: sql<number>`count(*) filter (where ${pluginDeliveries.status} = 'pending')::int`,
        })
        .from(pluginDeliveries)
        .where(eq(pluginDeliveries.pluginId, pluginId));
      return { lastDeliveredAt: row?.lastDeliveredAt ?? null, failed: row?.failed ?? 0, pending: row?.pending ?? 0 };
    },

    // Installera: the group, the technical user and the plugin in ONE
    // transaction — any failure leaves nothing behind.
    async install(values: InstallValues, unusablePasswordHash: string): Promise<string> {
      return db.transaction(async (tx) => {
        const [group] = await tx
          .insert(permissionGroups)
          .values({ code: await freeGroupCode(tx, values.key), name: pluginUserName(values.name), permissions: values.permissions })
          .returning({ id: permissionGroups.id });
        const [user] = await tx
          .insert(users)
          .values({
            email: await freeUserEmail(tx, values.key),
            passwordHash: unusablePasswordHash,
            name: pluginUserName(values.name),
            role: "user",
            kind: "plugin",
            permissionGroupId: group!.id,
            readOnly: values.readOnly,
          })
          .returning({ id: users.id });
        const [plugin] = await tx
          .insert(plugins)
          .values({
            key: values.key,
            name: values.name,
            baseUrl: values.baseUrl,
            manifest: values.manifest,
            userId: user!.id,
            permissionGroupId: group!.id,
            apiKeyHash: values.apiKeyHash,
            apiKeyPrefix: values.apiKeyPrefix,
            webhookSecret: values.webhookSecret,
            installedBy: values.installedBy,
          })
          .returning({ id: plugins.id });
        return plugin!.id;
      });
    },

    // One transaction under the plugin row's lock: the plugin, its user's
    // name/Endast läsning and its group's name/permissions together.
    async update(
      id: string,
      fields: {
        name?: string;
        baseUrl?: string;
        manifest?: PluginManifest;
        permissions?: Permission[];
        readOnly?: boolean;
        status?: PluginStatus;
      }
    ): Promise<PluginRow | null> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(plugins).where(eq(plugins.id, id)).for("update");
        if (!current) return null;
        const now = new Date();
        const [row] = await tx
          .update(plugins)
          .set({
            ...(fields.name !== undefined ? { name: fields.name } : {}),
            ...(fields.baseUrl !== undefined ? { baseUrl: fields.baseUrl } : {}),
            ...(fields.manifest !== undefined ? { manifest: fields.manifest } : {}),
            ...(fields.status !== undefined ? { status: fields.status } : {}),
            updatedAt: now,
          })
          .where(eq(plugins.id, id))
          .returning();
        if (fields.name !== undefined || fields.readOnly !== undefined) {
          await tx
            .update(users)
            .set({
              ...(fields.name !== undefined ? { name: pluginUserName(fields.name) } : {}),
              ...(fields.readOnly !== undefined ? { readOnly: fields.readOnly } : {}),
              updatedAt: now,
            })
            .where(eq(users.id, current.userId));
        }
        if (fields.name !== undefined || fields.permissions !== undefined) {
          await tx
            .update(permissionGroups)
            .set({
              ...(fields.name !== undefined ? { name: pluginUserName(fields.name) } : {}),
              ...(fields.permissions !== undefined ? { permissions: fields.permissions } : {}),
              updatedAt: now,
            })
            .where(eq(permissionGroups.id, current.permissionGroupId));
        }
        return row ?? null;
      });
    },

    async setApiKey(id: string, hash: string, prefix: string): Promise<PluginRow | null> {
      const [row] = await db
        .update(plugins)
        .set({ apiKeyHash: hash, apiKeyPrefix: prefix, updatedAt: new Date() })
        .where(eq(plugins.id, id))
        .returning();
      return row ?? null;
    },

    async setWebhookSecret(id: string, secret: string): Promise<PluginRow | null> {
      const [row] = await db.update(plugins).set({ webhookSecret: secret, updatedAt: new Date() }).where(eq(plugins.id, id)).returning();
      return row ?? null;
    },

    // Avinstallera, in one transaction: the plugin goes (its deliveries
    // cascade), events no other plugin waits for go, the technical user is
    // deactivated — never deleted, audit rows and created_by point at it —
    // and loses the group, which then goes too.
    async uninstall(id: string): Promise<PluginRow | null> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(plugins).where(eq(plugins.id, id)).for("update");
        if (!current) return null;
        const eventIds = (
          await tx.select({ id: pluginDeliveries.eventId }).from(pluginDeliveries).where(eq(pluginDeliveries.pluginId, id))
        ).map((r) => r.id);
        await tx.delete(plugins).where(eq(plugins.id, id));
        if (eventIds.length > 0) {
          await tx
            .delete(pluginEvents)
            .where(
              and(
                inArray(pluginEvents.id, eventIds),
                notExists(tx.select({ one: sql`1` }).from(pluginDeliveries).where(eq(pluginDeliveries.eventId, pluginEvents.id)))
              )
            );
        }
        await tx
          .update(users)
          .set({ active: false, permissionGroupId: null, updatedAt: new Date() })
          .where(eq(users.id, current.userId));
        await tx.delete(permissionGroups).where(eq(permissionGroups.id, current.permissionGroupId));
        return current;
      });
    },

    async deliveries(pluginId: string, limit = 100): Promise<DeliveryRow[]> {
      return db
        .select(deliveryColumns)
        .from(pluginDeliveries)
        .innerJoin(pluginEvents, eq(pluginEvents.id, pluginDeliveries.eventId))
        .where(eq(pluginDeliveries.pluginId, pluginId))
        .orderBy(desc(pluginDeliveries.createdAt), desc(pluginEvents.occurredAt))
        .limit(limit);
    },

    async findDelivery(pluginId: string, deliveryId: string): Promise<DeliveryRow | null> {
      const [row] = await db
        .select(deliveryColumns)
        .from(pluginDeliveries)
        .innerJoin(pluginEvents, eq(pluginEvents.id, pluginDeliveries.eventId))
        .where(and(eq(pluginDeliveries.id, deliveryId), eq(pluginDeliveries.pluginId, pluginId)));
      return row ?? null;
    },

    // Skicka igen: a failed delivery starts the schedule over. Conditional
    // on failed, so a double click can't reset a delivery in flight.
    async retryDelivery(pluginId: string, deliveryId: string, now: Date): Promise<boolean> {
      const rows = await db
        .update(pluginDeliveries)
        .set({ status: "pending", attempts: 0, nextAttemptAt: now, claimedUntil: null })
        .where(and(eq(pluginDeliveries.id, deliveryId), eq(pluginDeliveries.pluginId, pluginId), eq(pluginDeliveries.status, "failed")))
        .returning({ id: pluginDeliveries.id });
      return rows.length > 0;
    },

    // Skicka testhändelse: a plugin.test event with one delivery, already
    // claimed by the caller (who sends it at once) — the job never picks it.
    async createTestDelivery(plugin: { id: string; key: string }, claimedUntil: Date): Promise<string> {
      return db.transaction(async (tx) => {
        const [event] = await tx
          .insert(pluginEvents)
          .values({ type: PLUGIN_TEST_EVENT_TYPE, entityId: plugin.id, entityNumber: plugin.key })
          .returning({ id: pluginEvents.id });
        const [delivery] = await tx
          .insert(pluginDeliveries)
          .values({ pluginId: plugin.id, eventId: event!.id, claimedUntil })
          .returning({ id: pluginDeliveries.id });
        return delivery!.id;
      });
    },

    // --- The dispatcher -------------------------------------------------------

    // Claims up to `limit` due deliveries of active plugins: a conditional
    // UPDATE over a FOR UPDATE SKIP LOCKED subselect, so two runs (or two
    // processes) never take the same row. The claim is the run's lease on the
    // row; nothing is held open while the HTTP calls run.
    async claimDue(now: Date, claimedUntil: Date, limit: number): Promise<{ id: string; claimedUntil: Date }[]> {
      const nowIso = now.toISOString();
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE ${pluginDeliveries} SET claimed_until = ${claimedUntil.toISOString()}::timestamptz
        WHERE id IN (
          SELECT d.id FROM ${pluginDeliveries} d
          JOIN ${plugins} p ON p.id = d.plugin_id
          WHERE d.status = 'pending'
            AND d.next_attempt_at <= ${nowIso}::timestamptz
            AND (d.claimed_until IS NULL OR d.claimed_until <= ${nowIso}::timestamptz)
            AND p.status = 'active'
          ORDER BY d.next_attempt_at, d.created_at
          LIMIT ${limit}
          FOR UPDATE OF d SKIP LOCKED
        )
        RETURNING id`);
      return rows.map((r) => ({ id: r.id, claimedUntil }));
    },

    // The claimed deliveries with what sending them needs: the plugin (its
    // status, address, manifest, secret and group) and the event.
    async loadClaimed(ids: string[]): Promise<ClaimedDelivery[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          id: pluginDeliveries.id,
          claimedUntil: pluginDeliveries.claimedUntil,
          attempts: pluginDeliveries.attempts,
          pluginId: plugins.id,
          pluginKey: plugins.key,
          pluginStatus: plugins.status,
          baseUrl: plugins.baseUrl,
          manifest: plugins.manifest,
          webhookSecret: plugins.webhookSecret,
          groupPermissions: permissionGroups.permissions,
          eventId: pluginEvents.id,
          eventType: pluginEvents.type,
          entityId: pluginEvents.entityId,
          entityNumber: pluginEvents.entityNumber,
          data: pluginEvents.data,
          occurredAt: pluginEvents.occurredAt,
        })
        .from(pluginDeliveries)
        .innerJoin(plugins, eq(plugins.id, pluginDeliveries.pluginId))
        .innerJoin(permissionGroups, eq(permissionGroups.id, plugins.permissionGroupId))
        .innerJoin(pluginEvents, eq(pluginEvents.id, pluginDeliveries.eventId))
        .where(inArray(pluginDeliveries.id, ids));
      return rows.map((r) => ({ ...r, claimedUntil: r.claimedUntil!, manifest: r.manifest as PluginManifest }));
    },

    // The outcome of one attempt, owner-checked on the claim (millisecond
    // precision — the claim was written from a JS Date): a run whose claim
    // expired and was taken over writes nothing.
    async recordAttempt(
      id: string,
      claimedUntil: Date,
      outcome:
        | { status: "delivered"; at: Date; statusCode: number }
        | { status: "pending"; at: Date; nextAttemptAt: Date; statusCode: number | null; error: string }
        | { status: "failed"; at: Date; statusCode: number | null; error: string; countsAsAttempt: boolean }
    ): Promise<boolean> {
      const counts = outcome.status !== "failed" || outcome.countsAsAttempt;
      const rows = await db
        .update(pluginDeliveries)
        .set({
          status: outcome.status,
          attempts: counts ? sql`${pluginDeliveries.attempts} + 1` : undefined,
          claimedUntil: null,
          lastAttemptAt: outcome.at,
          lastStatusCode: outcome.statusCode,
          lastError: outcome.status === "delivered" ? null : outcome.error.slice(0, 200),
          deliveredAt: outcome.status === "delivered" ? outcome.at : null,
          nextAttemptAt: outcome.status === "pending" ? outcome.nextAttemptAt : null,
        })
        .where(
          and(
            eq(pluginDeliveries.id, id),
            eq(pluginDeliveries.status, "pending"),
            sql`date_trunc('milliseconds', ${pluginDeliveries.claimedUntil}) = ${claimedUntil.toISOString()}::timestamptz`
          )
        )
        .returning({ id: pluginDeliveries.id });
      return rows.length > 0;
    },

    // Rensning: delivered events older than the retention go (deliveries
    // cascade) — an event is kept while any of its deliveries is pending or
    // failed. Deliveries of other kinds stay for Leveranser.
    async cleanup(before: Date): Promise<number> {
      const rows = await db
        .delete(pluginEvents)
        .where(
          and(
            lt(pluginEvents.occurredAt, before),
            notExists(
              db
                .select({ one: sql`1` })
                .from(pluginDeliveries)
                .where(and(eq(pluginDeliveries.eventId, pluginEvents.id), or(eq(pluginDeliveries.status, "pending"), eq(pluginDeliveries.status, "failed"))))
            )
          )
        )
        .returning({ id: pluginEvents.id });
      return rows.length;
    },
  };
}

export type PluginsRepository = ReturnType<typeof createPluginsRepository>;

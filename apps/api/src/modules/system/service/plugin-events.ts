import { eq, sql } from "drizzle-orm";
import { permissionGroups, pluginDeliveries, pluginEvents as pluginEventsTable, plugins, type Db, type Tx } from "@navet/db";
import { effectivePermissions, pluginEventDef, type PluginEventType } from "@navet/shared";
import { isForeignKeyViolation, isSerializationFailure } from "./db-errors.js";

// Tillägg — the outbox writer. emit() is Tx-composable like
// resolveStockLocation: a service calls it INSIDE the transaction that makes
// the change (so an event is never sent for something that was rolled back,
// and never lost for something that happened), or right after when the
// change has no transaction of its own. It writes one plugin_events row and
// one plugin_deliveries row per plugin subscribing to the type whose group
// gives the event's permission — paused plugins included (their deliveries
// wait and go out at Aktivera; claimDue holds them back) — and nothing at
// all when no plugin subscribes: the set of subscribed types is cached (and
// reloaded when plugins change), so Nav without plugins does no extra writes
// and, while the cache is warm, no extra reads.
//
// emit never fails the business transaction for a plugin reason: the
// subscribers are locked FOR KEY SHARE (an uninstall's DELETE, which locks
// the plugin row FOR UPDATE, either waits for the business transaction or
// has committed and the row is skipped), and the whole write runs in a
// savepoint, so a subscriber that vanished anyway — a repeatable-read
// snapshot that still sees an uninstalled plugin (40001 on the lock), or
// the delivery's FK on plugin_id (23503) — only drops that subscriber.

export interface PluginEventInput {
  type: PluginEventType;
  entityId: string;
  // The number people know the post by (KO-1043, the article number).
  entityNumber: string | null;
  // References only (e.g. deliveryId) — never amounts or personal data.
  data?: Record<string, string | null>;
}

// A reload now and then also picks up a change made by another process.
const SUBSCRIPTION_CACHE_MS = 60_000;
// The dispatcher is nudged this long after an emit, so the transaction the
// emit ran in has (almost always) committed; a row that isn't visible yet is
// picked up by the next 15-second run.
const KICK_DELAY_MS = 1_000;
const PLUGIN_FK = "plugin_deliveries_plugin_id_plugins_id_fk";

let cache: { types: Set<string>; loadedAt: number } | null = null;
// Bumped by every invalidate(): a load that started before an invalidate
// answers its caller but never stores its (possibly stale) set.
let generation = 0;
let kickHandler: (() => void) | null = null;
let kickTimer: NodeJS.Timeout | null = null;

async function subscribedTypes(dbc: Db | Tx): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < SUBSCRIPTION_CACHE_MS) return cache.types;
  const startedAt = generation;
  // Every status: a paused plugin's deliveries wait for Aktivera.
  const rows = await dbc.select({ events: sql<unknown>`${plugins.manifest} -> 'webhook' -> 'events'` }).from(plugins);
  const types = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row.events)) for (const type of row.events) if (typeof type === "string") types.add(type);
  }
  if (generation === startedAt) cache = { types, loadedAt: now };
  return types;
}

// The plugins subscribing to `type` with their group's permissions.
function candidates(dbc: Db | Tx, type: PluginEventType) {
  return dbc
    .select({ id: plugins.id, permissions: permissionGroups.permissions })
    .from(plugins)
    .innerJoin(permissionGroups, eq(permissionGroups.id, plugins.permissionGroupId))
    .where(sql`${plugins.manifest} -> 'webhook' -> 'events' @> ${JSON.stringify([type])}::jsonb`);
}

type Subscriber = { id: string; permissions: string[] };

// One lock for all subscribers — the normal path.
async function lockAll(sp: Tx, type: PluginEventType): Promise<Subscriber[]> {
  return candidates(sp, type).for("key share", { of: plugins });
}

// The fallback when lockAll hit a subscriber deleted after a repeatable-read
// snapshot: lock them one by one, each in its own savepoint, skipping the
// ones that are gone.
async function lockEach(sp: Tx, type: PluginEventType): Promise<Subscriber[]> {
  const locked: Subscriber[] = [];
  for (const candidate of await candidates(sp, type)) {
    try {
      await sp.transaction((inner) => inner.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, candidate.id)).for("key share"));
      locked.push(candidate);
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
    }
  }
  return locked;
}

// A plugin row that vanished under the emit (see the header).
const pluginGone = (err: unknown) => isSerializationFailure(err) || isForeignKeyViolation(err, PLUGIN_FK);

function scheduleKick() {
  if (!kickHandler || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    kickHandler?.();
  }, KICK_DELAY_MS);
  kickTimer.unref();
}

export const pluginEvents = {
  // True when at least one delivery was written.
  async emit(dbc: Db | Tx, input: PluginEventInput): Promise<boolean> {
    if (!(await subscribedTypes(dbc)).has(input.type)) return false;
    const def = pluginEventDef(input.type);
    if (!def) return false;
    // In a savepoint (a transaction of its own when dbc is the pool).
    const write = (lock: (sp: Tx, type: PluginEventType) => Promise<Subscriber[]>) =>
      dbc.transaction(async (sp) => {
        // Only plugins whose group gives the event's permission — the
        // delivery-time check still covers a group changed afterwards.
        const subscribers = (await lock(sp, input.type)).filter((s) =>
          effectivePermissions("user", s.permissions).includes(def.permission)
        );
        if (subscribers.length === 0) return false;
        const [event] = await sp
          .insert(pluginEventsTable)
          .values({
            type: input.type,
            entityId: input.entityId,
            entityNumber: input.entityNumber?.slice(0, 60) ?? null,
            data: input.data ?? null,
          })
          .returning({ id: pluginEventsTable.id });
        await sp.insert(pluginDeliveries).values(subscribers.map((s) => ({ pluginId: s.id, eventId: event!.id })));
        return true;
      });
    let wrote: boolean;
    try {
      wrote = await write(lockAll);
    } catch (err) {
      if (!pluginGone(err)) throw err;
      try {
        wrote = await write(lockEach);
      } catch (retryErr) {
        if (!pluginGone(retryErr)) throw retryErr;
        wrote = false;
      }
    }
    if (wrote) scheduleKick();
    return wrote;
  },

  // After every committed change to plugins (install, manifest, status,
  // uninstall) — the next emit reloads the subscribed types.
  invalidate() {
    generation++;
    cache = null;
  },

  // A nudge without an emit (Aktivera, Skicka igen).
  kick() {
    scheduleKick();
  },

  // The dispatcher's nudge. Set only by the real server (server.ts via the
  // dispatcher's enableKick) — never by buildApp, so tests never deliver in
  // the background.
  setKickHandler(handler: (() => void) | null) {
    kickHandler = handler;
    if (!handler && kickTimer) {
      clearTimeout(kickTimer);
      kickTimer = null;
    }
  },
};

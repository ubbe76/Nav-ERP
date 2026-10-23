import { and, eq, sql } from "drizzle-orm";
import { pluginDeliveries, pluginEvents as pluginEventsTable, plugins, type Db, type Tx } from "@navet/db";
import type { PluginEventType } from "@navet/shared";

// Tillägg — the outbox writer. emit() is Tx-composable like
// resolveStockLocation: a service calls it INSIDE the transaction that makes
// the change (so an event is never sent for something that was rolled back,
// and never lost for something that happened), or right after when the
// change has no transaction of its own. It writes one plugin_events row and
// one plugin_deliveries row per active plugin subscribing to the type — and
// nothing at all when no plugin subscribes: the set of subscribed types is
// cached (and reloaded when plugins change), so Nav without plugins does no
// extra writes and, while the cache is warm, no extra reads.

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

let cache: { types: Set<string>; loadedAt: number } | null = null;
let kickHandler: (() => void) | null = null;
let kickTimer: NodeJS.Timeout | null = null;

async function subscribedTypes(dbc: Db | Tx): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < SUBSCRIPTION_CACHE_MS) return cache.types;
  const rows = await dbc
    .select({ events: sql<unknown>`${plugins.manifest} -> 'webhook' -> 'events'` })
    .from(plugins)
    .where(eq(plugins.status, "active"));
  const types = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row.events)) for (const type of row.events) if (typeof type === "string") types.add(type);
  }
  cache = { types, loadedAt: now };
  return types;
}

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
    const subscribers = await dbc
      .select({ id: plugins.id })
      .from(plugins)
      .where(
        and(
          eq(plugins.status, "active"),
          sql`${plugins.manifest} -> 'webhook' -> 'events' @> ${JSON.stringify([input.type])}::jsonb`
        )
      );
    if (subscribers.length === 0) return false;
    const [event] = await dbc
      .insert(pluginEventsTable)
      .values({
        type: input.type,
        entityId: input.entityId,
        entityNumber: input.entityNumber?.slice(0, 60) ?? null,
        data: input.data ?? null,
      })
      .returning({ id: pluginEventsTable.id });
    await dbc.insert(pluginDeliveries).values(subscribers.map((s) => ({ pluginId: s.id, eventId: event!.id })));
    scheduleKick();
    return true;
  },

  // After every committed change to plugins (install, manifest, status,
  // uninstall) — the next emit reloads the subscribed types.
  invalidate() {
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

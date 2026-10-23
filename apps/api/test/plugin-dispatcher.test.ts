import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, permissionGroups, pluginDeliveries, pluginEvents as pluginEventsTable, plugins, users } from "@navet/db";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createPluginsRepository } from "../src/modules/system/repository/plugins.repository.js";
import { createPluginDispatcher, type WebhookFetch } from "../src/modules/system/service/plugin-dispatcher.js";
import { pluginEvents } from "../src/modules/system/service/plugin-events.js";
import { MISSING_PERMISSION_ERROR, verifyWebhookSignature } from "../src/modules/system/service/plugin-webhook.js";
import { insertTestPlugin } from "./helpers/plugins.js";

// Tillägg — the outbox (emit) and the dispatcher, with an injected fake
// fetch and clock: the signature, 2xx, the retry schedule, failed after 7,
// a missing permission, a paused plugin, two runs at once, and that an emit
// lives and dies with its transaction.

const TRUNCATE = sql`TRUNCATE plugin_deliveries, plugin_events, plugins, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'plg-%'`;
const repo = createPluginsRepository(db);
const ENTITY = "33333333-3333-4333-8333-333333333333";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// A fake fetch answering `status` (or throwing) and remembering every call.
function fakeFetch(answer: (n: number) => number | Error = () => 200) {
  const sent: Sent[] = [];
  const fn: WebhookFetch = async (url, init) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const result = answer(sent.length);
    if (result instanceof Error) throw result;
    return new Response(null, { status: result });
  };
  return { fn, sent };
}

// Starts at the real "now": the emits stamp next_attempt_at with the database's
// clock (a second ahead, so a slightly fast database clock never leaves the
// last emit not yet due), and the cleanup measures age against this one.
function clock(start = new Date(Date.now() + 1000)) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function deliveriesOf(pluginId: string) {
  return db.select().from(pluginDeliveries).where(eq(pluginDeliveries.pluginId, pluginId));
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  pluginEvents.invalidate();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

describe("emit", () => {
  it("writes nothing when no plugin subscribes — not even an event row", async () => {
    await insertTestPlugin({ key: "annat", events: ["customer.created"], permissions: ["forsaljning"] });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" })).toBe(false);
    expect(await db.select().from(pluginEventsTable)).toEqual([]);
  });

  it("writes one event and one delivery per subscribing plugin — paused ones too — whose group gives the event", async () => {
    const a = await insertTestPlugin({ key: "plugin-a", events: ["article.created"], permissions: ["artiklar"] });
    const b = await insertTestPlugin({ key: "plugin-b", events: ["article.created", "article.updated"], permissions: ["artiklar"] });
    const paused = await insertTestPlugin({ key: "plugin-c", events: ["article.created"], permissions: ["artiklar"], status: "paused" });
    await insertTestPlugin({ key: "plugin-d", events: ["article.updated"], permissions: ["artiklar"] });
    // Subscribes, but its group doesn't give artiklar: never a delivery.
    const unpermitted = await insertTestPlugin({ key: "plugin-e", events: ["article.created"], permissions: ["lager"] });

    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" })).toBe(true);
    const events = await db.select().from(pluginEventsTable);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    const all = await db.select().from(pluginDeliveries);
    expect(all.map((d) => d.pluginId).sort()).toEqual([a.id, b.id, paused.id].sort());
    expect(all.every((d) => d.status === "pending" && d.attempts === 0)).toBe(true);
    expect(await deliveriesOf(unpermitted.id)).toEqual([]);
  });

  it("writes nothing when the only subscriber's group doesn't give the event's permission", async () => {
    await insertTestPlugin({ key: "utan-grupp", events: ["article.created"], permissions: ["lager"] });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" })).toBe(false);
    expect(await db.select().from(pluginEventsTable)).toEqual([]);
  });

  it("lives and dies with the caller's transaction", async () => {
    await insertTestPlugin({ key: "rollback", events: ["article.created"], permissions: ["artiklar"] });
    await expect(
      db.transaction(async (tx) => {
        await pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
        throw new Error("the change failed");
      })
    ).rejects.toThrow("the change failed");
    expect(await db.select().from(pluginEventsTable)).toEqual([]);
    expect(await db.select().from(pluginDeliveries)).toEqual([]);

    await db.transaction((tx) => pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" }));
    expect(await db.select().from(pluginEventsTable)).toHaveLength(1);
  });

  it("never stores a subscription set whose load started before an invalidate", async () => {
    // Loaded inside a repeatable-read snapshot taken before the install …
    let release!: () => void;
    let snapshotTaken!: () => void;
    const installed = new Promise<void>((resolve) => (release = resolve));
    const snapshot = new Promise<void>((resolve) => (snapshotTaken = resolve));
    const business = db.transaction(
      async (tx) => {
        await tx.execute(sql`select 1`);
        snapshotTaken();
        await installed;
        // … the load starts (generation taken synchronously), and the
        // install's invalidate lands while it is in flight.
        const emitted = pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1" });
        pluginEvents.invalidate();
        return emitted;
      },
      { isolationLevel: "repeatable read" }
    );
    await snapshot;
    const plugin = await insertTestPlugin({ key: "sen", events: ["article.created"], permissions: ["artiklar"] });
    release();
    // The snapshot didn't see the plugin …
    expect(await business).toBe(false);
    // … and its stale set wasn't cached: the next emit sees the plugin.
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1" })).toBe(true);
    expect(await deliveriesOf(plugin.id)).toHaveLength(1);
  });

  it("sees a plugin installed after the cache was loaded once the cache is invalidated", async () => {
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1" })).toBe(false);
    // insertTestPlugin invalidates, like the service after every plugin write.
    await insertTestPlugin({ key: "late", events: ["article.created"], permissions: ["artiklar"] });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1" })).toBe(true);
  });
});

describe("the dispatcher", () => {
  it("posts the signed body to <baseUrl><path> and marks a 2xx delivered", async () => {
    const plugin = await insertTestPlugin({ key: "signerat", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001", data: { ref: "x" } });
    const fetch = fakeFetch(() => 204);
    const time = clock();
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: time.now });

    expect(await dispatcher.run()).toEqual({ attempted: 1 });
    expect(fetch.sent).toHaveLength(1);
    const [sent] = fetch.sent;
    expect(sent!.url).toBe(`${plugin.baseUrl}/nav/webhook`);
    expect(sent!.headers["Content-Type"]).toBe("application/json");
    expect(sent!.headers["Nav-Event-Type"]).toBe("article.created");
    const body = JSON.parse(sent!.body);
    expect(sent!.headers["Nav-Event-Id"]).toBe(body.id);
    expect(body).toMatchObject({ type: "article.created", plugin: "signerat", data: { id: ENTITY, number: "1001", ref: "x" } });
    expect(verifyWebhookSignature(plugin.secret, sent!.body, sent!.headers["Nav-Signature"]!, time.now())).toBe(true);

    const [delivery] = await deliveriesOf(plugin.id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 1, lastStatusCode: 204, lastError: null, claimedUntil: null });
    expect(delivery!.deliveredAt?.toISOString()).toBe(time.now().toISOString());
    // Nothing left to do.
    expect(await dispatcher.run()).toEqual({ attempted: 0 });
    expect(fetch.sent).toHaveLength(1);
  });

  it("retries after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and fails after the 7th attempt", async () => {
    const plugin = await insertTestPlugin({ key: "trasigt", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    const fetch = fakeFetch(() => 500);
    const time = clock();
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: time.now });

    const waits = [1, 5, 30, 120, 360, 720];
    for (const [index, minutes] of waits.entries()) {
      await dispatcher.run();
      const [delivery] = await deliveriesOf(plugin.id);
      expect(delivery).toMatchObject({ status: "pending", attempts: index + 1, lastStatusCode: 500, lastError: "Svarade 500" });
      expect(delivery!.nextAttemptAt!.getTime() - time.now().getTime()).toBe(minutes * 60_000);
      // Not due a second before the wait is over.
      time.advance(minutes * 60_000 - 1000);
      expect(await dispatcher.run()).toEqual({ attempted: 0 });
      time.advance(1000);
    }
    await dispatcher.run();
    const [delivery] = await deliveriesOf(plugin.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 7, nextAttemptAt: null });
    expect(fetch.sent).toHaveLength(7);
    time.advance(24 * 3_600_000);
    expect(await dispatcher.run()).toEqual({ attempted: 0 });
  });

  it("counts a timeout, a network error and a redirect as failures without passing their text on", async () => {
    const plugin = await insertTestPlugin({ key: "fel", events: ["article.created"], permissions: ["artiklar"] });
    for (let i = 0; i < 3; i++) await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: String(i) });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const network = new TypeError("fetch failed: connect ECONNREFUSED 10.1.2.3:8080");
    const fetch = fakeFetch((n) => (n === 1 ? timeout : n === 2 ? network : 302));
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: clock().now });
    await dispatcher.run();
    const errors = (await deliveriesOf(plugin.id)).map((d) => d.lastError).sort();
    expect(errors).toEqual(["Kunde inte ansluta till tillägget", "Omdirigering (302) följs inte", "Tidsgränsen (10 s) överskreds"]);
  });

  it("does not send an event the plugin's group no longer gives — failed with 'Saknar rättighet'", async () => {
    const plugin = await insertTestPlugin({ key: "utan-ratt", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    // The group changed after the event: checked at delivery.
    await db.update(permissionGroups).set({ permissions: ["lager"] }).where(eq(permissionGroups.id, plugin.groupId));
    const fetch = fakeFetch();
    await createPluginDispatcher({ repo, fetch: fetch.fn, now: clock().now }).run();
    expect(fetch.sent).toEqual([]);
    const [delivery] = await deliveriesOf(plugin.id);
    expect(delivery).toMatchObject({ status: "failed", lastError: MISSING_PERMISSION_ERROR, attempts: 0 });
  });

  it("lets a paused plugin's deliveries wait and sends them after Aktivera", async () => {
    const plugin = await insertTestPlugin({ key: "pausat", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    await db.update(plugins).set({ status: "paused" }).where(eq(plugins.id, plugin.id));
    const fetch = fakeFetch();
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: clock().now });
    expect(await dispatcher.run()).toEqual({ attempted: 0 });
    expect((await deliveriesOf(plugin.id))[0]).toMatchObject({ status: "pending", attempts: 0 });

    await db.update(plugins).set({ status: "active" }).where(eq(plugins.id, plugin.id));
    expect(await dispatcher.run()).toEqual({ attempted: 1 });
    expect((await deliveriesOf(plugin.id))[0]!.status).toBe("delivered");
  });

  it("writes the deliveries of an event that happens WHILE paused and sends them after Aktivera", async () => {
    const plugin = await insertTestPlugin({ key: "pausat-nu", events: ["article.created"], permissions: ["artiklar"], status: "paused" });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1002" })).toBe(true);
    const fetch = fakeFetch();
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: clock().now });
    expect(await dispatcher.run()).toEqual({ attempted: 0 });
    expect((await deliveriesOf(plugin.id))[0]).toMatchObject({ status: "pending", attempts: 0 });

    await db.update(plugins).set({ status: "active" }).where(eq(plugins.id, plugin.id));
    expect(await dispatcher.run()).toEqual({ attempted: 1 });
    expect(JSON.parse(fetch.sent[0]!.body).data.number).toBe("1002");
    expect((await deliveriesOf(plugin.id))[0]!.status).toBe("delivered");
  });

  it("delivers each event once when two runs (two processes) go at the same time", async () => {
    const plugin = await insertTestPlugin({ key: "samtidigt", events: ["article.created"], permissions: ["artiklar"] });
    for (let i = 0; i < 12; i++) await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: String(i) });
    const fetch = fakeFetch();
    const time = clock();
    const one = createPluginDispatcher({ repo, fetch: fetch.fn, now: time.now });
    const two = createPluginDispatcher({ repo, fetch: fetch.fn, now: time.now });
    const [a, b] = await Promise.all([one.run(), two.run()]);
    expect(a.attempted + b.attempted).toBe(12);
    const numbers = fetch.sent.map((s) => JSON.parse(s.body).data.number).sort();
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => String(i)).sort());
    expect((await deliveriesOf(plugin.id)).every((d) => d.status === "delivered")).toBe(true);
  });

  it("writes nothing when its claim was taken over by another run", async () => {
    const plugin = await insertTestPlugin({ key: "overtagen", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    const time = clock();
    const [claim] = await repo.claimDue(time.now(), new Date(time.now().getTime() + 60_000), 5);
    // Another run re-claimed the row after the first claim expired.
    await db.update(pluginDeliveries).set({ claimedUntil: new Date(time.now().getTime() + 120_000) }).where(eq(pluginDeliveries.id, claim!.id));
    const written = await repo.recordAttempt(claim!.id, claim!.claimedUntil, { status: "delivered", at: time.now(), statusCode: 200 });
    expect(written).toBe(false);
    expect((await deliveriesOf(plugin.id))[0]!.status).toBe("pending");
  });

  it("cleans up delivered events and failed deliveries older than 30 days, keeping pending and recently failed ones", async () => {
    const plugin = await insertTestPlugin({ key: "rensning", events: ["article.created"], permissions: ["artiklar"] });
    for (let i = 0; i < 5; i++) await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: String(i) });
    const rows = await deliveriesOf(plugin.id);
    const old = new Date(Date.now() - 31 * 86_400_000);
    const recent = new Date(Date.now() - 2 * 86_400_000);
    await db.update(pluginEventsTable).set({ occurredAt: old });
    await db.update(pluginDeliveries).set({ status: "delivered", deliveredAt: old }).where(eq(pluginDeliveries.id, rows[0]!.id));
    // Failed long ago (a real failure and a refusal): both go, with their events.
    await db.update(pluginDeliveries).set({ status: "failed", lastAttemptAt: old, lastError: "Svarade 500" }).where(eq(pluginDeliveries.id, rows[1]!.id));
    await db
      .update(pluginDeliveries)
      .set({ status: "failed", lastAttemptAt: old, lastError: MISSING_PERMISSION_ERROR })
      .where(eq(pluginDeliveries.id, rows[2]!.id));
    // Failed lately (Skicka igen is still possible): stays.
    await db.update(pluginDeliveries).set({ status: "failed", lastAttemptAt: recent }).where(eq(pluginDeliveries.id, rows[3]!.id));
    expect(await repo.cleanup(new Date(Date.now() - 30 * 86_400_000))).toBe(3);
    expect((await deliveriesOf(plugin.id)).map((d) => d.id).sort()).toEqual([rows[3]!.id, rows[4]!.id].sort());
    expect(await db.select().from(pluginEventsTable)).toHaveLength(2);
  });
});

describe("the alert Tillägg som inte tar emot händelser", () => {
  const alerts = createAlertsRepository(db);
  const since = () => new Date(Date.now() - 7 * 86_400_000);

  it("is raised by a delivery that failed for good, but not by a refusal or a failed Skicka testhändelse", async () => {
    const refused = await insertTestPlugin({ key: "nekad", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
    // The group no longer gives artiklar: refused at delivery.
    await db.update(permissionGroups).set({ permissions: ["lager"] }).where(eq(permissionGroups.id, refused.groupId));
    const tested = await insertTestPlugin({ key: "testad", events: [], permissions: [] });
    await repo.createTestDelivery(tested, new Date(Date.now() + 60_000));
    const fetch = fakeFetch(() => 500);
    const dispatcher = createPluginDispatcher({ repo, fetch: fetch.fn, now: clock().now });
    await dispatcher.run();
    const [testDelivery] = await deliveriesOf(tested.id);
    await dispatcher.deliverNow(testDelivery!.id);
    expect((await deliveriesOf(refused.id))[0]).toMatchObject({ status: "failed", lastError: MISSING_PERMISSION_ERROR });
    expect((await deliveriesOf(tested.id))[0]).toMatchObject({ status: "failed", lastError: "Svarade 500" });
    expect(await alerts.failedPluginDeliveries(since())).toEqual([]);

    // A real failure raises it.
    const broken = await insertTestPlugin({ key: "trasig", events: ["article.created"], permissions: ["artiklar"] });
    await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "1002" });
    await db.update(pluginDeliveries).set({ attempts: 6 }).where(eq(pluginDeliveries.pluginId, broken.id));
    await dispatcher.run();
    expect((await deliveriesOf(broken.id))[0]).toMatchObject({ status: "failed", attempts: 7 });
    expect((await alerts.failedPluginDeliveries(since())).map((r) => r.pluginId)).toEqual([broken.id]);
  });
});

// Two connections: an uninstall racing a business transaction's emit never
// makes the business transaction fail.
describe("emit racing Avinstallera", () => {
  // Polls until some backend waits for a lock (the other connection blocked).
  async function waitForLockWait() {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("no connection ever waited for a lock");
  }

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  it("waits for an uninstall in progress and then sends nothing to the removed plugin", async () => {
    const plugin = await insertTestPlugin({ key: "pa-vag-bort", events: ["article.created"], permissions: ["artiklar"] });
    // Warm the cache so the business transaction goes straight to the lock.
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "0" })).toBe(true);
    await db.execute(sql`TRUNCATE plugin_deliveries, plugin_events`);
    const deleted = gate();
    const commit = gate();
    const uninstall = db.transaction(async (tx) => {
      await tx.select().from(plugins).where(eq(plugins.id, plugin.id)).for("update");
      await tx.delete(plugins).where(eq(plugins.id, plugin.id));
      deleted.open();
      await commit.opened;
    });
    await deleted.opened;
    const business = db.transaction(async (tx) => {
      const emitted = await pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
      await tx.execute(sql`select 1`);
      return emitted;
    });
    await waitForLockWait();
    commit.open();
    await uninstall;
    expect(await business).toBe(false);
    expect(await db.select().from(pluginEventsTable)).toEqual([]);
  });

  it("makes an uninstall wait for the business transaction that sent to the plugin (no FK failure)", async () => {
    const plugin = await insertTestPlugin({ key: "forst", events: ["article.created"], permissions: ["artiklar"] });
    const emitted = gate();
    const commit = gate();
    const business = db.transaction(async (tx) => {
      expect(await pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" })).toBe(true);
      emitted.open();
      await commit.opened;
      return "committed";
    });
    await emitted.opened;
    const uninstall = repo.uninstall(plugin.id);
    await waitForLockWait();
    commit.open();
    expect(await business).toBe("committed");
    expect((await uninstall)?.id).toBe(plugin.id);
    expect(await db.select().from(plugins)).toEqual([]);
    expect(await db.select().from(pluginDeliveries)).toEqual([]);
  });

  it("skips a plugin uninstalled after a repeatable-read snapshot — the business transaction commits, the others still get theirs", async () => {
    const gone = await insertTestPlugin({ key: "borta", events: ["article.created"], permissions: ["artiklar"] });
    const kept = await insertTestPlugin({ key: "kvar", events: ["article.created"], permissions: ["artiklar"] });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "0" })).toBe(true);
    await db.execute(sql`TRUNCATE plugin_deliveries, plugin_events`);
    const snapshot = gate();
    const uninstalled = gate();
    const business = db.transaction(
      async (tx) => {
        await tx.select({ id: plugins.id }).from(plugins);
        snapshot.open();
        await uninstalled.opened;
        const emitted = await pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
        await tx.execute(sql`select 1`);
        return emitted;
      },
      { isolationLevel: "repeatable read" }
    );
    await snapshot.opened;
    // The real uninstall, committed while the snapshot still sees the plugin.
    expect((await repo.uninstall(gone.id))?.id).toBe(gone.id);
    uninstalled.open();
    expect(await business).toBe(true);
    expect((await db.select().from(pluginDeliveries)).map((d) => d.pluginId)).toEqual([kept.id]);
  });

  it("drops the event when the only subscriber was uninstalled after the snapshot", async () => {
    const gone = await insertTestPlugin({ key: "ensam", events: ["article.created"], permissions: ["artiklar"] });
    expect(await pluginEvents.emit(db, { type: "article.created", entityId: ENTITY, entityNumber: "0" })).toBe(true);
    await db.execute(sql`TRUNCATE plugin_deliveries, plugin_events`);
    const snapshot = gate();
    const uninstalled = gate();
    const business = db.transaction(
      async (tx) => {
        await tx.select({ id: plugins.id }).from(plugins);
        snapshot.open();
        await uninstalled.opened;
        const emitted = await pluginEvents.emit(tx, { type: "article.created", entityId: ENTITY, entityNumber: "1001" });
        await tx.execute(sql`select 1`);
        return emitted;
      },
      { isolationLevel: "repeatable read" }
    );
    await snapshot.opened;
    await repo.uninstall(gone.id);
    uninstalled.open();
    expect(await business).toBe(false);
    expect(await db.select().from(pluginEventsTable)).toEqual([]);
  });
});

describe("the technical user", () => {
  it("can never be an administrator (the CHECK)", async () => {
    await expect(
      db.insert(users).values({ email: "x@tillagg.invalid", passwordHash: "!", name: "X", role: "admin", kind: "plugin" })
    ).rejects.toThrow();
  });
});

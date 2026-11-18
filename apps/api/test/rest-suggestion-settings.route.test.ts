import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { updateSystemSettingsSchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
// The web helper's defaults must equal the API's (no import cycle: pure file).
import { REST_SUGGESTION_DEFAULTS } from "../../web/lib/restSuggestion.js";

// Rest som förslag i antalsfältet — the four keys over HTTP: the defaults
// (today's behaviour), PATCH by an admin, validation, who may read the
// stamp/report slice (the terminal) and what a read-only account may not do.

const KEYS = ["rest_suggest_receipt", "rest_suggest_delivery", "rest_suggest_report", "rest_suggest_stamp"];
const PASSWORD = "correcthorsebattery";
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const CLEAR = sql`DELETE FROM system_settings WHERE key IN ('rest_suggest_receipt', 'rest_suggest_delivery', 'rest_suggest_report', 'rest_suggest_stamp')`;
const TRUNCATE = sql`TRUNCATE audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'REST%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(CLEAR);
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await db.execute(CLEAR);
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await app.close();
});

async function session(role: "user" | "admin", permissions: string[] | null, readOnly = false) {
  const email = `rest-${crypto.randomUUID()}@example.com`;
  let permissionGroupId: string | undefined;
  if (permissions) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `REST${crypto.randomUUID().slice(0, 8)}`, name: "Rest", permissions })
      .returning();
    permissionGroupId = group!.id;
  }
  await authService.createUser({ email, password: PASSWORD, name: "R", role, permissionGroupId, readOnly });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

describe("Rest som förslag i antalsfältet — inställningen", () => {
  it("defaults to on, on, on, off — what the routines did before — and matches the web's defaults", async () => {
    const admin = await session("admin", null);
    const res = await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect([body.restSuggestReceipt, body.restSuggestDelivery, body.restSuggestReport, body.restSuggestStamp]).toEqual([true, true, true, false]);
    expect({
      receipt: body.restSuggestReceipt,
      delivery: body.restSuggestDelivery,
      report: body.restSuggestReport,
      stamp: body.restSuggestStamp,
    }).toEqual(REST_SUGGESTION_DEFAULTS);
  });

  it("is saved per routine by an admin and read back; no key is written for a field left out", async () => {
    const admin = await session("admin", null);
    const patch = (payload: object) => app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload });
    const saved = await patch({ restSuggestReceipt: false, restSuggestStamp: true });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ restSuggestReceipt: false, restSuggestDelivery: true, restSuggestReport: true, restSuggestStamp: true });
    const rows = await db.execute<{ key: string; value: string }>(sql`SELECT key, value FROM system_settings WHERE key LIKE 'rest_suggest_%' ORDER BY key`);
    expect([...rows].map((r) => [r.key, r.value])).toEqual([
      ["rest_suggest_receipt", "false"],
      ["rest_suggest_stamp", "true"],
    ]);
    expect((await patch({ restSuggestDelivery: false, restSuggestReport: false })).json()).toMatchObject({
      restSuggestReceipt: false,
      restSuggestDelivery: false,
      restSuggestReport: false,
      restSuggestStamp: true,
    });
    expect(KEYS).toHaveLength(4);
  });

  it("decodes junk as the default and rejects a non-boolean", async () => {
    const admin = await session("admin", null);
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('rest_suggest_stamp', 'maybe'), ('rest_suggest_receipt', '1')`);
    const body = (await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie: admin } })).json();
    expect([body.restSuggestStamp, body.restSuggestReceipt]).toEqual([false, true]);
    expect(updateSystemSettingsSchema.safeParse({ restSuggestStamp: "yes" }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ restSuggestReport: null }).success).toBe(false);
    const res = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload: { restSuggestStamp: "yes" } });
    expect(res.statusCode).toBe(400);
  });

  it("is writable by admin only; office reads it, the terminal reads its slice", async () => {
    const admin = await session("admin", null);
    await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload: { restSuggestStamp: true, restSuggestReport: false } });

    const office = await session("user", ["inkop"]);
    const terminal = await session("user", ["terminal"]);
    const patch = (cookie: string) => app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie }, payload: { restSuggestStamp: false } });
    expect((await patch(office)).statusCode).toBe(403);
    expect((await patch(terminal)).statusCode).toBe(403);

    const officeRead = await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie: office } });
    expect([officeRead.statusCode, officeRead.json().restSuggestStamp, officeRead.json().restSuggestReport]).toEqual([200, true, false]);

    const slice = await app.inject({ method: "GET", url: "/api/v1/settings/terminal", headers: { cookie: terminal } });
    expect([slice.statusCode, slice.json().restSuggestStamp, slice.json().restSuggestReport]).toEqual([200, true, false]);
    // The slice carries only the stamp and the report flag of this setting.
    expect(Object.keys(slice.json()).filter((k) => k.startsWith("restSuggest")).sort()).toEqual(["restSuggestReport", "restSuggestStamp"]);
  });

  it("is refused to a read-only account, and reading stays open", async () => {
    const readOnlyAdmin = await session("user", ["inkop"], true);
    const res = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: readOnlyAdmin }, payload: { restSuggestStamp: true } });
    expect([res.statusCode, res.json().code]).toEqual([403, "read-only-account"]);
    const read = await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie: readOnlyAdmin } });
    expect([read.statusCode, read.json().restSuggestStamp]).toEqual([200, false]);
  });
});

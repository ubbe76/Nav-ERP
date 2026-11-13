import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import { db, routingOperationAlternatives, routingOperations, workCenters } from "@navet/db";
import {
  createArticleSchema,
  minutesPerUnitToSecondsPerUnit,
  minutesPerUnitToUnitsPerHour,
  RUN_TIME_DECIMALS,
  runTimeInUnit,
  runTimeToMinutes,
  secondsPerUnitToMinutesPerUnit,
  unitsPerHourToMinutesPerUnit,
} from "@navet/shared";
import * as webUnits from "../../web/lib/units.js";
import { formatRunMinutes } from "../../web/lib/format.js";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { convertCycleTime, convertRoutingTimes } from "../src/modules/import/service/routing.js";
import { routingTimeCells } from "../src/modules/import/service/import-export.js";
import { evaluateFormula } from "../src/modules/configurator/service/configurator-formula.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

// Stycktiden (migration 0218): Tid/enhet is stored in minutes per unit with
// 8 decimals instead of 4. With 4, 0,05 s/st was stored as 0,0008 min
// (0,048 s — the calculation and the load 4 % low) and 36 000 st/h showed as
// 35 294 st/h. The st/h shown is the shortest number that converts back to
// the stored minutes, so a typed st/h or sek/st reads back unchanged.

describe("run time conversions", () => {
  it("keeps 8 decimals in minutes", () => {
    expect(RUN_TIME_DECIMALS).toBe(8);
    expect(secondsPerUnitToMinutesPerUnit(0.05)).toBe(0.00083333);
    expect(unitsPerHourToMinutesPerUnit(36_000)).toBe(0.00166667);
    expect(unitsPerHourToMinutesPerUnit(7)).toBe(8.57142857);
    expect(secondsPerUnitToMinutesPerUnit(7)).toBe(0.11666667);
  });

  it("reads a typed st/h back unchanged — every whole number up to 77 000 st/h and common decimals", () => {
    for (let perHour = 1; perHour <= 77_000; perHour++) {
      const minutes = unitsPerHourToMinutesPerUnit(perHour);
      if (minutesPerUnitToUnitsPerHour(minutes) !== perHour) throw new Error(`${perHour} st/h read back as ${minutesPerUnitToUnitsPerHour(minutes)}`);
    }
    for (const perHour of [0.5, 2.25, 7.5, 12.75, 99.99, 1234.56]) {
      expect(minutesPerUnitToUnitsPerHour(unitsPerHourToMinutesPerUnit(perHour))).toBe(perHour);
    }
    // Past ~77 000 st/h several whole numbers share the stored minutes; a
    // round number still reads back.
    expect(minutesPerUnitToUnitsPerHour(unitsPerHourToMinutesPerUnit(100_000))).toBe(100_000);
  });

  it("shows minutes typed as minutes rounded to 2 decimals in st/h, as before", () => {
    expect(minutesPerUnitToUnitsPerHour(13)).toBe(4.62);
    expect(minutesPerUnitToUnitsPerHour(8.5714)).toBe(7);
    expect(minutesPerUnitToUnitsPerHour(0.75)).toBe(80);
  });

  it("reads a typed sek/st back unchanged, also below half a second", () => {
    for (const seconds of [0.01, 0.05, 0.25, 0.5, 1, 7, 45, 59.99, 3600]) {
      expect(minutesPerUnitToSecondsPerUnit(secondsPerUnitToMinutesPerUnit(seconds))).toBe(seconds);
      expect(runTimeInUnit(runTimeToMinutes(seconds, "seconds_per_unit"), "seconds_per_unit")).toBe(seconds);
    }
  });

  it("the web's copy converts the same", () => {
    for (const v of [0.00083333, 0.00166667, 0.11666667, 8.57142857, 13, 0.0006]) {
      expect(webUnits.minutesPerUnitToUnitsPerHour(v)).toBe(minutesPerUnitToUnitsPerHour(v));
      expect(webUnits.minutesPerUnitToSecondsPerUnit(v)).toBe(minutesPerUnitToSecondsPerUnit(v));
    }
    for (const v of [0.05, 7, 36_000, 77_000]) {
      expect(webUnits.unitsPerHourToMinutesPerUnit(v)).toBe(unitsPerHourToMinutesPerUnit(v));
      expect(webUnits.secondsPerUnitToMinutesPerUnit(v)).toBe(secondsPerUnitToMinutesPerUnit(v));
    }
  });

  it("the web shows minutes under one minute with six significant digits", () => {
    expect(formatRunMinutes("0.00083333")).toBe("0,00083333");
    expect(formatRunMinutes("0.11666667")).toBe("0,116667");
    expect(formatRunMinutes("0.50000000")).toBe("0,5");
    expect(formatRunMinutes("12.34560000")).toBe("12,3456");
    expect(formatRunMinutes(0)).toBe("0");
  });

  it("the import keeps 8 decimals and the export writes the typed value back", () => {
    expect(convertRoutingTimes("seconds_per_unit", 0, 0.05).runTimePerUnit).toBe(0.00083333);
    expect(convertRoutingTimes("units_per_hour", 0, 36_000).runTimePerUnit).toBe(0.00166667);
    expect(convertRoutingTimes("minutes_per_unit", 0, 0.123456789).runTimePerUnit).toBe(0.12345679);
    expect(convertRoutingTimes("hours_per_unit", 0, 0.0001).runTimePerUnit).toBe(0.006);
    expect(convertCycleTime("seconds_per_unit", 0.05)).toBe(0.00083333);
    const seconds = routingTimeCells({ setupTime: 0, runTimePerUnit: 0.00083333, cycleTimePerUnit: 0.00083333, timeUnit: "seconds_per_unit" });
    expect(seconds.runTimePerUnit).toBe(0.05);
    expect(seconds.cycleTimePerUnit).toBe(0.05);
    const perHour = routingTimeCells({ setupTime: 0, runTimePerUnit: 0.00166667, cycleTimePerUnit: null, timeUnit: "units_per_hour" });
    expect(perHour.runTimePerUnit).toBe(36_000);
  });

  it("the configurator's run formula keeps 8 decimals, other formulas 4", () => {
    expect(evaluateFormula("3 / 3600", new Map(), RUN_TIME_DECIMALS)).toEqual({ ok: true, value: 0.00083333 });
    expect(evaluateFormula("3 / 3600", new Map())).toEqual({ ok: true, value: 0.0008 });
  });
});

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE mo_operation_resources, mo_operations, mo_material_consumptions, manufacturing_orders, routing_operation_alternatives, routing_operations, work_centers, bom_components, stock_transactions, articles, audit_log, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

describe("run time through the routes", () => {
  it("stores 0,05 s/st and 36 000 st/h exactly on the routing, the alternative and the TO's operations", async () => {
    const product = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: "ST-1", name: "Bricka", type: "manufactured" })
    );
    const press = await post("/work-centers", { code: "310", name: "Press", hourlyRate: 600 });
    const spare = await post("/work-centers", { code: "320", name: "Press 2", hourlyRate: 600 });
    expect(press.statusCode).toBe(201);
    expect(spare.statusCode).toBe(201);

    const seconds = await post(`/articles/${product.id}/routing`, {
      sequenceNo: 10,
      workCenterId: press.json().id,
      setupTime: 0,
      runTimePerUnit: secondsPerUnitToMinutesPerUnit(0.05),
      cycleTimePerUnit: secondsPerUnitToMinutesPerUnit(0.04),
      timeUnit: "seconds_per_unit",
      alternatives: [{ workCenterId: spare.json().id, runTimePerUnit: secondsPerUnitToMinutesPerUnit(0.06) }],
    });
    expect(seconds.statusCode, seconds.body).toBe(201);
    expect(seconds.json().runTimePerUnit).toBe("0.00083333");
    expect(seconds.json().cycleTimePerUnit).toBe("0.00066667");
    expect(seconds.json().alternatives[0].runTimePerUnit).toBe("0.00100000");

    const perHour = await post(`/articles/${product.id}/routing`, {
      sequenceNo: 20,
      workCenterId: press.json().id,
      setupTime: 0,
      runTimePerUnit: unitsPerHourToMinutesPerUnit(36_000),
      timeUnit: "units_per_hour",
    });
    expect(perHour.statusCode).toBe(201);
    expect(perHour.json().runTimePerUnit).toBe("0.00166667");
    expect(minutesPerUnitToUnitsPerHour(Number(perHour.json().runTimePerUnit))).toBe(36_000);

    // The TO's snapshot keeps the 8 decimals, and 36 000 st at 36 000 st/h
    // is an hour (4 decimals planned 61,2 minutes).
    const mo = await post("/manufacturing-orders", { articleId: product.id, quantity: 36_000 });
    expect(mo.statusCode, mo.body).toBe(201);
    const listed = await get(`/manufacturing-orders/${mo.json().id}/operations`);
    expect(listed.statusCode).toBe(200);
    const ops = listed.json() as { sequenceNo: number; runTimePerUnit: string }[];
    expect(ops.map((o) => [o.sequenceNo, o.runTimePerUnit])).toEqual([
      [10, "0.00083333"],
      [20, "0.00166667"],
    ]);
    const minutes = await db.execute<{ run: string }>(
      sql`SELECT round(run_time_per_unit * 36000, 4)::text AS run FROM mo_operations WHERE sequence_no = 20`
    );
    expect(minutes[0]!.run).toBe("60.0001");
  });

  it("refuses a run time larger than the column on the field", async () => {
    const product = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: "ST-2", name: "Bricka", type: "manufactured" })
    );
    const press = await post("/work-centers", { code: "330", name: "Press", hourlyRate: 600 });
    const res = await post(`/articles/${product.id}/routing`, {
      sequenceNo: 10,
      workCenterId: press.json().id,
      setupTime: 0,
      runTimePerUnit: 1_000_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
  });
});

describe("migration 0218 — beredningens st/h- och sek/st-tider räknas om från det inskrivna talet", () => {
  const updates = readFileSync(new URL("../../../packages/db/drizzle/0218_stycktid_precision.sql", import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
    .filter((statement) => statement.startsWith("UPDATE"));
  const migrate = () =>
    db.transaction(async (tx) => {
      for (const statement of updates) await tx.execute(sql.raw(statement));
    });

  it("repairs typed st/h and sek/st, leaves minutes, 0 and minutes merely shown in another unit", async () => {
    expect(updates).toHaveLength(6);
    const article = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: "ST-M", name: "Bricka", type: "manufactured" })
    );
    const [wc, alt] = await db
      .insert(workCenters)
      .values([{ code: "410", name: "Press" }, { code: "420", name: "Press 2" }])
      .returning();
    const op = (sequenceNo: number, timeUnit: "minutes_per_unit" | "units_per_hour" | "seconds_per_unit", run: string, cycle: string | null = null) => ({
      articleId: article.id, sequenceNo, workCenterId: wc!.id, setupTime: "0", runTimePerUnit: run, cycleTimePerUnit: cycle, timeUnit,
    });
    const rows = await db
      .insert(routingOperations)
      .values([
        op(10, "units_per_hour", "8.5714", "0.1667"), // 7 st/h, cykeltid 360 st/h
        op(20, "units_per_hour", "13"), // 13 min/st shown as 4,62 st/h
        op(30, "seconds_per_unit", "0.0008", "0.1167"), // 0,05 s, cykeltid 7 s
        op(40, "minutes_per_unit", "0.0008"), // typed in minutes
        op(50, "units_per_hour", "0"), // no st/h value
        op(60, "seconds_per_unit", "1.5"), // 90 s, already exact
      ])
      .returning();
    const bySeq = new Map(rows.map((r) => [r.sequenceNo, r.id]));
    await db.insert(routingOperationAlternatives).values([
      { routingOperationId: bySeq.get(10)!, workCenterId: alt!.id, rank: 1, runTimePerUnit: "1.7143" }, // 35 st/h
      { routingOperationId: bySeq.get(30)!, workCenterId: alt!.id, rank: 1, runTimePerUnit: null }, // som ordinarie
    ]);

    await migrate();
    const stored = async () => ({
      operations: (
        await db
          .select({ seq: routingOperations.sequenceNo, run: routingOperations.runTimePerUnit, cycle: routingOperations.cycleTimePerUnit })
          .from(routingOperations)
          .where(eq(routingOperations.articleId, article.id))
          .orderBy(asc(routingOperations.sequenceNo))
      ).map((r) => [r.seq, r.run, r.cycle]),
      alternatives: (
        await db
          .select({ op: routingOperationAlternatives.routingOperationId, run: routingOperationAlternatives.runTimePerUnit })
          .from(routingOperationAlternatives)
          .orderBy(asc(routingOperationAlternatives.runTimePerUnit))
      ).map((r) => [r.op === bySeq.get(10) ? 10 : 30, r.run]),
    });
    const after = await stored();
    expect(after.operations).toEqual([
      [10, "8.57142857", "0.16666667"],
      [20, "13.00000000", null],
      [30, "0.00083333", "0.11666667"],
      [40, "0.00080000", null],
      [50, "0.00000000", null],
      [60, "1.50000000", null],
    ]);
    expect(after.alternatives).toEqual([
      [10, "1.71428571"],
      [30, null],
    ]);
    // The shown st/h and sek/st are what was typed, and a second run changes nothing.
    expect(minutesPerUnitToUnitsPerHour(8.57142857)).toBe(7);
    expect(minutesPerUnitToSecondsPerUnit(0.00083333)).toBe(0.05);
    await migrate();
    expect(await stored()).toEqual(after);
  });
});

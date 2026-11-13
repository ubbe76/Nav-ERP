import { createArticleSchema, updateArticleSchema, updateSystemSettingsSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, auditLog, db, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { parseTrackingCell, suggestArticleMapping } from "../src/modules/import/service/articles.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { isTracked, mentionsTracking, resolveTracking } from "../src/modules/stock/service/article-tracking.js";
import {
  ArticleNotBatchTrackableError,
  batchErrorStatus,
  BatchExpiryMismatchError,
  BatchTrackingDisabledError,
  DuplicateBatchNumberError,
  SerialTrackingNotAvailableError,
} from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY, countTrackedArticles, isTrackedArticle, trackingOf } from "../src/modules/stock/service/batch-tracking.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";

// Spårbarhet etapp 2, steg 1 (migration 0214): the article's Spårning is an
// enum (none | batch | serial) instead of the boolean Batchstyrd. The API
// carries `tracking` AND the older alias `batchTracked`; Serienummer exists in
// the data but cannot be chosen yet. Nothing changes for batch — the etapp 1
// suites (stock-batches, stock-batch-inflows/-outflows, …) run unchanged.

const articleService = createArticleService(createArticleRepository(db), createAuditRepository(db));
const imports = createImportService(createImportRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
const setEnabled = (batchTrackingEnabled: boolean) => testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled }));

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
});

let n = 0;
const makeArticle = (patch: Record<string, unknown> = {}) =>
  articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `SP-${++n}-${crypto.randomUUID().slice(0, 8)}`, name: "Plåt", type: "purchased", active: true, ...patch })
  );
const update = (id: string, patch: Record<string, unknown>) => articleService.updateArticle(id, parsed(updateArticleSchema, patch), null);
const stored = async (id: string) => (await db.select().from(articles).where(eq(articles.id, id)))[0]!;
// Straight on the row — Serienummer cannot be chosen through the API yet.
const forceSerial = (id: string) => db.update(articles).set({ tracking: "serial" }).where(eq(articles.id, id));

describe("resolveTracking — the one rule for `tracking` and the alias `batchTracked`", () => {
  it("`tracking` wins when both are sent", () => {
    expect(resolveTracking("none", { tracking: "batch", batchTracked: false })).toBe("batch");
    expect(resolveTracking("batch", { tracking: "none", batchTracked: true })).toBe("none");
    expect(resolveTracking("batch", { tracking: "serial" })).toBe("serial");
  });

  it("batchTracked: true is batch — also from serial", () => {
    expect(resolveTracking("none", { batchTracked: true })).toBe("batch");
    expect(resolveTracking("batch", { batchTracked: true })).toBe("batch");
    expect(resolveTracking("serial", { batchTracked: true })).toBe("batch");
  });

  it("batchTracked: false switches BATCH off — and never the serial numbers", () => {
    expect(resolveTracking("batch", { batchTracked: false })).toBe("none");
    expect(resolveTracking("none", { batchTracked: false })).toBe("none");
    expect(resolveTracking("serial", { batchTracked: false })).toBe("serial");
  });

  it("nothing sent leaves it; the helpers", () => {
    expect(resolveTracking("serial", {})).toBe("serial");
    expect(mentionsTracking({})).toBe(false);
    expect(mentionsTracking({ batchTracked: false })).toBe(true);
    expect(mentionsTracking({ tracking: "none" })).toBe(true);
    expect([isTracked("none"), isTracked("batch"), isTracked("serial")]).toEqual([false, true, true]);
  });

  it("the new errors have their statuses", () => {
    expect(batchErrorStatus(new SerialTrackingNotAvailableError())).toBe(400);
    expect(batchErrorStatus(new BatchExpiryMismatchError("L-1", "2027-01-01", "2027-02-02"))).toBe(409);
    expect(batchErrorStatus(new DuplicateBatchNumberError("L-1"))).toBe(409);
  });
});

describe("the article's Spårning", () => {
  it("a new article is Ingen; both fields are answered, and each switches batch on and off", async () => {
    await setEnabled(true);
    const plain = await makeArticle();
    expect(plain).toMatchObject({ tracking: "none", batchTracked: false, shelfLifeDays: null, serialAssignedAt: "receipt" });

    const viaAlias = await makeArticle({ batchTracked: true });
    expect(viaAlias).toMatchObject({ tracking: "batch", batchTracked: true });
    const viaEnum = await makeArticle({ tracking: "batch" });
    expect(viaEnum).toMatchObject({ tracking: "batch", batchTracked: true });
    // `tracking` wins over the alias.
    expect(await makeArticle({ tracking: "none", batchTracked: true })).toMatchObject({ tracking: "none", batchTracked: false });

    expect(await update(viaAlias.id, { tracking: "none" })).toMatchObject({ tracking: "none", batchTracked: false });
    expect(await update(viaAlias.id, { batchTracked: true })).toMatchObject({ tracking: "batch", batchTracked: true });
    expect(await update(viaEnum.id, { batchTracked: false })).toMatchObject({ tracking: "none", batchTracked: false });
    // The list carries both too.
    const { rows } = await articleService.listArticles({ limit: 50, offset: 0 } as never);
    expect(rows.find((r) => r.id === viaAlias.id)).toMatchObject({ tracking: "batch", batchTracked: true });
    expect(await countTrackedArticles(db)).toBe(1);
  });

  it("the rules of etapp 1 hold for `tracking`: the setting, tjänst/fantom, a type change", async () => {
    await expect(makeArticle({ tracking: "batch" })).rejects.toThrow(BatchTrackingDisabledError);
    const a = await makeArticle();
    await expect(update(a.id, { tracking: "batch" })).rejects.toThrow(BatchTrackingDisabledError);
    await setEnabled(true);
    await expect(makeArticle({ type: "service", tracking: "batch" })).rejects.toThrow(ArticleNotBatchTrackableError);
    await expect(update(a.id, { type: "service", tracking: "batch" })).rejects.toThrow(ArticleNotBatchTrackableError);
    await update(a.id, { tracking: "batch" });
    // Becoming a tjänst drops it; Ingen is always allowed, also with the setting off.
    expect(await update(a.id, { type: "service" })).toMatchObject({ tracking: "none", batchTracked: false });
    const b = await makeArticle({ tracking: "batch" });
    await db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
    expect(await update(b.id, { tracking: "none" })).toMatchObject({ tracking: "none" });
  });

  it("the change is logged as before", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    await update(a.id, { tracking: "batch" });
    await update(a.id, { tracking: "batch", name: "Samma" });
    await update(a.id, { batchTracked: false });
    const log = await db.select().from(auditLog).where(eq(auditLog.entityId, a.id)).orderBy(auditLog.createdAt);
    expect(log.map((l) => (l.detail as { before: unknown; after: unknown }) && [(l.detail as { before: unknown }).before, (l.detail as { after: unknown }).after])).toEqual([
      [{ batchTracked: false }, { batchTracked: true }],
      [{ batchTracked: true }, { batchTracked: false }],
    ]);
  });

  it("Serienummer cannot be chosen yet — nor Serienummer skapas: Vid utleverans", async () => {
    await setEnabled(true);
    await expect(makeArticle({ tracking: "serial" })).rejects.toThrow(SerialTrackingNotAvailableError);
    await expect(makeArticle({ serialAssignedAt: "delivery" })).rejects.toThrow(SerialTrackingNotAvailableError);
    const a = await makeArticle({ tracking: "batch", serialAssignedAt: "receipt" });
    await expect(update(a.id, { tracking: "serial" })).rejects.toThrow(SerialTrackingNotAvailableError);
    await expect(update(a.id, { serialAssignedAt: "delivery" })).rejects.toThrow(SerialTrackingNotAvailableError);
    expect(await stored(a.id)).toMatchObject({ tracking: "batch", serialAssignedAt: "receipt" });
    expect(createArticleSchema.safeParse({ name: "x", type: "purchased", tracking: "lot" }).success).toBe(false);
  });

  it("an old client's batchTracked: false does not switch a serienummerstyrd article off; true makes it batch", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    await forceSerial(a.id);
    // The alias is false for it, and it counts as spårad.
    expect(await articleService.getArticle(a.id)).toMatchObject({ tracking: "serial", batchTracked: false });
    expect([await isTrackedArticle(db, a.id), await trackingOf(db, a.id)]).toEqual([true, "serial"]);
    expect(await countTrackedArticles(db)).toBe(1);
    // The whole card sent back, as an old client would.
    expect(await update(a.id, { name: "Nytt namn", batchTracked: false })).toMatchObject({ name: "Nytt namn", tracking: "serial", batchTracked: false });
    expect(await update(a.id, { batchTracked: true })).toMatchObject({ tracking: "batch", batchTracked: true });
    await forceSerial(a.id);
    expect(await update(a.id, { tracking: "none" })).toMatchObject({ tracking: "none" });
    // The setting cannot be switched off while a serienummerstyrd article exists.
    await forceSerial(a.id);
    await expect(setEnabled(false)).rejects.toMatchObject({ name: "BatchTrackingInUseError" });
  });

  it("Hållbarhet (dagar): whole days 1–36500, null clears, an empty string is refused", async () => {
    const a = await makeArticle({ shelfLifeDays: "30" });
    expect(a.shelfLifeDays).toBe(30);
    expect((await update(a.id, { shelfLifeDays: 365 }))!.shelfLifeDays).toBe(365);
    expect((await update(a.id, { name: "Annat" }))!.shelfLifeDays).toBe(365);
    expect((await update(a.id, { shelfLifeDays: null }))!.shelfLifeDays).toBeNull();
    for (const bad of [0, -1, 1.5, 36501, ""]) {
      expect(updateArticleSchema.safeParse({ shelfLifeDays: bad }).success, String(bad)).toBe(false);
    }
  });

  it("Kopiera från → Information brings Spårning and Hållbarhet; the request wins; dropped when the copy cannot be spårad", async () => {
    await setEnabled(true);
    const source = await makeArticle({ tracking: "batch", shelfLifeDays: 90 });
    const copyFrom = { articleId: source.id, parts: ["information"] };
    expect(await makeArticle({ copyFrom })).toMatchObject({ tracking: "batch", batchTracked: true, shelfLifeDays: 90 });
    expect(await makeArticle({ copyFrom, batchTracked: false, shelfLifeDays: 10 })).toMatchObject({ tracking: "none", shelfLifeDays: 10 });
    expect(await makeArticle({ copyFrom, type: "service" })).toMatchObject({ tracking: "none", shelfLifeDays: 90 });
    await db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
    expect(await makeArticle({ copyFrom })).toMatchObject({ tracking: "none" });
  });
});

describe("artikelimporten — Spårning and Hållbarhet (dagar)", () => {
  const MAPPING = { Artikelnummer: "articleNumber", Benämning: "name", Artikeltyp: "type", Spårning: "tracking", "Hållbarhet (dagar)": "shelfLifeDays" };
  const commit = (rows: string[][]) => imports.commit("articles", { mapping: MAPPING, rows, defaults: { articleType: "purchased" } });
  const preview = (rows: string[][]) => imports.preview("articles", { mapping: MAPPING, rows, defaults: { articleType: "purchased" } });
  const byNumber = async (articleNumber: string) => (await db.select().from(articles).where(eq(articles.articleNumber, articleNumber)))[0];

  it("both headings map to the field; the cell reads its own words and the old Ja/Nej", () => {
    expect(suggestArticleMapping(["Spårning", "Hållbarhet (dagar)"])).toEqual({ Spårning: "tracking", "Hållbarhet (dagar)": "shelfLifeDays" });
    expect(suggestArticleMapping(["Batchstyrd"])).toEqual({ Batchstyrd: "tracking" });
    expect(parseTrackingCell("Ingen")).toEqual({ tracking: "none" });
    expect(parseTrackingCell(" batch ")).toEqual({ tracking: "batch" });
    expect(parseTrackingCell("Serienummer")).toEqual({ tracking: "serial" });
    expect(parseTrackingCell("Ja")).toEqual({ batchTracked: true });
    expect(parseTrackingCell("0")).toEqual({ batchTracked: false });
    expect(parseTrackingCell("")).toBeUndefined();
    expect(parseTrackingCell("Kanske")).toBeNull();
  });

  it("creates and updates with the words, leaves an empty cell, clears Hållbarhet with 0", async () => {
    await setEnabled(true);
    await commit([
      ["I-1", "Ett", "Köpt", "Batch", "30"],
      ["I-2", "Två", "Köpt", "Ingen", ""],
      ["I-3", "Tre", "Köpt", "", "7"],
    ]);
    expect([await byNumber("I-1"), await byNumber("I-2"), await byNumber("I-3")].map((a) => [a!.tracking, a!.shelfLifeDays])).toEqual([
      ["batch", 30],
      ["none", null],
      ["none", 7],
    ]);
    await commit([
      ["I-1", "Ett", "Köpt", "", ""],
      ["I-2", "Två", "Köpt", "Batch", "14"],
      ["I-3", "Tre", "Köpt", "Ingen", "0"],
    ]);
    expect([await byNumber("I-1"), await byNumber("I-2"), await byNumber("I-3")].map((a) => [a!.tracking, a!.shelfLifeDays])).toEqual([
      ["batch", 30],
      ["batch", 14],
      ["none", null],
    ]);
    // The same file again changes nothing.
    expect((await preview([["I-2", "Två", "Köpt", "Batch", "14"]])).summary).toMatchObject({ error: 0 });
  });

  it("row errors: Serienummer, a bad hållbarhet; the old Nej never switches a serienummerstyrd article off", async () => {
    await setEnabled(true);
    await commit([["I-9", "Nio", "Köpt", "Ingen", ""]]);
    await forceSerial((await byNumber("I-9"))!.id);
    const result = await preview([
      ["I-4", "Fyra", "Köpt", "Serienummer", ""],
      ["I-5", "Fem", "Köpt", "Batch", "1,5"],
      ["I-6", "Sex", "Köpt", "Batch", "40000"],
      ["I-9", "Nio", "Köpt", "Nej", ""],
    ]);
    expect(result.rows.map((r) => r.errors)).toEqual([
      ["Spårning Serienummer går inte att välja ännu — välj Ingen eller Batch"],
      ['Hållbarheten ska vara ett helt antal dagar: "1,5"'],
      ["Hållbarheten är för lång (max 36500 dagar)"],
      [],
    ]);
    await commit([["I-9", "Nio", "Köpt", "Nej", ""]]);
    expect((await byNumber("I-9"))!.tracking).toBe("serial");
  });
});

describe("the routes", () => {
  const PASSWORD = "ett-tillräckligt-långt-lösenord";
  let app: ReturnType<typeof buildApp>;
  let admin: string;
  const asAdmin = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  beforeEach(async () => {
    await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } });
    admin = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  });
  afterAll(async () => {
    await app.close();
  });

  it("POST/PATCH/GET /articles carry tracking, batchTracked, shelfLifeDays and serialAssignedAt; serial is 400 with its code", async () => {
    expect((await asAdmin("PATCH", "/settings", { batchTrackingEnabled: true })).statusCode).toBe(200);
    const created = await asAdmin("POST", "/articles", { articleNumber: "RT-SP-1", name: "Plåt", type: "purchased", tracking: "batch", shelfLifeDays: 30 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ tracking: "batch", batchTracked: true, shelfLifeDays: 30, serialAssignedAt: "receipt" });
    const id = created.json().id as string;

    const off = await asAdmin("PATCH", `/articles/${id}`, { batchTracked: false, shelfLifeDays: null });
    expect(off.json()).toMatchObject({ tracking: "none", batchTracked: false, shelfLifeDays: null });
    expect((await asAdmin("GET", `/articles/${id}`)).json()).toMatchObject({ tracking: "none", batchTracked: false });

    for (const body of [{ tracking: "serial" }, { serialAssignedAt: "delivery" }]) {
      const patch = await asAdmin("PATCH", `/articles/${id}`, body);
      expect([patch.statusCode, patch.json().code]).toEqual([400, "serial-tracking-not-available"]);
      const post = await asAdmin("POST", "/articles", { articleNumber: "RT-SP-2", name: "Plåt", type: "purchased", ...body });
      expect([post.statusCode, post.json().code]).toEqual([400, "serial-tracking-not-available"]);
    }
    const bad = await asAdmin("PATCH", `/articles/${id}`, { shelfLifeDays: "" });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "validation-failed"]);
    expect((await asAdmin("GET", `/articles/${id}`)).json()).toMatchObject({ tracking: "none", serialAssignedAt: "receipt" });
  });
});

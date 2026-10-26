import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, deviations, moOperationScrap, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  ScrapReasonInvalidError,
  ScrapReasonRequiredError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Avvikelseorsaker: the register (Kvalitet writes, the terminal reads, delete
// with reassignment of the cases and the scrap rows), and the scrap reason
// rule — with an active scrap reason one must be chosen (the free text is a
// comment), without the register the free text is the reason as before —
// plus the kassationsrapport's grouping. All data made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const salesRepository = createSalesRepository(db);
const mfg = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const reports = createReportsService(createReportsRepository(db));
const TRUNCATE = sql`TRUNCATE deviations, deviation_reasons, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'AVR%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
// The other suites report scrap with free text: no scrap reason may survive.
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function cookieWith(permissions: string[] | "admin", name: string) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  let userId: string;
  if (permissions === "admin") {
    userId = (await authService.createUser({ email, password: PASSWORD, name, role: "admin" })).id;
  } else {
    const [group] = await db.insert(permissionGroups).values({ code: `AVR${crypto.randomUUID().slice(0, 6)}`, name, permissions }).returning();
    userId = (await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id })).id;
  }
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  const cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  return {
    userId,
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string, payload?: unknown) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie }, payload }),
  };
}

async function releasedOperation(userId: string) {
  const article = await testArticleService.createArticle({
    articleNumber: `KASS-${crypto.randomUUID().slice(0, 8)}`,
    name: "Bänkskiva",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfg.createWorkCenter({ code: String(Math.floor(Math.random() * 900) + 100), name: "Kantpress", active: true });
  await mfg.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 0.5 });
  const order = await mfg.createManufacturingOrder({ articleId: article.id, quantity: 20 }, userId);
  const [operation] = await mfg.listOperations(order.id);
  return { article, order, operation: operation! };
}

describe("registret Avvikelseorsaker", () => {
  it("Kvalitet writes, office and the terminal read, the flags are validated", async () => {
    const quality = await cookieWith(["kvalitet"], "Kvalitet");
    const sales = await cookieWith(["forsaljning"], "Saljare");
    const terminal = await cookieWith(["terminal"], "Verkstad");

    const created = await quality.post("/deviation-reasons", { code: "ytA", name: "Ytskada", appliesCustomer: true, appliesScrap: true });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      code: "YTA",
      name: "Ytskada",
      appliesCustomer: true,
      appliesSupplier: false,
      appliesInternal: false,
      appliesScrap: true,
      active: true,
    });
    expect((await quality.post("/deviation-reasons", { code: "NONE", name: "Ingen flagga" })).statusCode).toBe(400);
    expect((await quality.post("/deviation-reasons", { code: "YTA", name: "Annan", appliesSupplier: true })).statusCode).toBe(409);
    expect((await sales.post("/deviation-reasons", { code: "S", name: "Sälj", appliesCustomer: true })).statusCode).toBe(403);

    expect((await sales.get("/deviation-reasons")).json()).toHaveLength(1);
    // The stamp terminal picks the scrap reason from the same list.
    expect((await terminal.get("/deviation-reasons")).statusCode).toBe(200);
    expect((await terminal.post("/deviation-reasons", { code: "T", name: "T", appliesScrap: true })).statusCode).toBe(403);

    const patched = await quality.patch(`/deviation-reasons/${created.json().id}`, {
      code: "YTA",
      name: "Ytskada (repor)",
      appliesCustomer: true,
      appliesScrap: true,
      active: false,
    });
    expect(patched.json()).toMatchObject({ name: "Ytskada (repor)", active: false });
  });

  it("radering med kopplingsflytt: the cases and the scrap rows move to the replacement", async () => {
    const admin = await cookieWith("admin", "Admin");
    const old = (await admin.post("/deviation-reasons", { code: "MATT", name: "Måttfel", appliesInternal: true, appliesScrap: true })).json();
    const replacement = (await admin.post("/deviation-reasons", { code: "MATT2", name: "Fel mått", appliesInternal: true, appliesScrap: true })).json();
    const c = (await admin.post("/deviations", { type: "internal", title: "Fel mått på skiva", reasonId: old.id })).json();
    const { operation } = await releasedOperation(admin.userId);
    await mfg.reportOperationQuantities(operation.id, { quantityOk: 1, quantityScrapped: 2, scrapReasonId: old.id, markDone: false, createdBy: admin.userId });

    const usage = (await admin.get(`/deviation-reasons/${old.id}/usage`)).json();
    expect(usage).toEqual({
      total: 2,
      references: [
        { table: "deviations", label: "avvikelser", labelOne: "avvikelse", count: 1 },
        { table: "mo_operation_scrap", label: "kassationsrader", labelOne: "kassationsrad", count: 1 },
      ],
    });
    const refused = await admin.delete(`/deviation-reasons/${old.id}`, {});
    expect(refused.statusCode).toBe(409);
    expect((await admin.delete(`/deviation-reasons/${old.id}`, { replacementId: replacement.id })).statusCode).toBe(204);
    expect((await db.select().from(deviations).where(eq(deviations.id, c.id)))[0]!.reasonId).toBe(replacement.id);
    expect((await db.select().from(moOperationScrap))[0]!.reasonId).toBe(replacement.id);
  });

  it("the replacement must be active and apply to what moves; every moved case — closed and cancelled too — gets a history row", async () => {
    const admin = await cookieWith("admin", "Admin");
    const customer = (await admin.post("/customers", { name: "Exempelkrogen AB" })).json();
    const old = (await admin.post("/deviation-reasons", { code: "TRP", name: "Transportskada", appliesCustomer: true, appliesInternal: true })).json();
    const reason = (body: Record<string, unknown>) => admin.post("/deviation-reasons", body).then((r) => r.json());
    const scrapOnly = await reason({ code: "MSK", name: "Maskinfel", appliesScrap: true });
    const internalOnly = await reason({ code: "INT", name: "Hantering", appliesInternal: true });
    const inactive = await reason({ code: "OLD", name: "Gammal", appliesCustomer: true, appliesInternal: true, active: false });
    const good = await reason({ code: "TRP2", name: "Skada i transport", appliesCustomer: true, appliesInternal: true });

    const open = (await admin.post("/deviations", { type: "customer", title: "Repad", customerId: customer.id, reasonId: old.id })).json();
    const closed = (await admin.post("/deviations", { type: "internal", title: "Tappad", reasonId: old.id, correctiveAction: "Ok" })).json();
    expect((await admin.post(`/deviations/${closed.id}/close`, {})).statusCode).toBe(200);
    const cancelled = (await admin.post("/deviations", { type: "internal", title: "Fel", reasonId: old.id })).json();
    expect((await admin.post(`/deviations/${cancelled.id}/cancel`, { reason: "Dubblett" })).statusCode).toBe(200);

    for (const [replacement, text] of [
      [scrapOnly, "gäller inte kundreklamationer och interna avvikelser"],
      [internalOnly, "gäller inte kundreklamationer"],
      [inactive, "är inaktiv"],
    ] as const) {
      const refused = await admin.delete(`/deviation-reasons/${old.id}`, { replacementId: replacement.id });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe("invalid-replacement");
      expect(refused.json().error).toContain(text);
    }
    // Nothing moved, nothing logged.
    expect((await db.select().from(deviations).where(eq(deviations.reasonId, old.id)))).toHaveLength(3);

    expect((await admin.delete(`/deviation-reasons/${old.id}`, { replacementId: good.id })).statusCode).toBe(204);
    for (const c of [open, closed, cancelled]) {
      const card = (await admin.get(`/deviations/${c.id}`)).json();
      expect(card.reasonId).toBe(good.id);
      const updated = card.events.filter((e: { event: string }) => e.event === "updated");
      expect(updated).toEqual([
        expect.objectContaining({
          detail: { changes: { reasonId: { before: old.id, after: good.id } }, via: "register-replace" },
          userName: "Admin",
        }),
      ]);
    }
    expect((await admin.get(`/deviations/${closed.id}`)).json().status).toBe("closed");

    // Scrap rows need a Kassation reason; an unused reason deletes freely.
    const scrapOld = await reason({ code: "SKR", name: "Skrapad", appliesScrap: true });
    const { operation } = await releasedOperation(admin.userId);
    await mfg.reportOperationQuantities(operation.id, { quantityOk: 1, quantityScrapped: 1, scrapReasonId: scrapOld.id, markDone: false, createdBy: admin.userId });
    const noScrap = await admin.delete(`/deviation-reasons/${scrapOld.id}`, { replacementId: good.id });
    expect(noScrap.statusCode).toBe(400);
    expect(noScrap.json().error).toContain("gäller inte kassation");
    expect((await admin.delete(`/deviation-reasons/${scrapOld.id}`, { replacementId: scrapOnly.id })).statusCode).toBe(204);
    expect((await admin.delete(`/deviation-reasons/${internalOnly.id}`, { replacementId: inactive.id })).statusCode).toBe(204);
  });
});

describe("kassationsorsaken", () => {
  it("without any scrap reason the free text is required, as before", async () => {
    const admin = await cookieWith("admin", "Admin");
    // A reason that is not a scrap reason does not switch the rule.
    await admin.post("/deviation-reasons", { code: "TRANSP", name: "Transportskada", appliesCustomer: true });
    const { operation } = await releasedOperation(admin.userId);
    await expect(
      mfg.reportOperationQuantities(operation.id, { quantityOk: 0, quantityScrapped: 1, markDone: false, createdBy: admin.userId })
    ).rejects.toBeInstanceOf(ScrapReasonRequiredError);
    await mfg.reportOperationQuantities(operation.id, { quantityOk: 0, quantityScrapped: 1, scrapReason: "Repa", markDone: false, createdBy: admin.userId });
    const [row] = await db.select().from(moOperationScrap);
    expect(row).toMatchObject({ reasonId: null, reason: "Repa" });
  });

  it("with an active scrap reason one must be chosen; the text is the comment; inactive or non-scrap reasons are refused", async () => {
    const admin = await cookieWith("admin", "Admin");
    const scrap = (await admin.post("/deviation-reasons", { code: "MASKIN", name: "Maskinfel", appliesInternal: true, appliesScrap: true })).json();
    const notScrap = (await admin.post("/deviation-reasons", { code: "TRANSP", name: "Transportskada", appliesCustomer: true })).json();
    const inactive = (await admin.post("/deviation-reasons", { code: "GAMMAL", name: "Gammal", appliesScrap: true, active: false })).json();
    const { order, operation } = await releasedOperation(admin.userId);
    const report = (extra: Record<string, unknown>) =>
      mfg.reportOperationQuantities(operation.id, { quantityOk: 0, quantityScrapped: 1, markDone: false, createdBy: admin.userId, ...extra });

    await expect(report({ scrapReason: "Bara text" })).rejects.toBeInstanceOf(ScrapReasonRequiredError);
    await expect(report({ scrapReasonId: notScrap.id })).rejects.toBeInstanceOf(ScrapReasonInvalidError);
    await expect(report({ scrapReasonId: inactive.id })).rejects.toBeInstanceOf(ScrapReasonInvalidError);
    await expect(report({ scrapReasonId: crypto.randomUUID() })).rejects.toBeInstanceOf(ScrapReasonInvalidError);
    // The terminal's preflight refuses before anything is written.
    await expect(
      mfg.assertMaterialBeforeOperationReport(operation.id, { quantityOk: 0, quantityScrapped: 2, markDone: false, createdBy: admin.userId }, undefined)
    ).rejects.toBeInstanceOf(ScrapReasonRequiredError);
    expect(await db.select().from(moOperationScrap)).toHaveLength(0);

    await report({ scrapReasonId: scrap.id, scrapReason: "Verktyget slitet" });
    await report({ scrapReasonId: scrap.id });
    // OK without scrap needs no reason.
    await report({ quantityOk: 2, quantityScrapped: 0 });

    const list = await mfg.listScrapForOrder(order.id);
    expect(list.map((r) => [r.reasonName, r.reason])).toEqual(
      expect.arrayContaining([
        ["Maskinfel", "Verktyget slitet"],
        ["Maskinfel", null],
      ])
    );

    // The MO card's route answers 400 with the code.
    const route = await admin.post(`/manufacturing-orders/${order.id}/operations/${operation.id}/complete`, {
      quantityCompleted: 0,
      quantityScrapped: 1,
      scrapReason: "Text",
    });
    expect(route.statusCode).toBe(400);
    expect(route.json().code).toBe("scrap-reason-required");
    const noReason = await admin.post(`/manufacturing-orders/${order.id}/operations/${operation.id}/complete`, {
      quantityCompleted: 0,
      quantityScrapped: 1,
    });
    expect(noReason.statusCode).toBe(400);

    // Older free-text rows keep their text; the report groups the register's
    // reason on its id and the text with "(fritext)".
    await db.insert(moOperationScrap).values({ moOperationId: operation.id, quantity: "5", reason: "Spån" });
    const stats = await reports.getScrapStatistics({ groupBy: "reason" });
    expect(stats.rows).toEqual([
      { key: "text:Spån", label: "Spån (fritext)", scrappedQuantity: 5, reportCount: 1 },
      { key: scrap.id, label: "Maskinfel", scrappedQuantity: 2, reportCount: 2 },
    ]);
  });
});

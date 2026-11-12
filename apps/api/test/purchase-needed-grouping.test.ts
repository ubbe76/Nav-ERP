import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articleSuppliers, db, manufacturingOrders, permissionGroups, purchaseOrderRows, purchaseOrders, suppliers } from "@navet/db";
import {
  createArticleSchema,
  createWorkCenterSchema,
  type AlertGroup,
  type AlertItem,
  type AlertOrderProposal,
  type AlertsResponse,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { groupBySupplier } from "../src/modules/alerts/service/alerts.service.js";
import type { RequirementRow } from "../src/modules/planning/service/requirements-calc.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Behöver beställas grouped per supplier, and Skapa inköpsorder from the
// alert = the behovsberäkning's Skapa ordrar (POST /planning/orders) —
// against the real app, so the alert, the cache, the permission gate and the
// read-only guard are the ones the web meets.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
// Setup only (resources, routing, the released TO with a lego operation).
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);

const TRUNCATE = sql`TRUNCATE audit_log, inquiry_rows, inquiries, purchase_receipts, mo_report_materials, mo_reports, purchase_order_rows,
  purchase_orders, article_suppliers, suppliers, mo_operation_plan_weeks, mo_material_consumptions, mo_operation_scrap, mo_operations,
  manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, bom_components, articles,
  user_settings, users CASCADE`;
// Only this file's groups — the seeded ALLA/VERKSTAD belong to other files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'BB%'`;
const PASSWORD = "correcthorsebattery";

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function session(permissions: string[] | null, opts: { role?: "user" | "admin"; readOnly?: boolean } = {}) {
  let permissionGroupId: string | null = null;
  if (permissions) {
    const [g] = await db
      .insert(permissionGroups)
      .values({ code: `BB${crypto.randomUUID().slice(0, 6)}`, name: "T", permissions })
      .returning();
    permissionGroupId = g!.id;
  }
  const email = `bb-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({
    email,
    password: PASSWORD,
    name: "P",
    role: opts.role ?? "user",
    permissionGroupId,
    readOnly: opts.readOnly ?? false,
  });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { user, cookie: `session=${res.cookies.find((c) => c.name === "session")!.value}` };
}

async function makeSupplier(name: string) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L${crypto.randomUUID().slice(0, 8)}`, name })
    .returning();
  return row!;
}

async function makeArticle(articleNumber: string, type: "purchased" | "manufactured", reorderPoint?: number) {
  return testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber, name: `Artikel ${articleNumber}`, type, active: true, ...(reorderPoint ? { reorderPoint } : {}) })
  );
}

async function primary(articleId: string, supplierId: string) {
  await db.insert(articleSuppliers).values({ articleId, supplierId, price: "5", isPrimary: true });
}

// Two suppliers (named so the name order differs from the creation order),
// four bought articles under their beställningspunkt — one without a förvald
// leverantör, one at Alfa, two at Beta —, a released TO whose operation 20
// is bought from Alfa (lego) and a made article under its beställningspunkt.
async function world(adminId: string) {
  const beta = await makeSupplier("Beta Stål AB");
  const alfa = await makeSupplier("Alfa Yta AB");
  const none = await makeArticle("K-10", "purchased", 3);
  const atBeta1 = await makeArticle("K-20", "purchased", 4);
  const atAlfa = await makeArticle("K-30", "purchased", 5);
  const atBeta2 = await makeArticle("K-40", "purchased", 6);
  await primary(atBeta1.id, beta.id);
  await primary(atAlfa.id, alfa.id);
  await primary(atBeta2.id, beta.id);
  const made = await makeArticle("T-10", "manufactured", 7);

  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", type: "machine", active: true }));
  const lego = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling", type: "subcontract", supplierId: alfa.id, active: true })
  );
  const legoArticle = await makeArticle("L-10", "manufactured");
  await mfgService.createRoutingOperation(legoArticle.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(legoArticle.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 500,
    unitPrice: 100,
  });
  const mo = await mfgService.createManufacturingOrder({ articleId: legoArticle.id, quantity: 10 }, adminId);
  const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
  return { beta, alfa, none, atBeta1, atAlfa, atBeta2, made, legoArticle, mo, legoOp };
}

// The behovsberäkning as the page reads it (Uppdatera — the app's cache is
// the real 60 s one).
async function requirementRows(cookie: string): Promise<RequirementRow[]> {
  const res = await app.inject({ method: "GET", url: "/api/v1/planning/requirements?refresh=true&limit=500", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { rows: RequirementRow[] }).rows;
}

async function purchaseNeeded(cookie: string): Promise<AlertGroup> {
  const res = await app.inject({ method: "GET", url: "/api/v1/alerts?kinds=purchase_needed", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as AlertsResponse;
  expect(body.groups.map((g) => g.kind)).toEqual(["purchase_needed"]);
  return body.groups[0]!;
}

// The body the behovsberäkning page builds for Skapa ordrar
// (BehovsberakningPageClient.confirmCreate), from the list's rows.
function pageProposals(rows: RequirementRow[]) {
  return rows
    .filter((r) => r.proposalKind === "purchase" || r.proposalKind === "subcontract")
    .flatMap((r) =>
      r.proposals.map((p) => ({
        articleId: r.articleId,
        quantity: p.quantity,
        kind: r.proposalKind,
        ...(p.needDate ? { needDate: p.needDate } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.key ? { key: p.key } : {}),
        ...(r.proposalKind === "subcontract" && r.moOperationId ? { moOperationId: r.moOperationId } : {}),
      }))
    );
}

const byKey = (a: { key?: string }, b: { key?: string }) => (a.key! < b.key! ? -1 : 1);

const post = (cookie: string, proposals: unknown[]) =>
  app.inject({ method: "POST", url: "/api/v1/planning/orders", headers: { cookie }, payload: { proposals } });

describe("Behöver beställas — grouped per supplier", () => {
  it("groups the rows per supplier: without a förvald leverantör first, then by name, lego with the supplier's purchases", async () => {
    const admin = await session(null, { role: "admin" });
    const w = await world(admin.user.id);
    const rows = await requirementRows(admin.cookie);
    const group = await purchaseNeeded(admin.cookie);

    expect(group.count).toBe(5);
    expect(group.supplierGroups).toEqual([
      { key: "none", supplierId: null, supplierName: null, count: 1, shown: 1 },
      { key: w.alfa.id, supplierId: w.alfa.id, supplierName: "Alfa Yta AB", count: 2, shown: 2 },
      { key: w.beta.id, supplierId: w.beta.id, supplierName: "Beta Stål AB", count: 2, shown: 2 },
    ]);
    // The rows come in the groups' order; inside a group as before (lowest
    // projected balance, then the article number).
    expect(group.items.map((i) => [i.primary.split(" ")[0], i.supplierId, i.supplierName])).toEqual([
      ["K-10", null, null],
      ["K-30", w.alfa.id, "Alfa Yta AB"],
      ["L-10", w.alfa.id, "Alfa Yta AB"],
      ["K-20", w.beta.id, "Beta Stål AB"],
      ["K-40", w.beta.id, "Beta Stål AB"],
    ]);
    // The made article is Behöver tillverkas, never here.
    expect(group.items.some((i) => i.primary.startsWith("T-10"))).toBe(false);

    // The supplier is the proposal's own: what the behovsberäkning's row says.
    for (const item of group.items) {
      const articleId = item.proposals![0]!.articleId;
      const row = rows.find((r) => r.articleId === articleId && (r.proposalKind === "purchase" || r.proposalKind === "subcontract"))!;
      expect([item.supplierId, item.supplierName]).toEqual([row.primarySupplier?.supplierId ?? null, row.primarySupplier?.supplierName ?? null]);
    }
    // The lego row buys its TO operation.
    const legoItem = group.items.find((i) => i.primary.startsWith("L-10"))!;
    expect(legoItem.proposals).toEqual([
      expect.objectContaining({ articleId: w.legoArticle.id, quantity: 10, kind: "subcontract", key: `subcontract:${w.legoOp.id}`, moOperationId: w.legoOp.id }),
    ]);

    // The other kinds carry no supplier groups.
    const res = await app.inject({ method: "GET", url: "/api/v1/alerts?kinds=manufacture_needed", headers: { cookie: admin.cookie } });
    const made = (res.json() as AlertsResponse).groups[0]!;
    expect(made.count).toBe(1);
    expect(made.supplierGroups).toBeUndefined();
    expect(made.items[0]!.proposals).toBeUndefined();
  });

  it("groupBySupplier keeps the order inside a group, breaks a name tie on the id and counts past the limit", () => {
    const item = (key: string, supplierId: string | null, supplierName: string | null): AlertItem => ({
      key,
      severity: "yellow",
      href: null,
      primary: key,
      secondary: null,
      date: null,
      supplierId,
      supplierName,
    });
    const grouped = groupBySupplier(
      [item("a", "s2", "Öst AB"), item("b", null, null), item("c", "s1", "Ask AB"), item("d", "s2", "Öst AB"), item("e", "s0", "Ask AB"), item("f", null, null)],
      3
    );
    expect(grouped.items.map((i) => i.key)).toEqual(["b", "f", "e", "c", "a", "d"]);
    expect(grouped.groups.map((g) => [g.key, g.count, g.shown])).toEqual([
      ["none", 2, 2],
      ["s0", 1, 1],
      ["s1", 1, 0],
      ["s2", 2, 0],
    ]);
    expect(groupBySupplier([])).toEqual({ items: [], groups: [] });
  });
});

describe("Skapa inköpsorder from Behöver beställas", () => {
  it("the alert's proposals are the behovsberäkning's: one IO per supplier, and the ordered rows leave the alert", async () => {
    const admin = await session(null, { role: "admin" });
    const w = await world(admin.user.id);
    const inkop = await session(["inkop"]);
    const rows = await requirementRows(admin.cookie);
    const group = await purchaseNeeded(inkop.cookie);

    // The same body as the behovsberäkning page would post for the same rows.
    const fromAlert = group.items.flatMap((i) => i.proposals!);
    expect([...fromAlert].sort(byKey)).toEqual(pageProposals(rows).sort(byKey));

    // Skapa inköpsorder on the rows with a supplier (the web cannot mark
    // Utan förvald leverantör), as an Inköp user.
    const marked = group.items.filter((i) => i.supplierId !== null).flatMap((i) => i.proposals!);
    const res = await post(inkop.cookie, marked);
    expect(res.statusCode).toBe(201);
    const result = res.json() as {
      purchaseOrders: { id: string; supplierId: string; supplierName: string; rowCount: number }[];
      manufacturingOrders: unknown[];
      errors: unknown[];
    };
    expect(result.errors).toEqual([]);
    expect(result.manufacturingOrders).toEqual([]);
    // One IO per supplier for the purchases, and the lego operation's own
    // IO at its supplier — exactly what Skapa ordrar makes.
    expect(result.purchaseOrders.map((o) => [o.supplierName, o.rowCount]).sort()).toEqual([
      ["Alfa Yta AB", 1],
      ["Alfa Yta AB", 1],
      ["Beta Stål AB", 2],
    ]);
    const ordered = await db
      .select({ supplierId: purchaseOrders.supplierId, articleId: purchaseOrderRows.articleId, quantity: purchaseOrderRows.quantityOrdered })
      .from(purchaseOrderRows)
      .innerJoin(purchaseOrders, sql`${purchaseOrders.id} = ${purchaseOrderRows.purchaseOrderId}`);
    expect(ordered.map((r) => `${r.supplierId}:${r.articleId}:${Number(r.quantity)}`).sort()).toEqual(
      [
        `${w.alfa.id}:${w.atAlfa.id}:5`,
        `${w.alfa.id}:${w.legoArticle.id}:10`,
        `${w.beta.id}:${w.atBeta1.id}:4`,
        `${w.beta.id}:${w.atBeta2.id}:6`,
      ].sort()
    );

    // No Uppdatera in between: Skapa ordrar dropped the cache, so the alert
    // only has the row nobody could order.
    const after = await purchaseNeeded(inkop.cookie);
    expect(after.count).toBe(1);
    expect(after.items.map((i) => i.primary.split(" ")[0])).toEqual(["K-10"]);
    expect(after.supplierGroups).toEqual([{ key: "none", supplierId: null, supplierName: null, count: 1, shown: 1 }]);

    // The same proposals again (another tab): refused by their keys, no new IO.
    const again = await post(inkop.cookie, marked);
    expect(again.statusCode).toBe(201);
    expect((again.json() as { purchaseOrders: unknown[]; errors: unknown[] }).purchaseOrders).toEqual([]);
    expect((again.json() as { errors: unknown[] }).errors).toHaveLength(marked.length);
    expect(await db.select({ id: purchaseOrders.id }).from(purchaseOrders)).toHaveLength(3);
  });

  it("Inköp may order purchase and lego proposals but never a TO; Tillverkning as before; others and the read-only account are refused", async () => {
    const admin = await session(null, { role: "admin" });
    const w = await world(admin.user.id);
    await requirementRows(admin.cookie);
    const group = await purchaseNeeded(admin.cookie);
    const proposalOf = (articleId: string): AlertOrderProposal => group.items.flatMap((i) => i.proposals!).find((p) => p.articleId === articleId)!;
    const manufacture = { articleId: w.made.id, quantity: 7, kind: "manufacture" };
    const configured = { articleId: w.made.id, quantity: 1, kind: "configured", salesOrderRowId: crypto.randomUUID() };

    const inkop = await session(["inkop"]);
    const production = await session(["tillverkning"]);
    const sales = await session(["forsaljning"]);
    const workshop = await session(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    const readOnly = await session(["inkop", "tillverkning"], { readOnly: true });

    // Inköp: a TO proposal refuses the WHOLE call — the purchase proposal
    // next to it is not ordered either.
    for (const body of [[manufacture], [configured], [proposalOf(w.atBeta1.id), manufacture]]) {
      const res = await post(inkop.cookie, body);
      expect([res.statusCode, res.json().code]).toEqual([403, "forbidden"]);
    }
    expect(await db.select({ id: purchaseOrders.id }).from(purchaseOrders)).toHaveLength(0);
    expect(await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).toHaveLength(1); // the world's own TO

    // Other menus, the workshop profile and the read-only account: nothing.
    for (const who of [sales, workshop]) {
      const res = await post(who.cookie, [proposalOf(w.atBeta1.id)]);
      expect([res.statusCode, res.json().code]).toEqual([403, "forbidden"]);
    }
    const refused = await post(readOnly.cookie, [proposalOf(w.atBeta1.id)]);
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    expect(await db.select({ id: purchaseOrders.id }).from(purchaseOrders)).toHaveLength(0);

    // Inköp: purchase and lego.
    const bought = await post(inkop.cookie, [proposalOf(w.atBeta1.id), proposalOf(w.legoArticle.id)]);
    expect(bought.statusCode).toBe(201);
    expect((bought.json() as { errors: unknown[] }).errors).toEqual([]);
    expect((bought.json() as { purchaseOrders: { supplierId: string }[] }).purchaseOrders.map((o) => o.supplierId).sort()).toEqual(
      [w.alfa.id, w.beta.id].sort()
    );

    // Tillverkning as before: TOs and draft IOs in one call.
    const both = await post(production.cookie, [manufacture, proposalOf(w.atAlfa.id)]);
    expect(both.statusCode).toBe(201);
    const made = both.json() as { purchaseOrders: { supplierId: string }[]; manufacturingOrders: { articleId: string }[]; errors: unknown[] };
    expect(made.errors).toEqual([]);
    expect(made.purchaseOrders.map((o) => o.supplierId)).toEqual([w.alfa.id]);
    expect(made.manufacturingOrders).toHaveLength(1);
    expect(await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).toHaveLength(2);
  });
});

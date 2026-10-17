import { describe, expect, it } from "vitest";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import type { PlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import type { ArticleOverviewInput } from "../src/modules/planning/service/article-overview.js";
import type { PartnerDeliveryFields } from "../src/modules/system/service/delivery-days.js";

// Pure unit tests with faked deps — no database. Covers the order-creation
// failure branches that are impractical to provoke through the real services.

function makeRepo(overrides: Partial<PlanningRepository> = {}): PlanningRepository {
  return {
    async loadRequirementsInput() {
      throw new Error("not used in these tests");
    },
    async loadArticleOverviewInput() {
      throw new Error("not used in these tests");
    },
    // Konfigurator 4c: no configured rows in these fakes.
    async loadConfiguredSalesRows() {
      return [];
    },
    async primarySuppliersForArticles(articleIds: string[]) {
      return articleIds.map((articleId) => ({
        articleId,
        supplierId: "sup-1",
        supplierName: "Stål AB",
        price: 10,
        currency: "SEK",
        leadTimeDays: 7,
        priceBreaks: [],
      }));
    },
    async articleInfoForIds(articleIds: string[]) {
      return articleIds.map((articleId) => ({ articleId, articleNumber: `NR-${articleId}` }));
    },
    // Fasta leveransdagar: the system defaults, no holidays.
    async deliveryContext() {
      return {
        defaults: { supplier: { mode: "arrival", transitDays: 0 }, customer: { mode: "dispatch", transitDays: 0 } },
        offDays: new Set<string>(),
      };
    },
    async fullDayHolidaysBetween() {
      return [];
    },
    ...overrides,
  } as PlanningRepository;
}

describe("planning service — stafflat leverantörspris on created rows", () => {
  it("prices each row from the primary supplier's staffel for the proposal quantity", async () => {
    const rows: { articleId: string; quantity: number; unitPrice: number }[] = [];
    const service = createPlanningService(
      makeRepo({
        async primarySuppliersForArticles(articleIds: string[]) {
          return articleIds.map((articleId) => ({
            articleId,
            supplierId: "sup-1",
            supplierName: "Stål AB",
            price: 10,
            currency: "SEK",
            leadTimeDays: 7,
            priceBreaks: [{ fromQuantity: 10, price: 5 }],
          }));
        },
      }),
      {
        purchase: {
          async createPurchaseOrder() {
            return { id: "po-1", orderNumber: "IO-1" };
          },
          async addRow(_orderId: string, input: { articleId: string; quantity: number; unitPrice: number }) {
            rows.push({ articleId: input.articleId, quantity: input.quantity, unitPrice: input.unitPrice });
            return {};
          },
          async cancel() {},
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used in this test");
          },
        },
      }
    );

    const result = await service.createOrdersFromProposals(
      {
        proposals: [
          { articleId: "a1", quantity: 10, kind: "purchase" },
          { articleId: "a2", quantity: 9, kind: "purchase" },
        ],
      },
      "user-1"
    );

    expect(result.errors).toEqual([]);
    expect(rows.map((r) => [r.articleId, r.unitPrice])).toEqual([
      ["a1", 5], // at the break
      ["a2", 10], // below it: grundpriset
    ]);
  });
});

describe("planning service — order creation failure branches", () => {
  it("cancels and does not report a purchase order whose every row failed, with sanitized messages", async () => {
    const cancelled: string[] = [];
    const service = createPlanningService(makeRepo(), {
      purchase: {
        async createPurchaseOrder() {
          return { id: "po-1", orderNumber: "IO-1" };
        },
        async addRow() {
          // Drizzle-style failure — full SQL text must never reach the client.
          throw new Error('Failed query: insert into "purchase_order_rows" (...) values (...)');
        },
        async cancel(id: string) {
          cancelled.push(id);
        },
      },
      manufacturing: {
        async createManufacturingOrder() {
          throw new Error("not used");
        },
      },
    });

    const result = await service.createOrdersFromProposals(
      { proposals: [{ articleId: "a1", quantity: 5, kind: "purchase" }] },
      "user-1"
    );

    expect(result.purchaseOrders).toEqual([]);
    expect(cancelled).toEqual(["po-1"]);
    expect(result.errors).toEqual([
      { articleId: "a1", articleNumber: "NR-a1", message: "Kunde inte skapa order" },
    ]);
  });

  it("keeps a partially successful order and reports only the failed rows, with article numbers", async () => {
    const service = createPlanningService(makeRepo(), {
      purchase: {
        async createPurchaseOrder() {
          return { id: "po-1", orderNumber: "IO-1" };
        },
        async addRow(_orderId: string, input: { articleId: string }) {
          if (input.articleId === "bad") throw new Error("Artikeln är inaktiv");
        },
        async cancel() {
          throw new Error("must not cancel a partially successful order");
        },
      },
      manufacturing: {
        async createManufacturingOrder() {
          throw new Error("not used");
        },
      },
    });

    const result = await service.createOrdersFromProposals(
      {
        proposals: [
          { articleId: "ok", quantity: 5, kind: "purchase" },
          { articleId: "bad", quantity: 3, kind: "purchase" },
        ],
      },
      "user-1"
    );

    expect(result.purchaseOrders).toEqual([
      { id: "po-1", orderNumber: "IO-1", supplierId: "sup-1", supplierName: "Stål AB", rowCount: 1 },
    ]);
    // A meaningful domain message passes through untouched:
    expect(result.errors).toEqual([{ articleId: "bad", articleNumber: "NR-bad", message: "Artikeln är inaktiv" }]);
  });

  it("stamps the article number on missing-primary-supplier errors", async () => {
    const service = createPlanningService(
      makeRepo({
        async primarySuppliersForArticles() {
          return [];
        },
      }),
      {
        purchase: {
          async createPurchaseOrder() {
            throw new Error("not used");
          },
          async addRow() {
            throw new Error("not used");
          },
          async cancel() {
            throw new Error("not used");
          },
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used");
          },
        },
      }
    );

    const result = await service.createOrdersFromProposals(
      { proposals: [{ articleId: "a1", quantity: 5, kind: "purchase" }] },
      "user-1"
    );

    expect(result.errors).toEqual([
      { articleId: "a1", articleNumber: "NR-a1", message: "Artikeln saknar huvudleverantör" },
    ]);
  });
});

// --- Etapp G: subcontract (lego) proposals ---

function legoOperation(overrides: Partial<{
  moOperationId: string;
  orderNumber: string;
  articleId: string;
  sequenceNo: number;
  supplierId: string | null;
  supplierName: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
}> = {}) {
  return {
    moOperationId: "op-1",
    manufacturingOrderId: "mo-1",
    orderNumber: "PO-2044",
    articleId: "a1",
    articleNumber: "NR-a1",
    articleName: "Legodetalj",
    articleType: "manufactured" as const,
    unitCode: "st",
    groupId: null,
    sequenceNo: 20,
    operationDescription: "Ytbehandling",
    workCenterName: "Ytbehandling AB",
    orderQuantity: 10,
    orderedQuantity: 0,
    supplierId: "sup-lego",
    supplierName: "Lego AB",
    setupPrice: 500,
    unitPrice: 100,
    ...overrides,
  };
}

describe("planning service — subcontract (lego) proposals", () => {
  it("groups per supplier and puts unitPrice/setupPrice/moOperationId on the rows", async () => {
    const addedRows: { orderId: string; input: Record<string, unknown> }[] = [];
    let created = 0;
    const service = createPlanningService(
      makeRepo({
        async legoOperationsForIds() {
          return [
            legoOperation({ moOperationId: "op-1", articleId: "a1" }),
            legoOperation({ moOperationId: "op-2", articleId: "a2", orderNumber: "PO-2045", setupPrice: null, unitPrice: 50 }),
          ];
        },
      } as never),
      {
        purchase: {
          async createPurchaseOrder(input: { supplierId: string }) {
            created += 1;
            expect(input.supplierId).toBe("sup-lego");
            return { id: `po-${created}`, orderNumber: `IO-${created}` };
          },
          async addRow(orderId: string, input: Record<string, unknown>) {
            addedRows.push({ orderId, input });
          },
          async cancel() {
            throw new Error("must not cancel");
          },
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used");
          },
        },
      }
    );

    const result = await service.createOrdersFromProposals(
      {
        proposals: [
          { articleId: "a1", quantity: 10, kind: "subcontract", moOperationId: "op-1" },
          { articleId: "a2", quantity: 4, kind: "subcontract", moOperationId: "op-2" },
        ],
      },
      "user-1"
    );

    // Same supplier, different articles → ONE draft IO with two rows.
    expect(created).toBe(1);
    expect(result.purchaseOrders).toEqual([
      { id: "po-1", orderNumber: "IO-1", supplierId: "sup-lego", supplierName: "Lego AB", rowCount: 2 },
    ]);
    expect(addedRows).toEqual([
      { orderId: "po-1", input: { articleId: "a1", quantity: 10, unitPrice: 100, setupPrice: 500, moOperationId: "op-1" } },
      { orderId: "po-1", input: { articleId: "a2", quantity: 4, unitPrice: 50, setupPrice: undefined, moOperationId: "op-2" } },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("splits two lego operations on the SAME article into separate orders (one row per article per PO)", async () => {
    const orders: { id: string; rows: string[] }[] = [];
    const service = createPlanningService(
      makeRepo({
        async legoOperationsForIds() {
          return [
            legoOperation({ moOperationId: "op-1", articleId: "a1" }),
            legoOperation({ moOperationId: "op-2", articleId: "a1", orderNumber: "PO-2045" }),
          ];
        },
      } as never),
      {
        purchase: {
          async createPurchaseOrder() {
            const order = { id: `po-${orders.length + 1}`, orderNumber: `IO-${orders.length + 1}`, rows: [] as string[] };
            orders.push(order);
            return order;
          },
          async addRow(orderId: string, input: { moOperationId?: string }) {
            orders.find((o) => o.id === orderId)!.rows.push(input.moOperationId!);
          },
          async cancel() {
            throw new Error("must not cancel");
          },
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used");
          },
        },
      }
    );

    const result = await service.createOrdersFromProposals(
      {
        proposals: [
          { articleId: "a1", quantity: 10, kind: "subcontract", moOperationId: "op-1" },
          { articleId: "a1", quantity: 10, kind: "subcontract", moOperationId: "op-2" },
        ],
      },
      "user-1"
    );

    expect(orders.map((o) => o.rows)).toEqual([["op-1"], ["op-2"]]);
    expect(result.purchaseOrders).toHaveLength(2);
  });

  it("reports an error for an operation without supplier and one that no longer exists", async () => {
    const service = createPlanningService(
      makeRepo({
        async legoOperationsForIds() {
          return [legoOperation({ moOperationId: "op-1", supplierId: null, supplierName: null })];
        },
      } as never),
      {
        purchase: {
          async createPurchaseOrder() {
            throw new Error("must not create");
          },
          async addRow() {
            throw new Error("must not add");
          },
          async cancel() {
            throw new Error("must not cancel");
          },
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used");
          },
        },
      }
    );

    const result = await service.createOrdersFromProposals(
      {
        proposals: [
          { articleId: "a1", quantity: 10, kind: "subcontract", moOperationId: "op-1" },
          { articleId: "a2", quantity: 5, kind: "subcontract", moOperationId: "op-gone" },
        ],
      },
      "user-1"
    );

    expect(result.purchaseOrders).toEqual([]);
    expect(result.errors).toEqual([
      {
        articleId: "a1",
        articleNumber: "NR-a1",
        message: "Legooperationen saknar leverantör (PO-2044 · Op 20)",
      },
      {
        articleId: "a2",
        articleNumber: "NR-a2",
        message: "Legooperationen finns inte längre eller är redan klar",
      },
    ]);
  });
});

describe("planning service — behovsberäkning result cache", () => {
  // One purchased article short by 5 — enough for a single proposal row.
  function countingRepo() {
    let loads = 0;
    const repo = makeRepo({
      async loadRequirementsInput() {
        loads += 1;
        return {
          articles: [
            {
              articleId: "a",
              articleNumber: "A",
              name: "A",
              type: "purchased",
              isPhantom: false,
              active: true,
              unitCode: "st",
              groupId: null,
              reorderPoint: null,
              orderQuantity: null,
              rounding: null,
              configuratorMode: null,
            },
          ],
          salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 5, quantityDelivered: 0 }],
          purchaseRows: [],
          manufacturingOrders: [],
          moMaterialRows: [],
          stock: [],
          bomEdges: [],
          primarySuppliers: [],
          legoOperationRows: [],
          configuredRows: [],
          configuredCascade: new Map(),
        };
      },
    });
    return { repo, loads: () => loads };
  }
  const noCreators = {
    purchase: {
      createPurchaseOrder: async () => ({ id: "po", orderNumber: "IO-1" }),
      addRow: async () => ({}),
      cancel: async () => ({}),
    },
    manufacturing: { createManufacturingOrder: async () => ({ id: "mo", orderNumber: "TO-1" }) },
  };

  it("reuses the computed result for paging/search within the TTL and stamps computedAt", async () => {
    let t = 1_000_000;
    const { repo, loads } = countingRepo();
    const service = createPlanningService(repo, { ...noCreators, now: () => t });

    const first = await service.listRequirements({ limit: 50, offset: 0 } as never);
    t += 30_000;
    const second = await service.listRequirements({ limit: 50, offset: 0, search: "zzz" } as never);

    expect(loads()).toBe(1);
    expect(first.total).toBe(1);
    expect(second.total).toBe(0); // the search filters the cached rows…
    expect(first.computedAt).toBe(new Date(1_000_000).toISOString());
    expect(second.computedAt).toBe(first.computedAt); // …computed once

    // …and filtering never mutated the cache.
    expect((await service.listRequirements({ limit: 50, offset: 0 } as never)).total).toBe(1);
  });

  it("recomputes after the TTL, on refresh, and after Skapa ordrar", async () => {
    let t = 0;
    const { repo, loads } = countingRepo();
    const service = createPlanningService(repo, { ...noCreators, now: () => t });

    await service.listRequirements({ limit: 50, offset: 0 } as never);
    t += 60_000;
    await service.listRequirements({ limit: 50, offset: 0 } as never);
    expect(loads()).toBe(2);

    await service.listRequirements({ limit: 50, offset: 0, refresh: true } as never);
    expect(loads()).toBe(3);

    await service.createOrdersFromProposals({ proposals: [] } as never, "u");
    await service.listRequirements({ limit: 50, offset: 0 } as never);
    expect(loads()).toBe(4);
  });

  it("shares one computation between concurrent requests and retries after a failure", async () => {
    let loads = 0;
    let fail = true;
    const service = createPlanningService(
      makeRepo({
        async loadRequirementsInput() {
          loads += 1;
          if (fail) throw new Error("db down");
          return countingRepoInput();
        },
      }),
      { ...noCreators, now: () => 0 }
    );

    await expect(
      Promise.all([
        service.listRequirements({ limit: 50, offset: 0 } as never),
        service.listRequirements({ limit: 50, offset: 0 } as never),
      ])
    ).rejects.toThrow("db down");
    expect(loads).toBe(1); // one shared attempt

    fail = false;
    expect((await service.listRequirements({ limit: 50, offset: 0 } as never)).total).toBe(0);
    expect(loads).toBe(2); // the failure wasn't cached
  });

  function countingRepoInput() {
    return {
      articles: [],
      salesRows: [],
      purchaseRows: [],
      manufacturingOrders: [],
      moMaterialRows: [],
      stock: [],
      bomEdges: [],
      primarySuppliers: [],
      legoOperationRows: [],
    };
  }
});

// Konfigurator 4c: the configured rows' cascade is derived ONCE per distinct
// (template, key) per run, at the summed uncovered quantity; an invalid or
// failing derivation lands on every row of the group and cascades nothing.
describe("planning service — configured rows: one derivation per configuration", () => {
  const noCreators = {
    purchase: {
      createPurchaseOrder: async () => ({ id: "po", orderNumber: "IO-1" }),
      addRow: async () => ({}),
      cancel: async () => ({}),
    },
    manufacturing: {
      createManufacturingOrder: async () => ({ id: "mo", orderNumber: "TO-1" }),
      createFromSalesOrderRow: async () => ({ id: "mo", orderNumber: "TO-1" }),
    },
  };
  const art = (articleId: string, extra: Record<string, unknown>) => ({
    articleId, articleNumber: articleId.toUpperCase(), name: articleId, type: "purchased", isPhantom: false, active: true,
    unitCode: "st", groupId: null, reorderPoint: null, orderQuantity: null, rounding: null, configuratorMode: null, ...extra,
  });
  const selection = [
    { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Lås B", value: "B", unit: null },
    { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
  ];
  const configuredRow = (rowId: string, quantityOrdered: number, key = "k1") => ({
    rowId, salesOrderId: `so-${rowId}`, orderNumber: `KO-${rowId}`, customerName: "Kund AB", articleId: "t",
    expectedDeliveryDate: null, quantityOrdered, quantityDelivered: 0,
    configuration: { templateArticleId: "t", key, selection, price: { base: 0, additions: [], unitPrice: 0, discountPercent: 0, source: "base" } },
    linkedOrders: [] as { status: string; quantity: number }[],
  });
  const repo = (rows: ReturnType<typeof configuredRow>[], template: Record<string, unknown> = {}) =>
    makeRepo({
      async loadRequirementsInput() {
        return {
          articles: [art("t", { type: "manufactured", configuratorMode: "to_order", ...template }), art("c", {})],
          salesRows: [], purchaseRows: [], manufacturingOrders: [], moMaterialRows: [], stock: [], bomEdges: [],
          primarySuppliers: [], legoOperationRows: [], configuredRows: [], configuredCascade: new Map(),
        } as never;
      },
      async loadConfiguredSalesRows() {
        return rows as never;
      },
    });
  const structure = (valid: boolean, quantity: number, errors: string[] = []) =>
    ({
      valid, errors, templateArticleId: "t", key: "k1", selection: [], operations: [], cost: null,
      materials: valid ? [{ componentArticleId: "c", componentName: "c", totalQuantity: 2 * quantity, operationSequenceNo: null, unitId: null, unitFactor: null }] : [],
    }) as never;
  const listAll = (service: ReturnType<typeof createPlanningService>) =>
    service.listRequirements({ limit: 50, offset: 0, showAll: true } as never).then((r) => r.rows);

  it("derives once per (template, key) at the summed uncovered quantity; a different key is its own call", async () => {
    const calls: { templateId: string; selection: unknown; quantity: number; opts: unknown }[] = [];
    const service = createPlanningService(repo([configuredRow("r1", 1), configuredRow("r2", 2), configuredRow("r3", 5, "k2")]), {
      ...noCreators,
      requirementsCacheMs: 0,
      configuredStructure: async (templateId, selection, quantity, opts) => {
        calls.push({ templateId, selection, quantity, opts });
        return structure(true, quantity);
      },
    });
    const rows = await listAll(service);
    expect(calls).toEqual([
      { templateId: "t", selection: { LOCK: "B", BREDD: 1200 }, quantity: 3, opts: { withCost: false } },
      { templateId: "t", selection: { LOCK: "B", BREDD: 1200 }, quantity: 5, opts: { withCost: false } },
    ]);
    expect(rows.find((r) => r.articleId === "c")).toMatchObject({ demandDerived: 16, proposalQuantity: 16, proposalKind: "purchase" });
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => [r.salesOrderRowId, r.proposalQuantity, r.configurationError, r.configurationSummary])).toEqual([
      ["r1", 1, null, "Lås: Lås B · Bredd: 1 200 mm"],
      ["r2", 2, null, "Lås: Lås B · Bredd: 1 200 mm"],
      ["r3", 5, null, "Lås: Lås B · Bredd: 1 200 mm"],
    ]);
  });

  it("rounds each row up to the template's step — the proposal and the summed derivation alike", async () => {
    const calls: number[] = [];
    // Avrundning 1.5: 1 ⇒ 1.5, 2 ⇒ 3 — the same roundUpToMultiple the TO
    // Skapa ordrar makes applies, so the cascade matches what gets built.
    const service = createPlanningService(repo([configuredRow("r1", 1), configuredRow("r2", 2)], { rounding: 1.5 }), {
      ...noCreators,
      requirementsCacheMs: 0,
      configuredStructure: async (_t, _s, quantity) => {
        calls.push(quantity);
        return structure(true, quantity);
      },
    });
    const rows = await listAll(service);
    expect(calls).toEqual([4.5]);
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => [r.salesOrderRowId, r.proposalQuantity])).toEqual([
      ["r1", 1.5],
      ["r2", 3],
    ]);
    expect(rows.find((r) => r.articleId === "c")).toMatchObject({ demandDerived: 9, proposalQuantity: 9 });
  });

  it("a covered row is left out of the derivation entirely", async () => {
    const calls: number[] = [];
    const covered = { ...configuredRow("r1", 2), linkedOrders: [{ status: "planned", quantity: 2 }] };
    const service = createPlanningService(repo([covered, configuredRow("r2", 1)]), {
      ...noCreators,
      requirementsCacheMs: 0,
      configuredStructure: async (_t, _s, quantity) => {
        calls.push(quantity);
        return structure(true, quantity);
      },
    });
    const rows = await listAll(service);
    expect(calls).toEqual([1]);
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => r.salesOrderRowId)).toEqual(["r2"]);
  });

  it("an invalid result puts the engine's first message on BOTH rows and cascades nothing", async () => {
    const service = createPlanningService(repo([configuredRow("r1", 1), configuredRow("r2", 2)]), {
      ...noCreators,
      requirementsCacheMs: 0,
      configuredStructure: async () => structure(false, 0, ["Bredd: minst 1 500 mm", "Lås: krävs"]),
    });
    const rows = await listAll(service);
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => [r.salesOrderRowId, r.proposalQuantity, r.configurationError])).toEqual([
      ["r1", 1, "Bredd: minst 1 500 mm"],
      ["r2", 2, "Bredd: minst 1 500 mm"],
    ]);
    expect(rows.find((r) => r.articleId === "c")).toBeUndefined();
  });

  it("a throwing reader puts its message on BOTH rows and cascades nothing", async () => {
    const service = createPlanningService(repo([configuredRow("r1", 1), configuredRow("r2", 2)]), {
      ...noCreators,
      requirementsCacheMs: 0,
      configuredStructure: async () => {
        throw new Error("Mallen är inte längre en beställningsvara");
      },
    });
    const rows = await listAll(service);
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => r.configurationError)).toEqual([
      "Mallen är inte längre en beställningsvara",
      "Mallen är inte längre en beställningsvara",
    ]);
    expect(rows.find((r) => r.articleId === "c")).toBeUndefined();
  });
});

// Fasta leveransdagar on Skapa ordrar's IO dates. Today is pinned to
// Saturday 2026-10-17 (Monday = the 19th); each article's only demand is one
// confirmed KO row on the given date, so the raw demand date is that date.
describe("planning service — leveransdagar on created purchase orders", () => {
  function overviewInput(articleId: string, demandDate: string | null): ArticleOverviewInput {
    return {
      article: {
        articleId,
        articleNumber: `NR-${articleId}`,
        name: articleId,
        type: "purchased",
        isPhantom: false,
        active: true,
        unitCode: "st",
        reorderPoint: null,
        orderQuantity: null,
        rounding: null,
      },
      onHand: 0,
      salesRows: demandDate
        ? [
            {
              rowId: `row-${articleId}`,
              salesOrderId: `so-${articleId}`,
              orderNumber: `KO-${articleId}`,
              orderStatus: "confirmed",
              customerName: "Kund AB",
              expectedDeliveryDate: demandDate,
              quantityOrdered: 5,
              quantityDelivered: 0,
            },
          ]
        : [],
      purchaseRows: [],
      manufacturingOrders: [],
      materialRows: [],
      plannedMos: [],
      bomEdges: [],
      phantomIds: [],
      primarySupplier: null,
    };
  }

  async function run(opts: {
    demands: Record<string, string | null>;
    leadTimeDays?: number | null;
    supplierDelivery?: PartnerDeliveryFields;
  }) {
    const orders: { expectedDeliveryDate?: string }[] = [];
    const rows: { articleId: string; expectedDeliveryDate?: string }[] = [];
    const service = createPlanningService(
      makeRepo({
        async loadArticleOverviewInput(articleId: string) {
          return overviewInput(articleId, opts.demands[articleId] ?? null);
        },
        async primarySuppliersForArticles(articleIds: string[]) {
          return articleIds.map((articleId) => ({
            articleId,
            supplierId: "sup-1",
            supplierName: "Stål AB",
            price: 10,
            currency: "SEK",
            leadTimeDays: opts.leadTimeDays ?? null,
            priceBreaks: [],
            supplierDelivery: opts.supplierDelivery,
          }));
        },
      }),
      {
        purchase: {
          async createPurchaseOrder(input: { expectedDeliveryDate?: string }) {
            orders.push(input);
            return { id: "po-1", orderNumber: "IO-1" };
          },
          async addRow(_orderId: string, input: { articleId: string; expectedDeliveryDate?: string }) {
            rows.push({ articleId: input.articleId, expectedDeliveryDate: input.expectedDeliveryDate });
            return {};
          },
          async cancel() {},
        },
        manufacturing: {
          async createManufacturingOrder() {
            throw new Error("not used in this test");
          },
          async createFromSalesOrderRow() {
            throw new Error("not used in this test");
          },
        },
        today: () => "2026-10-17",
      }
    );
    const result = await service.createOrdersFromProposals(
      { proposals: Object.keys(opts.demands).map((articleId) => ({ articleId, quantity: 5, kind: "purchase" as const })) },
      "user-1"
    );
    return { result, orders, rows };
  }

  const mondays: PartnerDeliveryFields = { deliveryWeekdays: [1], deliveryDayMode: "arrival", transitDays: null };

  it("a supplier without settings keeps today's rule: the working day before the demand", async () => {
    const { result, orders } = await run({ demands: { a1: "2026-10-28" } });
    expect(orders[0]?.expectedDeliveryDate).toBe("2026-10-27");
    expect(result.warnings).toEqual([]);
  });

  it("arrival days pull the date back to the last arrival day before the demand", async () => {
    const { orders } = await run({ demands: { a1: "2026-10-28" }, supplierDelivery: mondays });
    expect(orders[0]?.expectedDeliveryDate).toBe("2026-10-26");
  });

  it("a lead time pushing past the demand gives the earliest arrival and a warning", async () => {
    const { result, orders } = await run({ demands: { a1: "2026-10-21" }, leadTimeDays: 10, supplierDelivery: mondays });
    expect(orders[0]?.expectedDeliveryDate).toBe("2026-11-02");
    expect(result.warnings).toEqual([
      {
        orderNumber: "IO-1",
        articleNumber: "NR-a1",
        demandDate: "2026-10-21",
        deliveryDate: "2026-11-02",
        message: "Leveransen (2026-11-02) kommer efter behovet (2026-10-21)",
      },
    ]);
  });

  it("a passed demand warns with the raw demand date", async () => {
    const { result, orders } = await run({ demands: { a1: "2026-10-10" }, supplierDelivery: mondays });
    expect(orders[0]?.expectedDeliveryDate).toBe("2026-10-19");
    expect(result.warnings[0]).toMatchObject({ demandDate: "2026-10-10", deliveryDate: "2026-10-19" });
  });

  it("the order gets the earliest date and a later row keeps its own", async () => {
    const { orders, rows } = await run({ demands: { a1: "2026-10-28", a2: "2026-11-04" } });
    expect(orders[0]?.expectedDeliveryDate).toBe("2026-10-27");
    expect(rows).toEqual([
      { articleId: "a1", expectedDeliveryDate: undefined },
      { articleId: "a2", expectedDeliveryDate: "2026-11-03" },
    ]);
  });

  it("a proposal without demand (reorder point) at a supplier without settings gets no date", async () => {
    const { result, orders } = await run({ demands: { a1: null } });
    expect(orders[0]?.expectedDeliveryDate).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  // The delivery context is loaded AFTER the TOs are created: a failure
  // there must never 500 the request (the TOs would exist with no answer).
  // Without the context the rows are dated as before fasta leveransdagar —
  // the TO färdigdatum rule's own date — and the order is still created.
  describe("a failing delivery context", () => {
    async function runWithFailingContext(opts: { failFrom: number; supplierDelivery?: PartnerDeliveryFields }) {
      let calls = 0;
      const orders: { expectedDeliveryDate?: string }[] = [];
      const rows: { articleId: string; expectedDeliveryDate?: string }[] = [];
      const service = createPlanningService(
        makeRepo({
          async loadArticleOverviewInput(articleId: string) {
            return overviewInput(articleId, { a1: "2026-10-28", a2: "2026-11-04" }[articleId] ?? null);
          },
          // The färdigdatum suggestion per row loads the context first (one
          // call per row, through toShipDates); Skapa ordrar's own load for
          // the IO dates comes after them.
          async deliveryContext() {
            calls += 1;
            if (calls >= opts.failFrom) throw new Error('Failed query: select "key", "value" from "system_settings"');
            return {
              defaults: { supplier: { mode: "arrival", transitDays: 0 }, customer: { mode: "dispatch", transitDays: 0 } },
              offDays: new Set<string>(),
            };
          },
          async primarySuppliersForArticles(articleIds: string[]) {
            return articleIds.map((articleId) => ({
              articleId,
              supplierId: "sup-1",
              supplierName: "Stål AB",
              price: 10,
              currency: "SEK",
              leadTimeDays: 10,
              priceBreaks: [],
              supplierDelivery: opts.supplierDelivery,
            }));
          },
        }),
        {
          purchase: {
            async createPurchaseOrder(input: { expectedDeliveryDate?: string }) {
              orders.push(input);
              return { id: "po-1", orderNumber: "IO-1" };
            },
            async addRow(_orderId: string, input: { articleId: string; expectedDeliveryDate?: string }) {
              rows.push({ articleId: input.articleId, expectedDeliveryDate: input.expectedDeliveryDate });
              return {};
            },
            async cancel() {
              throw new Error("must not cancel");
            },
          },
          manufacturing: {
            async createManufacturingOrder() {
              throw new Error("not used in this test");
            },
            async createFromSalesOrderRow() {
              throw new Error("not used in this test");
            },
          },
          today: () => "2026-10-17",
        }
      );
      const result = await service.createOrdersFromProposals(
        {
          proposals: [
            { articleId: "a1", quantity: 5, kind: "purchase" },
            { articleId: "a2", quantity: 5, kind: "purchase" },
          ],
        },
        "user-1"
      );
      return { result, orders, rows, calls: () => calls };
    }

    it("dates the rows with the färdigdatum rule (the working day before the demand) and creates the order", async () => {
      // Two suggestion loads succeed (one per row), the IO-date load fails.
      const { result, orders, rows, calls } = await runWithFailingContext({ failFrom: 3, supplierDelivery: mondays });
      expect(calls()).toBe(3);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.purchaseOrders).toEqual([
        { id: "po-1", orderNumber: "IO-1", supplierId: "sup-1", supplierName: "Stål AB", rowCount: 2 },
      ]);
      // Not the Monday rule or the lead-time floor — exactly the old dates.
      expect(orders[0]?.expectedDeliveryDate).toBe("2026-10-27");
      expect(rows).toEqual([
        { articleId: "a1", expectedDeliveryDate: undefined },
        { articleId: "a2", expectedDeliveryDate: "2026-11-03" },
      ]);
    });

    it("creates the order undated when even the suggestions' context fails", async () => {
      const { result, orders, rows } = await runWithFailingContext({ failFrom: 1 });
      expect(result.errors).toEqual([]);
      expect(result.purchaseOrders).toHaveLength(1);
      expect(orders[0]?.expectedDeliveryDate).toBeUndefined();
      expect(rows.map((r) => r.expectedDeliveryDate)).toEqual([undefined, undefined]);
    });
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db, routingOperationAlternatives, routingOperations, workCenters } from "@navet/db";
import { createArticleSchema, type CreateArticleInput } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  RoutingAlternativeInvalidError,
  RoutingOperationHasAlternativesError,
  WorkCenterNotFoundError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { routingAlternativesProblem, routingOperationHasAlternativesProblem } from "../src/modules/manufacturing/service/routing-alternatives.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";

// Alternativa resurser (#15), etapp 1 — the beredning: the rules for an own
// operation's alternatives (400 routing-alternative-invalid, 409
// routing-operation-has-alternatives), the order and the replaced set, GET
// /articles/:id/routing's shape and Kopiera beredning. The TO side is in
// mo-operation-resources.test.ts, the variants in
// configurator-variants.service.test.ts, the import in import-routing.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const purchaseRepository = createPurchaseRepository(db);

const TRUNCATE = sql`TRUNCATE mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, suppliers CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function article(type: "manufactured" | "purchased" = "manufactured", extra: Partial<CreateArticleInput> = {}) {
  return articleService.createArticle(
    createArticleSchema.parse({ articleNumber: `R-${crypto.randomUUID().slice(0, 8)}`, name: "Bänk", type, unit: "st", active: true, ...extra }) as CreateArticleInput
  );
}

async function storedAlternatives(routingOperationId: string) {
  return db
    .select({
      workCenterId: routingOperationAlternatives.workCenterId,
      rank: routingOperationAlternatives.rank,
      setupTime: routingOperationAlternatives.setupTime,
      runTimePerUnit: routingOperationAlternatives.runTimePerUnit,
    })
    .from(routingOperationAlternatives)
    .where(eq(routingOperationAlternatives.routingOperationId, routingOperationId))
    .orderBy(asc(routingOperationAlternatives.rank));
}

// 110 Kantpress (the ordinarie), 120 Kantpress 2 with a week of 8 h/day,
// 130 Kantpress 3 without capacity, 140 Svets, and a legoresurs 900.
async function resources() {
  const supplier = await purchaseRepository.createSupplier({ name: `Lego ${crypto.randomUUID().slice(0, 6)}`, active: true });
  const wc = (code: string, name: string, extra: Record<string, unknown> = {}) =>
    mfgService.createWorkCenter({ code, name, active: true, ...extra } as never);
  return {
    r110: await wc("110", "Kantpress", { hoursPerDay: 8 }),
    r120: await wc("120", "Kantpress 2", { hoursPerDay: 8 }),
    r130: await wc("130", "Kantpress 3"),
    r140: await wc("140", "Svets", { hoursPerDay: 8 }),
    lego: await wc("900", "Lack AB", { type: "subcontract", supplierId: supplier.id }),
  };
}

describe("the rules (pure)", () => {
  const ordinary = { id: "o", code: "110", type: "machine" };
  const wc = (id: string, code: string, type = "machine", active = true) => ({ id, code, type, active });

  it("accepts own active resources and an empty set anywhere", () => {
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: [{ workCenter: wc("a", "120"), isNew: true }] })).toBeNull();
    expect(routingAlternativesProblem({ ordinary: { ...ordinary, type: "subcontract" }, costingOnly: true, alternatives: [] })).toBeNull();
  });

  it("names each refusal", () => {
    const one = (workCenter: ReturnType<typeof wc>, isNew = true) => [{ workCenter, isNew }];
    expect(routingAlternativesProblem({ ordinary, costingOnly: true, alternatives: one(wc("a", "120")) })).toBe(
      "En kalkyloperation kan inte ha alternativa resurser"
    );
    expect(routingAlternativesProblem({ ordinary: { ...ordinary, type: "subcontract" }, costingOnly: false, alternatives: one(wc("a", "120")) })).toBe(
      "En legooperation kan inte ha alternativa resurser"
    );
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: one(wc("o", "110")) })).toBe(
      "Resurs 110 är operationens ordinarie resurs och kan inte också vara alternativ"
    );
    expect(
      routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: [...one(wc("a", "120")), ...one(wc("a", "120"))] })
    ).toBe("Resurs 120 finns flera gånger bland alternativen");
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: one(wc("l", "900", "subcontract")) })).toBe(
      "Resurs 900 är en legoresurs — en alternativ resurs ska vara en maskin eller personal"
    );
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: one(wc("i", "130", "machine", false)) })).toBe(
      "Resurs 130 är inaktiv och kan inte läggas till som alternativ"
    );
    // An inactive resource that already was an alternative may stay.
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: one(wc("i", "130", "machine", false), false) })).toBeNull();
    const six = ["1", "2", "3", "4", "5", "6"].map((n) => ({ workCenter: wc(n, `12${n}`), isNew: true }));
    expect(routingAlternativesProblem({ ordinary, costingOnly: false, alternatives: six })).toBe("En operation kan ha högst 5 alternativa resurser");
  });

  it("refuses an operation that keeps its alternatives but stops being able to have them", () => {
    const has = { alternativeWorkCenterIds: ["a"], costingOnly: false };
    expect(routingOperationHasAlternativesProblem({ ...has, ordinary })).toBeNull();
    expect(routingOperationHasAlternativesProblem({ ...has, ordinary: { id: "l", code: "900", type: "subcontract" } })).toBe(
      "Operationen har alternativa resurser — ta bort dem innan den läggs på en legoresurs"
    );
    expect(routingOperationHasAlternativesProblem({ ...has, ordinary, costingOnly: true })).toBe(
      "Operationen har alternativa resurser — ta bort dem innan den görs till Kalkyl"
    );
    expect(routingOperationHasAlternativesProblem({ ...has, ordinary: { id: "a", code: "120", type: "machine" } })).toBe(
      "Resurs 120 är redan alternativ på operationen — ta bort den ur alternativen först"
    );
    expect(routingOperationHasAlternativesProblem({ alternativeWorkCenterIds: [], costingOnly: true, ordinary: { id: "l", code: "900", type: "subcontract" } })).toBeNull();
  });
});

describe("the beredning", () => {
  it("creates an operation with its alternatives in order — null times are som ordinarie — and GET shows them", async () => {
    const r = await resources();
    const parent = await article();
    const created = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 10,
      runTimePerUnit: 2,
      alternatives: [{ workCenterId: r.r130.id, setupTime: 5 }, { workCenterId: r.r120.id, runTimePerUnit: 1.5 }],
    });
    const expected = [
      { workCenterId: r.r130.id, code: "130", name: "Kantpress 3", rank: 1, setupTime: "5.00", runTimePerUnit: null, active: true, hasCapacity: false },
      { workCenterId: r.r120.id, code: "120", name: "Kantpress 2", rank: 2, setupTime: null, runTimePerUnit: "1.5000", active: true, hasCapacity: true },
    ];
    expect(created.alternatives).toEqual(expected);
    const [listed] = await mfgService.listRoutingOperations(parent.id);
    expect(listed!.alternatives).toEqual(expected);
    // An operation without any has [].
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: r.r140.id, setupTime: 0, runTimePerUnit: 1 });
    const op20 = (await mfgService.listRoutingOperations(parent.id)).find((op) => op.sequenceNo === 20)!;
    expect(op20.alternatives).toEqual([]);
  });

  it("replaces the set as sent (the list's order is the rank), leaves it alone when omitted and removes it with []", async () => {
    const r = await resources();
    const parent = await article();
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 10,
      runTimePerUnit: 2,
      alternatives: [{ workCenterId: r.r120.id }, { workCenterId: r.r130.id }],
    });
    // Reordered and with times, in one PATCH with an operation field.
    const updated = await mfgService.updateRoutingOperation(parent.id, op.id, {
      description: "Bockning",
      alternatives: [{ workCenterId: r.r130.id, runTimePerUnit: 3 }, { workCenterId: r.r120.id }],
    });
    expect(updated.description).toBe("Bockning");
    expect(await storedAlternatives(op.id)).toEqual([
      { workCenterId: r.r130.id, rank: 1, setupTime: null, runTimePerUnit: "3.0000" },
      { workCenterId: r.r120.id, rank: 2, setupTime: null, runTimePerUnit: null },
    ]);
    // Omitted: untouched, also when the ordinarie's times change.
    await mfgService.updateRoutingOperation(parent.id, op.id, { setupTime: 12 });
    expect(await storedAlternatives(op.id)).toHaveLength(2);
    // [] removes them.
    const cleared = await mfgService.updateRoutingOperation(parent.id, op.id, { alternatives: [] });
    expect(cleared.alternatives).toEqual([]);
    expect(await storedAlternatives(op.id)).toEqual([]);
  });

  it("refuses with 400 the ordinarie, a duplicate, a legoresurs, a new inactive resource, and alternatives on a lego or Kalkyl operation; an unknown resource is a 404", async () => {
    const r = await resources();
    const parent = await article();
    const base = { sequenceNo: 10, workCenterId: r.r110.id, setupTime: 1, runTimePerUnit: 1 };
    const refused = async (input: Parameters<typeof mfgService.createRoutingOperation>[1]) =>
      mfgService.createRoutingOperation(parent.id, input).then(
        () => "accepted",
        (err: Error) => `${err.name}: ${err.message}`
      );
    expect(await refused({ ...base, alternatives: [{ workCenterId: r.r110.id }] })).toBe(
      "RoutingAlternativeInvalidError: Resurs 110 är operationens ordinarie resurs och kan inte också vara alternativ"
    );
    // The schema refuses a duplicate at the route; the service on its own too.
    expect(await refused({ ...base, alternatives: [{ workCenterId: r.r120.id }, { workCenterId: r.r120.id }] })).toBe(
      "RoutingAlternativeInvalidError: Resurs 120 finns flera gånger bland alternativen"
    );
    expect(await refused({ ...base, alternatives: [{ workCenterId: r.lego.id }] })).toMatch(/^RoutingAlternativeInvalidError: Resurs 900 är en legoresurs/);
    expect(await refused({ ...base, workCenterId: r.lego.id, alternatives: [{ workCenterId: r.r120.id }] })).toBe(
      "RoutingAlternativeInvalidError: En legooperation kan inte ha alternativa resurser"
    );
    expect(await refused({ ...base, costingOnly: true, alternatives: [{ workCenterId: r.r120.id }] })).toBe(
      "RoutingAlternativeInvalidError: En kalkyloperation kan inte ha alternativa resurser"
    );
    await mfgService.updateWorkCenter(r.r130.id, { active: false });
    expect(await refused({ ...base, alternatives: [{ workCenterId: r.r130.id }] })).toBe(
      "RoutingAlternativeInvalidError: Resurs 130 är inaktiv och kan inte läggas till som alternativ"
    );
    await expect(
      mfgService.createRoutingOperation(parent.id, { ...base, alternatives: [{ workCenterId: crypto.randomUUID() }] })
    ).rejects.toBeInstanceOf(WorkCenterNotFoundError);
    // Nothing was written by the refusals.
    expect(await db.select().from(routingOperations)).toEqual([]);

    // An edit resolves the resources inside its transaction: an unknown one
    // is a 404 there too, and rolls the edit back.
    const lego = await mfgService.createRoutingOperation(parent.id, { ...base, workCenterId: r.lego.id, setupTime: 0, runTimePerUnit: 0 });
    await expect(
      mfgService.updateRoutingOperation(parent.id, lego.id, { description: "Lack", alternatives: [{ workCenterId: crypto.randomUUID() }] })
    ).rejects.toBeInstanceOf(WorkCenterNotFoundError);
    // [] alone on a lego operation (no other column to set) is fine.
    const cleared = await mfgService.updateRoutingOperation(parent.id, lego.id, { alternatives: [] });
    expect([cleared.id, cleared.description, cleared.alternatives]).toEqual([lego.id, null, []]);
  });

  it("keeps an alternative that went inactive after it was chosen, but refuses it as new", async () => {
    const r = await resources();
    const parent = await article();
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 1,
      runTimePerUnit: 1,
      alternatives: [{ workCenterId: r.r130.id }],
    });
    await mfgService.updateWorkCenter(r.r130.id, { active: false });
    const again = await mfgService.updateRoutingOperation(parent.id, op.id, {
      alternatives: [{ workCenterId: r.r120.id }, { workCenterId: r.r130.id, setupTime: 2 }],
    });
    expect(again.alternatives.map((a) => [a.code, a.rank, a.active])).toEqual([
      ["120", 1, true],
      ["130", 2, false],
    ]);
    // Removed and added back: new in its role, refused.
    await mfgService.updateRoutingOperation(parent.id, op.id, { alternatives: [{ workCenterId: r.r120.id }] });
    await expect(
      mfgService.updateRoutingOperation(parent.id, op.id, { alternatives: [{ workCenterId: r.r130.id }] })
    ).rejects.toBeInstanceOf(RoutingAlternativeInvalidError);
  });

  it("refuses with 409 an operation with alternatives made lego, Kalkyl or given an alternative as ordinarie without the set; the swap with the set is fine", async () => {
    const r = await resources();
    const parent = await article();
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 10,
      runTimePerUnit: 2,
      alternatives: [{ workCenterId: r.r120.id, runTimePerUnit: 1 }],
    });
    for (const input of [{ workCenterId: r.lego.id }, { costingOnly: true }, { workCenterId: r.r120.id }]) {
      await expect(mfgService.updateRoutingOperation(parent.id, op.id, input)).rejects.toBeInstanceOf(RoutingOperationHasAlternativesError);
    }
    expect(await db.select().from(routingOperations)).toMatchObject([{ workCenterId: r.r110.id, costingOnly: false }]);
    // The web's swap: 120 becomes ordinarie with its times, 110 an alternative with its own.
    const swapped = await mfgService.updateRoutingOperation(parent.id, op.id, {
      workCenterId: r.r120.id,
      runTimePerUnit: 1,
      alternatives: [{ workCenterId: r.r110.id, setupTime: 10, runTimePerUnit: 2 }],
    });
    expect(swapped).toMatchObject({ workCenterId: r.r120.id, runTimePerUnit: "1.0000" });
    expect(swapped.alternatives.map((a) => [a.code, a.setupTime, a.runTimePerUnit])).toEqual([["110", "10.00", "2.0000"]]);
    // Without alternatives the operation may become lego or Kalkyl as before.
    const plain = await mfgService.updateRoutingOperation(parent.id, op.id, { alternatives: [], costingOnly: true });
    expect(plain.costingOnly).toBe(true);
  });

  it("deletes the alternatives with the operation, and a resource that is an alternative cannot be deleted", async () => {
    const r = await resources();
    const parent = await article();
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 1,
      runTimePerUnit: 1,
      alternatives: [{ workCenterId: r.r120.id }],
    });
    await expect(db.delete(workCenters).where(eq(workCenters.id, r.r120.id))).rejects.toThrow();
    await mfgService.removeRoutingOperation(parent.id, op.id);
    expect(await db.select().from(routingOperationAlternatives)).toEqual([]);
  });
});

describe("Kopiera beredning", () => {
  it("copies the alternatives with their ranks and times onto the copied operations", async () => {
    const r = await resources();
    const parent = await article();
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: r.r110.id,
      setupTime: 10,
      runTimePerUnit: 2,
      alternatives: [{ workCenterId: r.r130.id, setupTime: 5 }, { workCenterId: r.r120.id, runTimePerUnit: 1.5 }],
    });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: r.r140.id, setupTime: 0, runTimePerUnit: 1 });
    const copy = await article("manufactured", { copyFrom: { articleId: parent.id, parts: ["beredning"] } });
    const operations = await mfgService.listRoutingOperations(copy.id);
    const op10 = operations.find((op) => op.sequenceNo === 10)!;
    expect(op10.alternatives.map((a) => [a.code, a.rank, a.setupTime, a.runTimePerUnit])).toEqual([
      ["130", 1, "5.00", null],
      ["120", 2, null, "1.5000"],
    ]);
    expect(operations.find((op) => op.sequenceNo === 20)!.alternatives).toEqual([]);
    // The source keeps its own rows.
    expect((await mfgService.listRoutingOperations(parent.id)).find((op) => op.sequenceNo === 10)!.alternatives).toHaveLength(2);
  });
});

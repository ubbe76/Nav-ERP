import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq, sql } from "drizzle-orm";
import { configuratorBomLines, configuratorOperations, db } from "@navet/db";
import { createConfiguratorService } from "../src/modules/configurator/service/configurator.service.js";
import {
  ConfiguratorLineNotFoundError, ConfiguratorOperationNotFoundError, ConfiguratorReferenceInUseError,
  ConfiguratorReorderMismatchError, ConfiguratorSequenceTakenError, InvalidConfiguratorFormulaError,
  InvalidConfiguratorGroupError, InvalidConfiguratorLineError, InvalidConfiguratorOperationError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { ArticleNotFoundError } from "../src/modules/article/service/article.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, WorkCenterNotFoundError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { makeArticle, resetConfigurator, testCostingService, variantTestDeps } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Delprojekt 2, Task 4: conditional structure lines and operations, the
// alternative's article and the extended reference guards. Every save is
// validated against the template under the template lock, so nothing stored
// can point at something outside the template.

const service = createConfiguratorService({
  db,
  prices: async () => ({ articleNumber: "X", price: null }),
  customerExists: async () => true,
  articles: {
    exists: async (id) => (await testArticleService.getArticle(id)) != null,
    isDescendant: (articleId, ancestorId) => testArticleService.isDescendant(articleId, ancestorId),
    find: (id) => testArticleService.getArticle(id),
  },
  costing: testCostingService,
  ...variantTestDeps,
});
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

// work_centers is not seeded by any migration and the 3-digit code space is
// small, so this file clears it (same as the costing tests).
async function reset() {
  await resetConfigurator();
  await db.execute(sql`TRUNCATE work_centers CASCADE`);
}
beforeEach(reset);
afterAll(reset);

const NO_ID = "00000000-0000-4000-8000-000000000000";
let wcSeq = 100; // a test may call setup() twice; the resource number is unique

async function setup() {
  const article = await makeArticle({ salesPrice: 1000 });
  await service.createTemplate(article.id, { mode: "variants" });
  const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lock", kind: "choice", required: true });
  const a = await service.createValue(article.id, lock.id, { code: "A", name: "Lock A", priceAdd: 0, active: true });
  const c = await service.createValue(article.id, lock.id, { code: "C", name: "Lock C", priceAdd: 300, active: true });
  const farg = await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
  const ep = await service.createValue(article.id, farg.id, { code: "EP", name: "Elpolerad", priceAdd: 400, active: true });
  const bredd = await service.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 100, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  const hjul = await service.createGroup(article.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 50 });
  const plat = await testArticleService.createArticle({ articleNumber: `PLAT-${crypto.randomUUID().slice(0, 8)}`, name: "Plåt", type: "purchased" } as never);
  const hjulArt = await testArticleService.createArticle({ articleNumber: `HJUL-${crypto.randomUUID().slice(0, 8)}`, name: "Hjul", type: "purchased" } as never);
  const wc = await mfgService.createWorkCenter({ code: String(++wcSeq), name: "Svets", type: "machine", hourlyRate: 600, overheadPercent: 0, capacityFactor: 1, active: true });
  const op10 = await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 });
  return { article, lock, a, c, farg, ep, bredd, hjul, plat, hjulArt, wc, op10 };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function articleLine(s: Setup, extra: Record<string, unknown> = {}) {
  return { conditions: [], source: "article" as const, componentArticleId: s.plat.id, quantity: 2, ...extra };
}

async function countRows(table: "configurator_bom_lines" | "configurator_operations", articleId: string): Promise<number> {
  const t = table === "configurator_bom_lines" ? configuratorBomLines : configuratorOperations;
  const [row] = await db.select({ n: count() }).from(t).where(eq(t.articleId, articleId));
  return row!.n;
}

describe("configurator lines and operations — CRUD and enriched detail", () => {
  it("creates, updates, reorders and deletes structure lines; getTemplate carries the enriched rows", async () => {
    const s = await setup();
    const l1 = await service.createBomLine(s.article.id, articleLine(s, {
      conditions: [{ groupId: s.hjul.id, op: "selected" }], routingOperationId: s.op10.id, note: "Fäste",
    }));
    expect(l1).toMatchObject({
      sortOrder: 1, source: "article", componentArticleId: s.plat.id, componentArticleNumber: s.plat.articleNumber, componentArticleName: "Plåt",
      componentGroupId: null, componentGroupCode: null, componentGroupName: null, quantity: "2.0000", quantityFormula: null,
      routingOperationId: s.op10.id, configuratorOperationId: null, operationSequenceNo: 10, note: "Fäste",
    });
    const l2 = await service.createBomLine(s.article.id, {
      conditions: [], source: "group", componentGroupId: s.lock.id, quantityFormula: "BREDD / 1000",
    });
    expect(l2).toMatchObject({
      sortOrder: 2, source: "group", componentArticleId: null, componentArticleNumber: null, componentGroupId: s.lock.id,
      componentGroupCode: "LOCK", componentGroupName: "Lock", quantity: null, quantityFormula: "BREDD / 1000", operationSequenceNo: null,
    });

    const t = await service.getTemplate(s.article.id);
    expect(t.bomLines.map((l) => l.id)).toEqual([l1.id, l2.id]);

    await service.reorderBomLines(s.article.id, [l2.id, l1.id]);
    expect((await service.getTemplate(s.article.id)).bomLines.map((l) => [l.id, l.sortOrder])).toEqual([[l2.id, 1], [l1.id, 2]]);
    await expect(service.reorderBomLines(s.article.id, [l1.id])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);

    const updated = await service.updateBomLine(s.article.id, l1.id, { note: "Fäste 2", quantity: 3 });
    expect(updated).toMatchObject({ id: l1.id, note: "Fäste 2", quantity: "3.0000", routingOperationId: s.op10.id });

    await service.deleteBomLine(s.article.id, l1.id);
    expect((await service.getTemplate(s.article.id)).bomLines.map((l) => l.id)).toEqual([l2.id]);
    await expect(service.deleteBomLine(s.article.id, l1.id)).rejects.toBeInstanceOf(ConfiguratorLineNotFoundError);
    await expect(service.updateBomLine(s.article.id, NO_ID, { note: "x" })).rejects.toBeInstanceOf(ConfiguratorLineNotFoundError);
  });

  it("creates, updates and deletes conditional operations; sorted by number; a deleted operation unlinks its lines", async () => {
    const s = await setup();
    const op40 = await service.createOperation(s.article.id, {
      conditions: [{ groupId: s.hjul.id, op: "selected" }], sequenceNo: 40, workCenterId: s.wc.id, description: "Montering hjul",
      setupFormula: "BREDD / 100", runTimePerUnit: 2,
    });
    expect(op40).toMatchObject({
      sequenceNo: 40, workCenterId: s.wc.id, workCenterCode: s.wc.code, workCenterName: "Svets", description: "Montering hjul",
      setupTime: null, setupFormula: "BREDD / 100", runTimePerUnit: "2.0000", runFormula: null,
    });
    const op30 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 30, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 0.5 });
    expect((await service.getTemplate(s.article.id)).operations.map((o) => o.sequenceNo)).toEqual([30, 40]);

    const updated = await service.updateOperation(s.article.id, op40.id, { description: "Montering", setupTime: 1, setupFormula: null });
    expect(updated).toMatchObject({ id: op40.id, description: "Montering", setupTime: "1.00", setupFormula: null });

    const line = await service.createBomLine(s.article.id, articleLine(s, { configuratorOperationId: op40.id }));
    expect(line.operationSequenceNo).toBe(40);

    await service.deleteOperation(s.article.id, op40.id);
    const t = await service.getTemplate(s.article.id);
    expect(t.operations.map((o) => o.id)).toEqual([op30.id]);
    expect(t.bomLines[0]).toMatchObject({ id: line.id, configuratorOperationId: null, operationSequenceNo: null });
    await expect(service.deleteOperation(s.article.id, op40.id)).rejects.toBeInstanceOf(ConfiguratorOperationNotFoundError);
    await expect(service.updateOperation(s.article.id, NO_ID, { description: "x" })).rejects.toBeInstanceOf(ConfiguratorOperationNotFoundError);
  });

  it("sets and clears the alternative's article; the template itself and an article containing it are refused", async () => {
    const s = await setup();
    const withArticle = await service.createValue(s.article.id, s.lock.id, { code: "B", name: "Lock B", priceAdd: 0, active: true, articleId: s.plat.id });
    expect(withArticle).toMatchObject({ articleId: s.plat.id, articleNumber: s.plat.articleNumber, articleName: "Plåt" });
    const t = await service.getTemplate(s.article.id);
    expect(t.groups[0]!.values.find((v) => v.id === withArticle.id)).toMatchObject({ articleId: s.plat.id, articleNumber: s.plat.articleNumber });

    const cleared = await service.updateValue(s.article.id, s.lock.id, withArticle.id, { articleId: null });
    expect(cleared).toMatchObject({ articleId: null, articleNumber: null, articleName: null });
    const set = await service.updateValue(s.article.id, s.lock.id, s.a.id, { articleId: s.hjulArt.id });
    expect(set).toMatchObject({ articleId: s.hjulArt.id, articleName: "Hjul" });

    const selfErr = await service.updateValue(s.article.id, s.lock.id, s.a.id, { articleId: s.article.id }).catch((e) => e);
    expect(selfErr).toBeInstanceOf(InvalidConfiguratorGroupError);
    expect(selfErr.message).toBe("Alternativets artikel kan inte innehålla mallen själv");

    const parent = await makeArticle();
    await testArticleService.addBomComponent(parent.id, { componentArticleId: s.article.id, quantity: 1 });
    const cycleErr = await service.createValue(s.article.id, s.lock.id, { code: "D", name: "D", priceAdd: 0, active: true, articleId: parent.id }).catch((e) => e);
    expect(cycleErr).toBeInstanceOf(InvalidConfiguratorGroupError);
    expect(cycleErr.message).toBe("Alternativets artikel kan inte innehålla mallen själv");

    await expect(service.updateValue(s.article.id, s.lock.id, s.a.id, { articleId: NO_ID })).rejects.toBeInstanceOf(ArticleNotFoundError);
    // Nothing above changed the stored link.
    expect((await service.getTemplate(s.article.id)).groups[0]!.values.find((v) => v.id === s.a.id)!.articleId).toBe(s.hjulArt.id);
  });

  it("loadDerivationInput reads the ordinary structure/route and the conditional rows with labels, without changing anything", async () => {
    const s = await setup();
    const bc = await testArticleService.addBomComponent(s.article.id, { componentArticleId: s.hjulArt.id, quantity: 4, routingOperationId: s.op10.id });
    const op40 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 1, runFormula: "BREDD / 100" });
    await service.createBomLine(s.article.id, articleLine(s, { configuratorOperationId: op40.id }));
    await service.createBomLine(s.article.id, { conditions: [], source: "group", componentGroupId: s.lock.id, quantityFormula: "BREDD / 1000" });

    const input = await service.loadDerivationInput(s.article.id);
    expect(input.detail.articleId).toBe(s.article.id);
    expect(input.baseBom).toEqual([{ id: bc.id, componentArticleId: s.hjulArt.id, quantity: 4, unitId: null, unitFactor: null, routingOperationId: s.op10.id }]);
    expect(input.baseOperations).toEqual([{ id: s.op10.id, sequenceNo: 10, workCenterId: s.wc.id, description: null, setupTime: 5, runTimePerUnit: 1, costingOnly: false, setupPrice: null, unitPrice: null }]);
    expect(input.lines.map((l) => l.label)).toEqual(["Strukturrad 1 (Plåt)", "Strukturrad 2 (Lock)"]);
    expect(input.lines[0]).toMatchObject({ source: "article", componentArticleId: s.plat.id, quantity: 2, quantityFormula: null, configuratorOperationId: op40.id });
    expect(input.lines[1]).toMatchObject({ source: "group", componentGroupId: s.lock.id, quantity: null, quantityFormula: "BREDD / 1000" });
    expect(input.operations).toEqual([{
      id: op40.id, sequenceNo: 40, conditions: [], workCenterId: s.wc.id, description: null, setupTime: 1, setupFormula: null,
      runTimePerUnit: null, runFormula: "BREDD / 100", setupPrice: null, unitPrice: null,
    }]);
    // The template's own structure and route are untouched.
    expect((await testArticleService.getBom(s.article.id)).length).toBe(1);
    expect((await mfgService.listRoutingOperations(s.article.id)).map((o) => o.sequenceNo)).toEqual([10]);
  });
});

describe("configurator lines and operations — save validation", () => {
  async function failure(p: Promise<unknown>): Promise<Error> {
    const e = await p.catch((err) => err);
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }

  it("conditions are checked like a rule's, with the line/operation as subject", async () => {
    const s = await setup();
    const other = await setup();
    let e = await failure(service.createBomLine(s.article.id, articleLine(s, { conditions: [{ groupId: other.hjul.id, op: "selected" }] })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Strukturraden pekar på en valgrupp som inte finns i konfiguratorn");
    e = await failure(service.createBomLine(s.article.id, articleLine(s, { conditions: [{ groupId: s.lock.id, op: "selected" }] })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Villkoret passar inte valgruppen Lock (listval)");
    e = await failure(service.createBomLine(s.article.id, articleLine(s, { conditions: [{ groupId: s.lock.id, op: "is", valueIds: [s.ep.id] }] })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Strukturraden pekar på ett alternativ som inte hör till valgruppen Lock");
    e = await failure(service.createOperation(s.article.id, {
      conditions: [{ groupId: other.hjul.id, op: "selected" }], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1,
    }));
    expect(e).toBeInstanceOf(InvalidConfiguratorOperationError);
    expect(e.message).toBe("Operationen pekar på en valgrupp som inte finns i konfiguratorn");
    expect(await countRows("configurator_bom_lines", s.article.id)).toBe(0);
    expect(await countRows("configurator_operations", s.article.id)).toBe(0);
  });

  it("Från val requires one of the template's own list groups", async () => {
    const s = await setup();
    const other = await setup();
    for (const groupId of [s.bredd.id, s.hjul.id, other.lock.id, NO_ID]) {
      const e = await failure(service.createBomLine(s.article.id, { conditions: [], source: "group", componentGroupId: groupId, quantity: 1 }));
      expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
      expect(e.message).toBe("Från val kräver ett listval i mallen");
    }
  });

  it("the component may not be the template nor contain it; an unknown article is 404", async () => {
    const s = await setup();
    let e = await failure(service.createBomLine(s.article.id, articleLine(s, { componentArticleId: s.article.id })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Komponenten kan inte innehålla mallen själv");
    const parent = await makeArticle();
    await testArticleService.addBomComponent(parent.id, { componentArticleId: s.article.id, quantity: 1 });
    e = await failure(service.createBomLine(s.article.id, articleLine(s, { componentArticleId: parent.id })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Komponenten kan inte innehålla mallen själv");
    await expect(service.createBomLine(s.article.id, articleLine(s, { componentArticleId: NO_ID }))).rejects.toBeInstanceOf(ArticleNotFoundError);
    // The same check on update.
    const line = await service.createBomLine(s.article.id, articleLine(s));
    e = await failure(service.updateBomLine(s.article.id, line.id, { componentArticleId: parent.id }));
    expect(e.message).toBe("Komponenten kan inte innehålla mallen själv");
  });

  it("operation links must belong to the template's route or its conditional operations", async () => {
    const s = await setup();
    const other = await setup();
    let e = await failure(service.createBomLine(s.article.id, articleLine(s, { routingOperationId: other.op10.id })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Operationen finns inte i mallens rutt");
    const otherOp = await service.createOperation(other.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    e = await failure(service.createBomLine(s.article.id, articleLine(s, { configuratorOperationId: otherOp.id })));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Operationen finns inte bland mallens villkorade operationer");
    const unknownWc = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: NO_ID, setupTime: 0, runTimePerUnit: 1 }));
    expect(unknownWc).toBeInstanceOf(WorkCenterNotFoundError);
    const inactive = await mfgService.createWorkCenter({ code: String(++wcSeq), name: "Avställd", type: "machine", hourlyRate: 0, overheadPercent: 0, capacityFactor: 1, active: false });
    const inactiveErr = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: inactive.id, setupTime: 0, runTimePerUnit: 1 }));
    expect(inactiveErr).toBeInstanceOf(InvalidConfiguratorOperationError);
    expect(inactiveErr.message).toBe("Resursen är inaktiv");
    const op = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    const switchErr = await failure(service.updateOperation(s.article.id, op.id, { workCenterId: inactive.id }));
    expect(switchErr.message).toBe("Resursen är inaktiv");
  });

  it("formulas are validated against the template's codes, with the field name first", async () => {
    const s = await setup();
    let e = await failure(service.createBomLine(s.article.id, { conditions: [], source: "article", componentArticleId: s.plat.id, quantityFormula: "LANGD / 1000" }));
    expect(e).toBeInstanceOf(InvalidConfiguratorFormulaError);
    expect(e.message).toBe("Antal: Okänd kod LANGD (tecken 1)");
    e = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupFormula: "BREDD +", runTimePerUnit: 1 }));
    expect(e).toBeInstanceOf(InvalidConfiguratorFormulaError);
    expect(e.message).toBe("Ställtid: Formeln slutar oväntat"); // the one formula error without a position
    e = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 1, runFormula: 'om(FARG = "XX"; 1; 2)' }));
    expect(e).toBeInstanceOf(InvalidConfiguratorFormulaError);
    expect(e.message).toBe('Stycktid: "XX" är inget alternativ i FARG (tecken 11)');
    // Valid formulas with a quoted alternative code and every group kind pass.
    const op = await service.createOperation(s.article.id, {
      conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupFormula: 'om(FARG = "EP"; 12; 8)', runFormula: "max(BREDD; 800) / 100 + HJUL",
    });
    expect(op.setupFormula).toBe('om(FARG = "EP"; 12; 8)');
  });

  it("an update validates the merged row: both or neither of quantity/formula, source fields, one link", async () => {
    const s = await setup();
    const line = await service.createBomLine(s.article.id, articleLine(s));
    let e = await failure(service.updateBomLine(s.article.id, line.id, { quantityFormula: "BREDD / 10" }));
    expect(e).toBeInstanceOf(InvalidConfiguratorLineError);
    expect(e.message).toBe("Ange antingen fast antal eller formel");
    e = await failure(service.updateBomLine(s.article.id, line.id, { quantity: null }));
    expect(e.message).toBe("Ange antingen fast antal eller formel");
    e = await failure(service.updateBomLine(s.article.id, line.id, { source: "group" }));
    expect(e.message).toBe("Ange valgrupp");
    e = await failure(service.updateBomLine(s.article.id, line.id, { componentGroupId: s.lock.id }));
    expect(e.message).toBe("Källan Artikel tar ingen grupp");
    const op40 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    await service.updateBomLine(s.article.id, line.id, { routingOperationId: s.op10.id });
    e = await failure(service.updateBomLine(s.article.id, line.id, { configuratorOperationId: op40.id }));
    expect(e.message).toBe("Högst en operationskoppling");
    // The intended switch sends both fields.
    const switched = await service.updateBomLine(s.article.id, line.id, { quantity: null, quantityFormula: "BREDD / 10", routingOperationId: null, configuratorOperationId: op40.id });
    expect(switched).toMatchObject({ quantity: null, quantityFormula: "BREDD / 10", routingOperationId: null, configuratorOperationId: op40.id, operationSequenceNo: 40 });
    const toGroup = await service.updateBomLine(s.article.id, line.id, { source: "group", componentArticleId: null, componentGroupId: s.lock.id });
    expect(toGroup).toMatchObject({ source: "group", componentArticleId: null, componentGroupId: s.lock.id, componentGroupCode: "LOCK" });

    e = await failure(service.updateOperation(s.article.id, op40.id, { setupFormula: "BREDD" }));
    expect(e).toBeInstanceOf(InvalidConfiguratorOperationError);
    expect(e.message).toBe("Ange antingen fast ställtid eller formel");
    e = await failure(service.updateOperation(s.article.id, op40.id, { runTimePerUnit: null }));
    expect(e.message).toBe("Ange antingen fast stycktid eller formel");
  });

  it("an operation number may not clash with the ordinary route or another conditional operation", async () => {
    const s = await setup();
    let e = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 10, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 }));
    expect(e).toBeInstanceOf(ConfiguratorSequenceTakenError);
    expect(e.message).toBe("Operationsnummer 10 används redan i rutten eller av en annan operation");
    const op40 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    e = await failure(service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 }));
    expect(e).toBeInstanceOf(ConfiguratorSequenceTakenError);
    expect(e.message).toBe("Operationsnummer 40 används redan i rutten eller av en annan operation");
    const op30 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 30, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    e = await failure(service.updateOperation(s.article.id, op30.id, { sequenceNo: 40 }));
    expect(e).toBeInstanceOf(ConfiguratorSequenceTakenError);
    e = await failure(service.updateOperation(s.article.id, op30.id, { sequenceNo: 10 }));
    expect(e).toBeInstanceOf(ConfiguratorSequenceTakenError);
    // Its own number, and a free one, are fine.
    expect((await service.updateOperation(s.article.id, op30.id, { sequenceNo: 30 })).sequenceNo).toBe(30);
    expect((await service.updateOperation(s.article.id, op30.id, { sequenceNo: 35 })).sequenceNo).toBe(35);
    expect((await service.getTemplate(s.article.id)).operations.map((o) => o.id)).toEqual([op30.id, op40.id]);
  });
});

describe("configurator lines and operations — reference guards", () => {
  it("deleting a group or alternative that a line or operation references is refused with the list", async () => {
    const s = await setup();
    await service.createRule(s.article.id, {
      effect: "exclude", conditions: [{ groupId: s.farg.id, op: "is", valueIds: [s.ep.id] }], target: { groupId: s.lock.id, valueIds: [s.c.id] },
      message: "Elpolerad finns inte med lock C", active: true,
    });
    await service.createBomLine(s.article.id, articleLine(s, { conditions: [{ groupId: s.farg.id, op: "is", valueIds: [s.ep.id] }] }));
    await service.createBomLine(s.article.id, { conditions: [], source: "group", componentGroupId: s.lock.id, quantity: 1 });
    await service.createOperation(s.article.id, { conditions: [{ groupId: s.hjul.id, op: "selected" }], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });

    const ep = await service.deleteValue(s.article.id, s.farg.id, s.ep.id).catch((e) => e);
    expect(ep).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((ep as ConfiguratorReferenceInUseError).references).toEqual(["Regel: Elpolerad finns inte med lock C", "Strukturrad 1"]);
    expect(ep.message).toBe("Används av: Regel: Elpolerad finns inte med lock C; Strukturrad 1");

    const lock = await service.deleteGroup(s.article.id, s.lock.id).catch((e) => e);
    expect(lock).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((lock as ConfiguratorReferenceInUseError).references).toEqual(["Regel: Elpolerad finns inte med lock C", "Strukturrad 2"]);

    const hjul = await service.deleteGroup(s.article.id, s.hjul.id).catch((e) => e);
    expect(hjul).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((hjul as ConfiguratorReferenceInUseError).references).toEqual(["Operation 40"]);

    // Unreferenced: fine.
    await service.deleteValue(s.article.id, s.lock.id, s.a.id);
    await service.deleteGroup(s.article.id, s.bredd.id);
    const t = await service.getTemplate(s.article.id);
    expect(t.groups.map((g) => g.code)).toEqual(["LOCK", "FARG", "HJUL"]);
  });

  it("a formula counts as a reference: deleting a group or alternative a formula spells is refused", async () => {
    const s = await setup();
    await service.createBomLine(s.article.id, { conditions: [], source: "article", componentArticleId: s.plat.id, quantityFormula: "BREDD / 1000" });
    await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupFormula: 'om(FARG = "EP"; 12; 8)', runTimePerUnit: 1 });
    // A literal "EP" compared against ANOTHER group is not a reference to FARG's EP.
    const lockEp = await service.createValue(s.article.id, s.lock.id, { code: "EP", name: "Lock EP", priceAdd: 0, active: true });
    await service.createOperation(s.article.id, { conditions: [], sequenceNo: 50, workCenterId: s.wc.id, setupTime: 0, runFormula: 'om(LOCK = "EP"; 1; 2)' });

    const bredd = await service.deleteGroup(s.article.id, s.bredd.id).catch((e) => e);
    expect(bredd).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((bredd as ConfiguratorReferenceInUseError).references).toEqual(["Strukturrad 1"]);
    const ep = await service.deleteValue(s.article.id, s.farg.id, s.ep.id).catch((e) => e);
    expect(ep).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((ep as ConfiguratorReferenceInUseError).references).toEqual(["Operation 40"]);
    const farg = await service.deleteGroup(s.article.id, s.farg.id).catch((e) => e);
    expect(farg).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((farg as ConfiguratorReferenceInUseError).references).toEqual(["Operation 40"]);
    // Deleting Lock's own EP is refused (LOCK = "EP"), but FARG's EP is untouched by that formula.
    await expect(service.deleteValue(s.article.id, s.lock.id, lockEp.id)).rejects.toBeInstanceOf(ConfiguratorReferenceInUseError);
    await service.deleteValue(s.article.id, s.lock.id, s.a.id);
    const t = await service.getTemplate(s.article.id);
    expect(t.groups.map((g) => g.code)).toEqual(["LOCK", "FARG", "BREDD", "HJUL"]);
    expect(t.bomLines.length + t.operations.length).toBe(3);
  });

  it("a code change is refused while a formula uses the code (group code, or a quoted alternative code)", async () => {
    const s = await setup();
    await service.createBomLine(s.article.id, { conditions: [], source: "article", componentArticleId: s.plat.id, quantityFormula: "BREDD / 1000" });
    await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupFormula: 'om(FARG = "EP"; 12; 8)', runTimePerUnit: 1 });
    await service.createOperation(s.article.id, { conditions: [], sequenceNo: 50, workCenterId: s.wc.id, setupTime: 1, runFormula: "bredd * 2" });

    const bredd = await service.updateGroup(s.article.id, s.bredd.id, { code: "LANGD" }).catch((e) => e);
    expect(bredd).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((bredd as ConfiguratorReferenceInUseError).references).toEqual(["Strukturrad 1", "Operation 50"]);

    const farg = await service.updateGroup(s.article.id, s.farg.id, { code: "YTA" }).catch((e) => e);
    expect(farg).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((farg as ConfiguratorReferenceInUseError).references).toEqual(["Operation 40"]);

    const ep = await service.updateValue(s.article.id, s.farg.id, s.ep.id, { code: "EL" }).catch((e) => e);
    expect(ep).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((ep as ConfiguratorReferenceInUseError).references).toEqual(["Operation 40"]);

    // Same code, a name change, and an unreferenced code are fine.
    expect((await service.updateGroup(s.article.id, s.bredd.id, { code: "BREDD", name: "Bredd (mm)" })).name).toBe("Bredd (mm)");
    expect((await service.updateValue(s.article.id, s.farg.id, s.ep.id, { name: "Elpolerad yta" })).name).toBe("Elpolerad yta");
    expect((await service.updateGroup(s.article.id, s.hjul.id, { code: "HJUL2" })).code).toBe("HJUL2");
    expect((await service.updateValue(s.article.id, s.lock.id, s.a.id, { code: "A2" })).code).toBe("A2");
    const t = await service.getTemplate(s.article.id);
    expect(t.groups.map((g) => g.code)).toEqual(["LOCK", "FARG", "BREDD", "HJUL2"]);
  });

  it("removing the template's ordinary operation in Beredning clears the link", async () => {
    const s = await setup();
    const line = await service.createBomLine(s.article.id, articleLine(s, { routingOperationId: s.op10.id }));
    await mfgService.removeRoutingOperation(s.article.id, s.op10.id);
    const t = await service.getTemplate(s.article.id);
    expect(t.bomLines[0]).toMatchObject({ id: line.id, routingOperationId: null, operationSequenceNo: null });
  });

  // Same deterministic interleaving as delprojekt 1's rule test: an outer
  // transaction holds the template lock and deletes the group; the line save
  // waits and must validate against the template AFTER that commit.
  it("a line save waits for the template lock and validates against the template after it", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM configurator_templates WHERE article_id = ${s.article.id} FOR UPDATE`);
      signalLocked();
      await gate;
      await tx.execute(sql`DELETE FROM configurator_groups WHERE id = ${s.farg.id}`);
    });
    await locked;
    let save: Promise<unknown>;
    try {
      save = Promise.resolve()
        .then(() => service.createBomLine(s.article.id, articleLine(s, { conditions: [{ groupId: s.farg.id, op: "is", valueIds: [s.ep.id] }] })))
        .then(() => "stored", (e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      release(); // never leave the template lock held — the next TRUNCATE would hang
      await holder;
    }
    expect(await save).toBeInstanceOf(InvalidConfiguratorLineError);
    expect((await service.getTemplate(s.article.id)).bomLines).toEqual([]);
  });

  it("deleting the template takes its lines and operations with it", async () => {
    const s = await setup();
    const op40 = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 40, workCenterId: s.wc.id, setupTime: 0, runTimePerUnit: 1 });
    await service.createBomLine(s.article.id, { conditions: [], source: "group", componentGroupId: s.lock.id, quantity: 1, configuratorOperationId: op40.id });
    await service.createBomLine(s.article.id, articleLine(s, { routingOperationId: s.op10.id }));
    await service.deleteTemplate(s.article.id);
    expect(await countRows("configurator_bom_lines", s.article.id)).toBe(0);
    expect(await countRows("configurator_operations", s.article.id)).toBe(0);
    // The ordinary route and the component articles survive.
    expect((await mfgService.listRoutingOperations(s.article.id)).map((o) => o.sequenceNo)).toEqual([10]);
    expect(await testArticleService.getArticle(s.plat.id)).toBeTruthy();
  });
});

describe("getTemplate — täckningsvarning", () => {
  it("lists an alternative that a family of lines leaves uncovered, and drops it once the line exists", async () => {
    const s = await setup();
    const isLock = (valueId: string) => ({ groupId: s.lock.id, op: "is" as const, valueIds: [valueId] });
    await service.createBomLine(s.article.id, articleLine(s, { conditions: [isLock(s.a.id)] }));
    await service.createBomLine(s.article.id, articleLine(s, { conditions: [isLock(s.c.id)] }));
    expect((await service.getTemplate(s.article.id)).structureWarnings).toEqual([]);

    const b = await service.createValue(s.article.id, s.lock.id, { code: "B", name: "Lock B", priceAdd: 0, active: true });
    expect((await service.getTemplate(s.article.id)).structureWarnings).toEqual([
      "Lock: alternativet Lock B saknar strukturrad — strukturrad 1 och 2 täcker de övriga alternativen",
    ]);

    await service.createBomLine(s.article.id, articleLine(s, { conditions: [isLock(b.id)] }));
    expect((await service.getTemplate(s.article.id)).structureWarnings).toEqual([]);
  });
});

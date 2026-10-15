import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  articleStandardCostHistory,
  articleUnits,
  articles,
  bomComponents,
  db,
  routingOperationFiles,
  routingOperations,
  units,
  workCenters,
} from "@navet/db";
import { createArticleSchema, type CreateArticleInput } from "@navet/shared";
import { insertArticle } from "../src/modules/article/repository/article.repository.js";
import { insertBomRows } from "../src/modules/article/repository/bom-write.js";
import { copyRouting, insertRoutingOperations } from "../src/modules/manufacturing/repository/routing-write.js";

// The Tx leaves the configurator's variant creation composes into ONE
// transaction (Konfigurator delprojekt 3): insertArticle (the body of the
// repository's create), insertBomRows, insertRoutingOperations and
// copyRouting. Kopiera från's Beredning is built from the same leaves, so
// article-copy.test.ts is the regression guard for that path.

const RESET = sql`TRUNCATE routing_operation_files, bom_components, routing_operations, work_centers,
  article_units, article_standard_cost_history, articles, units CASCADE`;

beforeEach(async () => {
  await db.execute(RESET);
});
afterAll(async () => {
  await db.execute(RESET);
});

const parse = (input: Record<string, unknown>) => createArticleSchema.parse(input) as CreateArticleInput;

async function seed() {
  const [st, kg] = await db
    .insert(units)
    .values([{ code: "st", name: "Styck" }, { code: "kg", name: "Kilogram" }])
    .returning();
  const [wc] = await db.insert(workCenters).values({ code: "100", name: "Kap" }).returning();
  const [parent, comp] = await db
    .insert(articles)
    .values([
      { articleNumber: "P-1", name: "Förälder", type: "manufactured", unitId: st!.id },
      { articleNumber: "C-1", name: "Komponent", type: "purchased", unitId: st!.id },
    ])
    .returning();
  return { stId: st!.id, kgId: kg!.id, wcId: wc!.id, parent: parent!, comp: comp! };
}

describe("insertRoutingOperations", () => {
  it("inserts the rows with all columns and maps sequence number to id", async () => {
    const { wcId, parent } = await seed();
    const map = await db.transaction((tx) =>
      insertRoutingOperations(tx, parent.id, [
        {
          sequenceNo: 10,
          description: "Kapning",
          workCenterId: wcId,
          setupTime: "15.00",
          runTimePerUnit: "1.2500",
          comment: "Grada kanterna",
          costingOnly: true,
          printOnWorkCard: true,
        },
        {
          sequenceNo: 20,
          description: "Svetsning",
          workCenterId: wcId,
          setupTime: "5.00",
          runTimePerUnit: "0.1667",
          timeUnit: "units_per_hour",
        },
      ])
    );
    expect([...map.keys()].sort()).toEqual([10, 20]);

    const rows = await db
      .select()
      .from(routingOperations)
      .where(eq(routingOperations.articleId, parent.id))
      .orderBy(asc(routingOperations.sequenceNo));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(map.get(10));
    expect(rows[1]!.id).toBe(map.get(20));
    expect(rows[0]).toMatchObject({
      description: "Kapning",
      setupTime: "15.00",
      runTimePerUnit: "1.2500",
      comment: "Grada kanterna",
      costingOnly: true,
      printOnWorkCard: true,
      timeUnit: "minutes_per_unit",
    });
    expect(rows[1]).toMatchObject({
      description: "Svetsning",
      runTimePerUnit: "0.1667",
      timeUnit: "units_per_hour",
      costingOnly: false,
      comment: null,
    });
  });

  it("returns an empty map and writes nothing for []", async () => {
    const { parent } = await seed();
    const map = await db.transaction((tx) => insertRoutingOperations(tx, parent.id, []));
    expect(map.size).toBe(0);
    expect(await db.select().from(routingOperations)).toHaveLength(0);
  });
});

describe("insertBomRows", () => {
  it("writes rows whose operation link points at the given operation id", async () => {
    const { wcId, kgId, parent, comp } = await seed();
    await db.transaction(async (tx) => {
      const ops = await insertRoutingOperations(tx, parent.id, [
        { sequenceNo: 20, workCenterId: wcId, setupTime: "0.00", runTimePerUnit: "1.0000" },
      ]);
      await insertBomRows(tx, parent.id, [
        {
          componentArticleId: comp.id,
          quantity: 2.5,
          unitId: kgId,
          unitFactor: "5.000000",
          routingOperationId: ops.get(20)!,
        },
      ]);
    });
    const [opRow] = await db.select().from(routingOperations);
    const rows = await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, parent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      componentArticleId: comp.id,
      quantity: "2.5000",
      unitId: kgId,
      unitFactor: "5.000000",
      routingOperationId: opRow!.id,
    });
  });

  it("is a no-op on []", async () => {
    const { parent } = await seed();
    await db.transaction((tx) => insertBomRows(tx, parent.id, []));
    expect(await db.select().from(bomComponents)).toHaveLength(0);
  });
});

describe("copyRouting", () => {
  it("copies the operations with their routing_operation_files and returns old → new ids", async () => {
    const { wcId, parent, comp, stId } = await seed();
    const [target] = await db
      .insert(articles)
      .values({ articleNumber: "P-2", name: "Mål", type: "manufactured", unitId: stId })
      .returning();
    const [op10, op20] = await db
      .insert(routingOperations)
      .values([
        { articleId: parent.id, sequenceNo: 10, workCenterId: wcId, setupTime: "1.00", runTimePerUnit: "1.0000" },
        {
          articleId: parent.id,
          sequenceNo: 20,
          description: "Lego",
          workCenterId: wcId,
          setupTime: "2.00",
          runTimePerUnit: "0.5000",
          useArticleDrawing: false,
        },
      ])
      .returning();
    await db.insert(routingOperationFiles).values({
      routingOperationId: op20!.id,
      filename: "op20.pdf",
      contentType: "application/pdf",
      sizeBytes: 7,
      data: Buffer.from("op-file"),
    });
    // Irrelevant to the routing copy — must stay untouched.
    await db.insert(bomComponents).values({ parentArticleId: parent.id, componentArticleId: comp.id, quantity: "1.0000" });

    const map = await db.transaction((tx) => copyRouting(tx, parent.id, target!.id));

    const copied = await db
      .select()
      .from(routingOperations)
      .where(eq(routingOperations.articleId, target!.id))
      .orderBy(asc(routingOperations.sequenceNo));
    expect(copied).toHaveLength(2);
    expect(map.size).toBe(2);
    expect(map.get(op10!.id)).toBe(copied[0]!.id);
    expect(map.get(op20!.id)).toBe(copied[1]!.id);
    expect(copied[1]).toMatchObject({ description: "Lego", setupTime: "2.00", useArticleDrawing: false });

    const files = await db.select().from(routingOperationFiles).orderBy(asc(routingOperationFiles.createdAt));
    expect(files).toHaveLength(2);
    const copiedFile = files.find((f) => f.routingOperationId === copied[1]!.id);
    expect(copiedFile).toBeDefined();
    expect(copiedFile!.filename).toBe("op20.pdf");
    expect(Buffer.from(copiedFile!.data).toString()).toBe("op-file");

    // The source's own rows are intact and the target got no BOM.
    expect(await db.select().from(routingOperations).where(eq(routingOperations.articleId, parent.id))).toHaveLength(2);
    expect(await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, target!.id))).toHaveLength(0);
  });
});

describe("insertArticle", () => {
  it("copies Information incl. alternative units when the base unit matches and writes the cost history", async () => {
    const { stId, kgId, parent } = await seed();
    await db.insert(articleUnits).values({ articleId: parent.id, unitId: kgId, quantityPerBase: "5.000000" });
    await db
      .update(articles)
      .set({ purchaseUnitId: kgId, weight: "1.234", colour: "RAL 9005" })
      .where(eq(articles.id, parent.id));

    const row = await db.transaction(
      (tx) =>
        insertArticle(tx, {
          ...parse({
            articleNumber: "V-1",
            name: "Variant",
            type: "manufactured",
            unitId: stId,
            standardCost: 12.5,
            copyFrom: { articleId: parent.id, parts: ["information"] },
          }),
          unitId: stId,
        }),
      { isolationLevel: "repeatable read" }
    );
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      articleNumber: "V-1",
      standardCost: "12.5000",
      weight: "1.234",
      colour: "RAL 9005",
      purchaseUnitId: kgId,
    });

    const altUnits = await db.select().from(articleUnits).where(eq(articleUnits.articleId, row!.id));
    expect(altUnits).toHaveLength(1);
    expect(altUnits[0]).toMatchObject({ unitId: kgId, quantityPerBase: "5.000000" });

    const history = await db
      .select()
      .from(articleStandardCostHistory)
      .where(eq(articleStandardCostHistory.articleId, row!.id));
    expect(history).toHaveLength(1);
    expect(history[0]!.cost).toBe("12.5000");
  });

  it("returns null when the copy source does not exist", async () => {
    const { stId } = await seed();
    const row = await db.transaction((tx) =>
      insertArticle(tx, {
        ...parse({
          articleNumber: "V-2",
          name: "Variant",
          type: "manufactured",
          unitId: stId,
          copyFrom: { articleId: "00000000-0000-0000-0000-000000000000", parts: ["information"] },
        }),
        unitId: stId,
      })
    );
    expect(row).toBeNull();
    expect(await db.select().from(articles).where(eq(articles.articleNumber, "V-2"))).toHaveLength(0);
  });

  it("leaves no article behind when the surrounding transaction fails afterwards", async () => {
    const { stId } = await seed();
    await expect(
      db.transaction(async (tx) => {
        const row = await insertArticle(tx, {
          ...parse({ articleNumber: "V-3", name: "Variant", type: "manufactured", unitId: stId, standardCost: 1 }),
          unitId: stId,
        });
        expect(row).not.toBeNull();
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await db.select().from(articles).where(eq(articles.articleNumber, "V-3"))).toHaveLength(0);
    expect(await db.select().from(articleStandardCostHistory)).toHaveLength(0);
  });
});

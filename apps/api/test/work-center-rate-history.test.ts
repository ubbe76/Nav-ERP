import { createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db, workCenterRateHistory, workCenters } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { planWorkCenterImport } from "../src/modules/import/service/work-centers.js";
import { overlappingTransactions } from "./helpers/overlapping-transactions.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Timkostnad per datum (#14 etapp 4, migration 0189): the resource's hourly
// rate gets its history from a trigger, so every writer records it — the
// manufacturing service (the card and the list's inline edit), the resource
// import and a plain SQL UPDATE alike. One row per transaction that changes
// the value, as 0169's försäljningspris.

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const importRepo = createImportRepository(db);

const TRUNCATE = sql`TRUNCATE work_centers, production_groups CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function history(workCenterId: string) {
  return db
    .select({ hourlyRate: workCenterRateHistory.hourlyRate, validFrom: workCenterRateHistory.validFrom })
    .from(workCenterRateHistory)
    .where(eq(workCenterRateHistory.workCenterId, workCenterId))
    .orderBy(asc(workCenterRateHistory.validFrom), asc(workCenterRateHistory.id));
}

describe("work_center_rate_history — the trigger", () => {
  it("records the rate at creation and every change, from any writer", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, overheadPercent: 20, active: true }));
    await mfgService.updateWorkCenter(wc.id, { hourlyRate: 550 });
    // A writer the application does not know about.
    await db.update(workCenters).set({ hourlyRate: "600" }).where(eq(workCenters.id, wc.id));

    expect((await history(wc.id)).map((r) => r.hourlyRate)).toEqual(["500.00", "550.00", "600.00"]);
  });

  it("records nothing when the rate did not change", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, active: true }));
    await mfgService.updateWorkCenter(wc.id, { hourlyRate: 500 });
    await mfgService.updateWorkCenter(wc.id, { name: "Svetsstation", overheadPercent: 30 });
    // The TO percentage has no history of its own.
    expect((await history(wc.id)).map((r) => r.hourlyRate)).toEqual(["500.00"]);
  });

  it("keeps one row per transaction, and none when the transaction ends where it began", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, active: true }));
    await db.transaction(async (tx) => {
      await tx.update(workCenters).set({ hourlyRate: "550" }).where(eq(workCenters.id, wc.id));
      await tx.update(workCenters).set({ hourlyRate: "575" }).where(eq(workCenters.id, wc.id));
    });
    await db.transaction(async (tx) => {
      await tx.update(workCenters).set({ hourlyRate: "650" }).where(eq(workCenters.id, wc.id));
      await tx.update(workCenters).set({ hourlyRate: "575" }).where(eq(workCenters.id, wc.id));
    });
    expect((await history(wc.id)).map((r) => r.hourlyRate)).toEqual(["500.00", "575.00"]);
  });

  // Migration 0190: valid_from = now() is the transaction's start. T1 begins,
  // T2 begins later, sets 700 and commits, then T1 sets 600 — the latest row
  // must be 600, as on the resource, not T2's 700.
  it("orders overlapping transactions by when they changed the rate, not when they began", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, active: true }));
    await overlappingTransactions(
      async (tx) => {
        await tx.update(workCenters).set({ hourlyRate: "600" }).where(eq(workCenters.id, wc.id));
      },
      () => mfgService.updateWorkCenter(wc.id, { hourlyRate: 700 }).then(() => undefined)
    );

    const rows = await history(wc.id);
    expect(rows.map((r) => r.hourlyRate)).toEqual(["500.00", "700.00", "600.00"]);
    // Distinct instants (JS dates drop the microsecond), so the order is valid_from's alone.
    const [{ instants }] = (await db.execute(
      sql`select count(distinct valid_from)::int as instants from work_center_rate_history where work_center_id = ${wc.id}`
    )) as unknown as [{ instants: number }];
    expect(instants).toBe(3);
    const [current] = await db.select({ hourlyRate: workCenters.hourlyRate }).from(workCenters).where(eq(workCenters.id, wc.id));
    expect(current!.hourlyRate).toBe("600.00");
  });

  it("still replaces its own row on a second change after an overlapping commit", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, active: true }));
    await overlappingTransactions(
      async (tx) => {
        // Both after T2's row: the own row lies after now() and is still found.
        await tx.update(workCenters).set({ hourlyRate: "600" }).where(eq(workCenters.id, wc.id));
        await tx.update(workCenters).set({ hourlyRate: "650" }).where(eq(workCenters.id, wc.id));
      },
      () => mfgService.updateWorkCenter(wc.id, { hourlyRate: 700 }).then(() => undefined)
    );
    expect((await history(wc.id)).map((r) => r.hourlyRate)).toEqual(["500.00", "700.00", "650.00"]);
  });

  it("goes with a deleted resource", async () => {
    const wc = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 500, active: true }));
    await db.delete(workCenters).where(eq(workCenters.id, wc.id));
    expect(await history(wc.id)).toEqual([]);
  });

  it("is written by the resource import, for a new resource and a changed rate", async () => {
    const mapping = { "Prod.grupp": "code", Namn: "name", Typ: "type", "Aktuell, STD": "hourlyRate" };
    const created = await planWorkCenterImport({ mapping, rows: [["120", "Kapning", "Maskin", "375"]] }, importRepo);
    expect(created.hasErrors).toBe(false);
    await importRepo.executeWorkCenterPlan(created);
    const [wc] = await db.select().from(workCenters).where(eq(workCenters.code, "120"));

    // A second file with a new rate updates the resource — and its history;
    // the same rate again writes nothing.
    for (const rate of ["410", "410"]) {
      const update = await planWorkCenterImport({ mapping, rows: [["120", "Kapning", "Maskin", rate]] }, importRepo);
      expect(update.updates).toHaveLength(1);
      await importRepo.executeWorkCenterPlan(update);
    }

    expect((await history(wc!.id)).map((r) => r.hourlyRate)).toEqual(["375.00", "410.00"]);
  });
});

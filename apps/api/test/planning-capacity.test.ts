import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { isoWeekOf, isoWeekRange } from "../src/modules/timereport/service/schedule.service.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  }
);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});
// getCapacity never touches the order creators — minimal fakes.
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: {
    createManufacturingOrder: async () => {
      throw new Error("not used");
    },
  },
});

const TRUNCATE = sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// The service anchors "today" in Europe/Stockholm — the test derives the same
// date the same way so week arithmetic matches whenever the suite runs.
const stockholmToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
const thisWeek = isoWeekOf(stockholmToday);
const thisMonday = isoWeekRange(thisWeek.isoYear, thisWeek.isoWeek).monday;
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// The current week's SUNDAY: always >= today whatever weekday the suite runs
// on, so the seeded order is never overdue (a Wednesday here went red every
// Thu-Sun run — date-dependent flake found by the F-block baseline).
const thisWeekDueDate = addDays(thisMonday, 6);
const nextWednesday = addDays(thisMonday, 9);

async function makeUser() {
  return authRepo.create({
    email: `capacity-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planner",
    role: "user",
  });
}

async function seedCapacityWorld() {
  const user = await makeUser();

  // 480-minute day, Mon–Fri week schedule; a full-off holiday NEXT Wednesday.
  const day = await scheduleService.createDaySchedule({
    code: "D8",
    name: "Dagtid 8h",
    startTime: "07:00",
    endTime: "15:00",
    breaks: [],
    active: true,
  });
  const week = await scheduleService.createWeekSchedule({
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  });
  await scheduleService.createHoliday({ date: nextWednesday, name: "Testhelgdag", dayScheduleId: null });

  const group = await mfgService.createProductionGroup({ code: "10", name: "Svets", active: true });
  const scheduled = await mfgService.createWorkCenter({
    code: "101",
    name: "Svets A",
    productionGroupId: group.id,
    weekScheduleId: week.id,
    capacityFactor: 2,
    active: true,
  });
  const unscheduled = await mfgService.createWorkCenter({ code: "102", name: "Manuell", active: true });

  const article = await articleService.createArticle({
    articleNumber: `CAP-${crypto.randomUUID().slice(0, 8)}`,
    name: "Kapacitetsartikel",
    type: "manufactured",
    active: true,
  });
  await mfgService.createRoutingOperation(article.id, {
    sequenceNo: 10,
    workCenterId: scheduled.id,
    setupTime: 60,
    runTimePerUnit: 6,
  });
  await mfgService.createRoutingOperation(article.id, {
    sequenceNo: 20,
    workCenterId: unscheduled.id,
    runTimePerUnit: 12,
    setupTime: 0,
  });

  // Released with due date this Sunday, released undated, and an older
  // planned order that must NOT appear (no operations until release).
  const dated = await mfgService.createManufacturingOrder(
    { articleId: article.id, quantity: 10, dueDate: thisWeekDueDate },
    user.id
  );
  const undated = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, user.id);
  await insertPlannedManufacturingOrder({ articleId: article.id, quantity: 100, createdBy: user.id });

  return { group, scheduled, unscheduled, dated, undated };
}

describe("planning service — getCapacity", () => {
  it("builds the load/capacity matrix from released orders, schedules and holidays", async () => {
    const world = await seedCapacityWorld();

    const result = await planningService.getCapacity({ weeks: 2 });

    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0]).toMatchObject({ ...thisWeek, monday: thisMonday });

    expect(result.groups.map((g) => g.name)).toEqual(["Svets", "Ogrupperade resurser"]);
    const svets = result.groups[0]!;
    const a = svets.resources.find((r) => r.workCenterId === world.scheduled.id)!;
    // Load this week: setup 60 + 6×10 = 120 min = 2 h on the dated order.
    expect(a.weeks[0]!.loadHours).toBe(2);
    // Capacity: 40 h × factor 2 = 80 this week; next week loses the holiday day (32 × 2).
    expect(a.weeks[0]!.availableHours).toBe(80);
    expect(a.weeks[1]!.availableHours).toBe(64);
    expect(a.weeks[0]!.loadPercent).toBe(3); // 2/80 = 2.5 % → 3
    // Undated order: setup 60 + 6×5 = 90 min = 1.5 h.
    expect(a.undated.loadHours).toBe(1.5);
    expect(a.weeks[0]!.orders[0]).toMatchObject({
      orderNumber: world.dated.orderNumber,
      overdue: false,
      dueDate: thisWeekDueDate,
    });

    const b = result.groups[1]!.resources.find((r) => r.workCenterId === world.unscheduled.id)!;
    expect(b.hasSchedule).toBe(false);
    expect(b.weeks[0]!.loadHours).toBe(2); // 12×10 = 120 min
    expect(b.weeks[0]!.availableHours).toBeNull();
    expect(b.undated.loadHours).toBe(1); // 12×5 = 60 min
    // The planned order's 100 units appear nowhere:
    const allOrders = [a, b].flatMap((r) => [...r.weeks, r.later, r.undated]).flatMap((c) => c.orders);
    expect(allOrders.every((o) => [world.dated.id, world.undated.id].includes(o.manufacturingOrderId))).toBe(true);
  });

  it("respects the weeks parameter and the production group filter", async () => {
    const world = await seedCapacityWorld();

    const oneWeek = await planningService.getCapacity({ weeks: 1 });
    expect(oneWeek.weeks).toHaveLength(1);

    const filtered = await planningService.getCapacity({ weeks: 2, productionGroupId: world.group.id });
    expect(filtered.groups).toHaveLength(1);
    expect(filtered.groups[0]!.name).toBe("Svets");
  });
});

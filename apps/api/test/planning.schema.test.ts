import { describe, expect, it } from "vitest";
import {
  capacityQuerySchema,
  createManufacturingOrderSchema,
  createPlanningOrdersSchema,
  createWorkCenterSchema,
  listRequirementsQuerySchema,
  updateManufacturingOrderSchema,
  updateWorkCenterSchema,
} from "@navet/shared";

const ARTICLE_ID = "5b3f2a10-0000-4000-8000-000000000001";
const ROW_ID = "5b3f2a10-0000-4000-8000-000000000002";

// Konfigurator 4c: a configured proposal is keyed by its KO row, like a
// subcontract proposal by its operation.
describe("createPlanningOrdersSchema — configured proposals", () => {
  it("requires salesOrderRowId for kind configured", () => {
    const result = createPlanningOrdersSchema.safeParse({
      proposals: [{ articleId: ARTICLE_ID, quantity: 2, kind: "configured" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("proposals.0.salesOrderRowId");
    }
  });

  it("accepts a configured proposal with its row id", () => {
    const parsed = createPlanningOrdersSchema.parse({
      proposals: [{ articleId: ARTICLE_ID, quantity: "2", kind: "configured", salesOrderRowId: ROW_ID }],
    });
    expect(parsed.proposals[0]).toEqual({ articleId: ARTICLE_ID, quantity: 2, kind: "configured", salesOrderRowId: ROW_ID });
  });

  it("still lets purchase/manufacture proposals omit both keys", () => {
    expect(createPlanningOrdersSchema.safeParse({ proposals: [{ articleId: ARTICLE_ID, quantity: 1, kind: "manufacture" }] }).success).toBe(true);
  });
});

// Pure schema tests — no database. The showAll param arrives as a STRING from
// the query string; z.coerce.boolean() would turn "false" into true (the exact
// trap the codebase bans — see listStockLocationsQuerySchema's comment).
describe("listRequirementsQuerySchema", () => {
  it('parses showAll "true" as true and "false" as false', () => {
    expect(listRequirementsQuerySchema.parse({ showAll: "true" }).showAll).toBe(true);
    expect(listRequirementsQuerySchema.parse({ showAll: "false" }).showAll).toBe(false);
  });

  it("defaults showAll to false when absent", () => {
    expect(listRequirementsQuerySchema.parse({}).showAll).toBe(false);
  });
});

describe("capacityQuerySchema (E2)", () => {
  it("defaults weeks to 8 and caps it at 26", () => {
    expect(capacityQuerySchema.parse({}).weeks).toBe(8);
    expect(capacityQuerySchema.parse({ weeks: "13" }).weeks).toBe(13);
    expect(() => capacityQuerySchema.parse({ weeks: "27" })).toThrow();
    expect(() => capacityQuerySchema.parse({ weeks: "0" })).toThrow();
  });

  it("accepts an optional production group filter", () => {
    const id = "5b3f2a10-0000-4000-8000-000000000001";
    expect(capacityQuerySchema.parse({ productionGroupId: id }).productionGroupId).toBe(id);
  });
});

describe("work center capacity fields (E2)", () => {
  it("create defaults capacityFactor to 1 and accepts a nullable week schedule", () => {
    const parsed = createWorkCenterSchema.parse({ code: "101", name: "Svets" });
    expect(parsed.capacityFactor).toBe(1);
    expect(parsed.weekScheduleId).toBeUndefined();
    const withSchedule = createWorkCenterSchema.parse({
      code: "101",
      name: "Svets",
      weekScheduleId: "5b3f2a10-0000-4000-8000-000000000001",
      capacityFactor: "2.5",
    });
    expect(withSchedule.capacityFactor).toBe(2.5);
  });

  it("rejects a non-positive capacity factor and allows null to clear the schedule on update", () => {
    expect(() => createWorkCenterSchema.parse({ code: "101", name: "X", capacityFactor: 0 })).toThrow();
    expect(updateWorkCenterSchema.parse({ weekScheduleId: null }).weekScheduleId).toBeNull();
  });
});

describe("manufacturing order due date (E2)", () => {
  it("accepts an optional due date on create and rejects malformed dates", () => {
    expect(
      createManufacturingOrderSchema.parse({ articleId: "5b3f2a10-0000-4000-8000-000000000001", quantity: 5, dueDate: "2026-09-01" }).dueDate
    ).toBe("2026-09-01");
    expect(() =>
      createManufacturingOrderSchema.parse({ articleId: "5b3f2a10-0000-4000-8000-000000000001", quantity: 5, dueDate: "nyss" })
    ).toThrow();
  });

  it("update schema sets or clears the due date", () => {
    expect(updateManufacturingOrderSchema.parse({ dueDate: "2026-09-01" }).dueDate).toBe("2026-09-01");
    expect(updateManufacturingOrderSchema.parse({ dueDate: null }).dueDate).toBeNull();
  });
});

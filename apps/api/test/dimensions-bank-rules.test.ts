import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, costCenters, projects } from "@navet/db";
import { ProjectClosedError } from "../src/modules/economy/service/dimension-check.js";
import { buildBankReconciliationService, resetBankSettings, resetBanking, setupBanking } from "./helpers/banking.js";

// Bankregler with kostnadsställen och projekt: the rule carries the objects,
// the view labels them, a new choice is held to the dimension rule and a
// kept one may stay closed.

const service = buildBankReconciliationService();
let userId: string;

beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  await db.delete(costCenters);
  await db.delete(projects);
  userId = (await setupBanking()).user.id;
});
afterAll(async () => {
  await resetBankSettings();
  await resetBanking();
  await db.delete(costCenters);
  await db.delete(projects);
});

describe("bank rules", () => {
  it("stores the objects, labels them in the view and refuses a closed project on a new choice", async () => {
    const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
    const [project] = await db.insert(projects).values({ code: "P1", name: "Storköket" }).returning();
    const [closed] = await db.insert(projects).values({ code: "P9", name: "Klart", status: "closed" }).returning();

    const rule = await service.createRule({ textContains: "hyra", direction: "out", accountNumber: "5010", autoBook: false, active: true, costCenterId: workshop!.id }, userId);
    expect(rule).toMatchObject({ costCenterId: workshop!.id, projectId: null, costCenter: { id: workshop!.id, code: "100", name: "Verkstad" }, project: null });
    await expect(
      service.createRule({ textContains: "x", direction: "out", accountNumber: "5010", autoBook: false, active: true, projectId: closed!.id }, userId)
    ).rejects.toBeInstanceOf(ProjectClosedError);

    const updated = await service.updateRule(rule.id, { projectId: project!.id }, userId);
    expect(updated.project).toEqual({ id: project!.id, code: "P1", name: "Storköket" });
    expect(updated.costCenterId).toBe(workshop!.id);
    const cleared = await service.updateRule(rule.id, { costCenterId: null }, userId);
    expect(cleared.costCenter).toBeNull();
    expect(cleared.projectId).toBe(project!.id);

    // The project closes after the fact: a PATCH of something else keeps it.
    await db.update(projects).set({ status: "closed" });
    const kept = await service.updateRule(rule.id, { description: "Hyra" }, userId);
    expect(kept.projectId).toBe(project!.id);
    const listed = await service.listRules({ seed: false });
    expect(listed.rows.find((r) => r.id === rule.id)!.project!.code).toBe("P1");
  });
});

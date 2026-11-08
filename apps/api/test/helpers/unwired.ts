import type { SalesOrderLinkReader } from "../../src/modules/manufacturing/service/manufacturing.service";
import type { ArticleSelfCostReader } from "../../src/modules/reports/service/reports.service";

// Required dependencies a test's service never reaches. A factory call that
// leaves one out type-checks only with a cast and fails with "undefined is
// not a function" the day a test does reach it; these fail with the name of
// what is missing instead. Wire the real reader when a test needs it.
function unwired(name: string): never {
  throw new Error(`${name} is not wired in this test`);
}

// Manufacturing ↔ sales-order link (KO-rad → TO). Tests that never create a
// TO from a sales-order row pass this.
export const unwiredSalesOrderLinks: SalesOrderLinkReader = {
  findRowForManufacturing: () => unwired("SalesOrderLinkReader.findRowForManufacturing"),
  lockRowForManufacturing: () => unwired("SalesOrderLinkReader.lockRowForManufacturing"),
  markInProduction: () => unwired("SalesOrderLinkReader.markInProduction"),
};

// Reports' self-cost reader (the costing service in app.ts). Tests of reports
// that never read a self cost pass this.
export const unwiredSelfCosts: ArticleSelfCostReader = {
  latestPreCalculationSelfCost: () => unwired("ArticleSelfCostReader.latestPreCalculationSelfCost"),
};

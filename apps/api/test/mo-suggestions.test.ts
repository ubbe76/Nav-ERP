import { describe, expect, it } from "vitest";
import { suggestedConsumeQuantity, suggestedReportHours } from "../../web/lib/moSuggestions";

// The TO card's Förbruka material and Rapportera tid forms are prefilled with
// what theoretically remains — the user can always overwrite the suggestion.
describe("suggestedConsumeQuantity", () => {
  it("suggests what remains of the planned quantity, in the row's unit", () => {
    expect(suggestedConsumeQuantity({ quantityPlanned: "10", quantityConsumed: "4", unitFactor: null })).toBe("6");
    // Base unit kg, row shown in g (1 kg = 1000 g).
    expect(suggestedConsumeQuantity({ quantityPlanned: "2.5", quantityConsumed: "0.5", unitFactor: "1000" })).toBe("2000");
  });

  it("is empty when nothing remains", () => {
    expect(suggestedConsumeQuantity({ quantityPlanned: "3", quantityConsumed: "3", unitFactor: null })).toBe("");
    expect(suggestedConsumeQuantity({ quantityPlanned: "3", quantityConsumed: "5", unitFactor: null })).toBe("");
    expect(suggestedConsumeQuantity(undefined)).toBe("");
  });
});

describe("suggestedReportHours", () => {
  const op = { id: "op1", setupTime: "30", runTimePerUnit: "1.5" };

  it("suggests setup + run time × order quantity, in hours with two decimals", () => {
    // 30 + 1.5 × 20 = 60 min
    expect(suggestedReportHours(op, "20", [])).toBe("1");
    // 30 + 1.5 × 7 = 40.5 min = 0.675 h
    expect(suggestedReportHours(op, "7", [])).toBe("0.68");
  });

  it("subtracts the hours already reported on the operation only", () => {
    const reports = [
      { moOperationId: "op1", hours: "0.25" },
      { moOperationId: "op2", hours: "5" },
    ];
    expect(suggestedReportHours(op, "20", reports)).toBe("0.75");
  });

  it("is empty when everything is reported or the operation has no times", () => {
    expect(suggestedReportHours(op, "20", [{ moOperationId: "op1", hours: "1" }])).toBe("");
    expect(suggestedReportHours({ id: "lego", setupTime: "0", runTimePerUnit: "0" }, "20", [])).toBe("");
    expect(suggestedReportHours(undefined, "20", [])).toBe("");
  });

  it("is empty when what remains rounds to under a hundredth", () => {
    expect(suggestedReportHours({ id: "op1", setupTime: "0.2", runTimePerUnit: "0" }, "1", [])).toBe("");
  });
});

// Dela tid i ställ och produktion: the suggestion is per type, from the TO's
// time reports that carry kind.
describe("suggestedReportHours per type", () => {
  const op = { id: "op1", setupTime: "30", runTimePerUnit: "1.5" };
  const reports = [
    { moOperationId: "op1", hours: "0.25", kind: "setup" as const },
    { moOperationId: "op1", hours: "0.5", kind: "run" as const },
    { moOperationId: "op1", hours: "0.1", kind: null },
    { moOperationId: "op2", hours: "9", kind: "setup" as const },
  ];

  it("setup = planned setup time less the setup hours reported", () => {
    expect(suggestedReportHours(op, "20", [], "setup")).toBe("0.5");
    expect(suggestedReportHours(op, "20", reports, "setup")).toBe("0.25");
  });

  it("run = run time × quantity less the run hours reported", () => {
    // 1.5 × 20 = 30 min = 0.5 h
    expect(suggestedReportHours(op, "20", [], "run")).toBe("0.5");
    expect(suggestedReportHours(op, "20", reports, "run")).toBe("");
    expect(suggestedReportHours(op, "60", reports, "run")).toBe("1");
  });

  it("without a type it is the whole operation, as before", () => {
    expect(suggestedReportHours(op, "20", reports)).toBe("0.15");
    expect(suggestedReportHours(op, "20", reports, "")).toBe("0.15");
  });

  it("is empty when a type has nothing planned", () => {
    expect(suggestedReportHours({ id: "op1", setupTime: "0", runTimePerUnit: "1" }, "10", [], "setup")).toBe("");
  });
});

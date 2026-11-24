import { describe, expect, it } from "vitest";
import { reportNotice, singleMatch, suggestsDone } from "../../web/lib/operationReport";
import type { TerminalOperation } from "../../web/lib/types";

// Rapportera (Tillverkning → Rapportera, 2026-11-24): the page's pure rules —
// when Operationen är klar starts ticked, what Enter/a scan opens, and the
// notice after a report.

function row(over: Partial<TerminalOperation> = {}): TerminalOperation {
  return {
    operationId: crypto.randomUUID(),
    manufacturingOrderId: crypto.randomUUID(),
    orderNumber: "TO-1001",
    articleNumber: "3001",
    articleName: "Diskbänk",
    sequenceNo: 10,
    description: "Svets",
    workCenterId: crypto.randomUUID(),
    workCenterCode: "120",
    workCenterName: "Svets",
    orderQuantity: "10",
    quantityCompleted: "4",
    quantityScrapped: "1",
    dueDate: null,
    plannedStartDate: null,
    plannedEndDate: null,
    runPosition: null,
    readiness: "ready",
    available: "10",
    materials: [],
    packingInstructions: null,
    ...over,
  };
}

describe("Rapportera — the page's rules", () => {
  it("ticks Operationen är klar when this report's OK reaches the order quantity", () => {
    // 4 of 10 OK: 6 more completes it, 5 does not; scrapped never counts.
    expect(suggestsDone(row(), "6")).toBe(true);
    expect(suggestsDone(row(), "7")).toBe(true);
    expect(suggestsDone(row(), "5")).toBe(false);
    expect(suggestsDone(row(), "")).toBe(false);
    expect(suggestsDone(row(), "0")).toBe(false);
    expect(suggestsDone(row(), "abc")).toBe(false);
    // Decimals in four places, as the quantities are kept.
    expect(suggestsDone(row({ orderQuantity: "0.3", quantityCompleted: "0.1" }), "0.2")).toBe(true);
  });

  it("opens straight away only when the search leaves one operation", () => {
    const one = row();
    expect(singleMatch([one])).toBe(one);
    expect(singleMatch([])).toBeNull();
    expect(singleMatch([one, row()])).toBeNull();
  });

  it("says what was reported and what it did", () => {
    const base = {
      orderNumber: "TO-1001",
      sequenceNo: 20,
      employeeName: "Anna Exempel",
      minutes: 90,
      quantityOk: 0,
      quantityScrapped: 0,
      markedDone: false,
      received: 0,
      orderCompleted: false,
    };
    expect(reportNotice(base)).toBe("Rapporterat på TO-1001 op 20: 1:30 för Anna Exempel.");
    expect(reportNotice({ ...base, quantityOk: 5, quantityScrapped: 1.5, markedDone: true })).toBe(
      "Rapporterat på TO-1001 op 20: 1:30 för Anna Exempel, 5 st OK, 1,5 st kasserat. Operationen är klar."
    );
    expect(
      reportNotice({ ...base, quantityOk: 2, received: 2, orderCompleted: true, markedDone: true, receivedSerialNumbers: ["S-1", "S-2"] })
    ).toBe("Rapporterat på TO-1001 op 20: 1:30 för Anna Exempel, 2 st OK. 2 st levererades in i lager. Serienummer: S-1, S-2. Ordern är klar.");
  });
});

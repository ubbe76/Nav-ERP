import { describe, expect, it } from "vitest";
import { terminalPrintWorkOrderSchema, updateSystemSettingsSchema } from "@navet/shared";
import {
  TERMINAL_PRINT_WORK_ORDER_LABELS,
  TERMINAL_PRINT_WORK_ORDER_MODES,
  printsAtStampIn,
  terminalPrintWorkOrderOf,
  workOrderPrintHref,
} from "../../web/lib/terminalPrint";

// Skriv ut arbetsorder och ritning vid instämpling — the web's pure rules:
// the mirror of the shared values, when a stamp-in prints and what it prints.

describe("Skriv ut arbetsorder och ritning vid instämpling — webbens regler", () => {
  it("mirrors the shared values, with a label for each", () => {
    expect([...TERMINAL_PRINT_WORK_ORDER_MODES]).toEqual(terminalPrintWorkOrderSchema.options);
    expect(Object.keys(TERMINAL_PRINT_WORK_ORDER_LABELS).sort()).toEqual([...TERMINAL_PRINT_WORK_ORDER_MODES].sort());
    for (const mode of TERMINAL_PRINT_WORK_ORDER_MODES) {
      expect(updateSystemSettingsSchema.safeParse({ terminalPrintWorkOrder: mode }).success).toBe(true);
    }
  });

  it("reads anything unknown as Manuellt", () => {
    expect(terminalPrintWorkOrderOf("first_operation")).toBe("first_operation");
    expect(terminalPrintWorkOrderOf("every_operation")).toBe("every_operation");
    expect(terminalPrintWorkOrderOf("manual")).toBe("manual");
    expect(terminalPrintWorkOrderOf(undefined)).toBe("manual");
    expect(terminalPrintWorkOrderOf("always")).toBe("manual");
  });

  it("prints on the order's first stamp-in, on each operation's first, or never", () => {
    const orderFirst = { firstStampOnOrder: true, firstStampOnOperation: true };
    const operationFirst = { firstStampOnOrder: false, firstStampOnOperation: true };
    const repeat = { firstStampOnOrder: false, firstStampOnOperation: false };

    expect([orderFirst, operationFirst, repeat].map((f) => printsAtStampIn("first_operation", f))).toEqual([true, false, false]);
    expect([orderFirst, operationFirst, repeat].map((f) => printsAtStampIn("every_operation", f))).toEqual([true, true, false]);
    expect([orderFirst, operationFirst, repeat].map((f) => printsAtStampIn("manual", f))).toEqual([false, false, false]);
    // An answer without the facts (an older API) prints nothing.
    expect(printsAtStampIn("every_operation", {})).toBe(false);
    expect(printsAtStampIn("first_operation", null)).toBe(false);
  });

  it("prints each order once, several as one PDF", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(workOrderPrintHref([])).toBeNull();
    expect(workOrderPrintHref([a])).toBe(`/api/v1/manufacturing-orders/${a}/pdf`);
    expect(workOrderPrintHref([a, a])).toBe(`/api/v1/manufacturing-orders/${a}/pdf`);
    expect(workOrderPrintHref([b, a, b])).toBe(`/api/v1/manufacturing-orders/pdf?ids=${b},${a}`);
  });
});

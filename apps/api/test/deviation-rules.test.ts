import { describe, expect, it } from "vitest";
import { DEVIATION_ACTIONS, DEVIATION_STATUSES, type DeviationAction, type DeviationStatus } from "@navet/shared";
import {
  allowedActions,
  canPerform,
  closeRequirementsMissing,
  DEVIATION_TRANSITIONS,
  isEditable,
} from "../src/modules/quality/service/deviation-status.js";
import { summarizeDeviationCosts } from "../src/modules/quality/service/deviation-costs.js";
import { checkDeviationLinks, type DeviationLinkInput } from "../src/modules/quality/service/deviation-link-check.js";

// Avvikelser — the pure rules: the status whitelist (every transition), the
// close requirements, the net cost and every link mismatch.

describe("statusvitlistan", () => {
  const allowed: Record<DeviationStatus, DeviationAction[]> = {
    registered: ["start", "close", "cancel"],
    investigating: ["close", "cancel"],
    closed: ["reopen"],
    cancelled: [],
  };

  it.each(DEVIATION_STATUSES.flatMap((status) => DEVIATION_ACTIONS.map((action) => [status, action] as const)))(
    "%s → %s",
    (status, action) => {
      expect(canPerform(status, action)).toBe(allowed[status].includes(action));
    }
  );

  it("leads each action to its status", () => {
    expect(DEVIATION_TRANSITIONS.start.to).toBe("investigating");
    expect(DEVIATION_TRANSITIONS.close.to).toBe("closed");
    expect(DEVIATION_TRANSITIONS.cancel.to).toBe("cancelled");
    expect(DEVIATION_TRANSITIONS.reopen.to).toBe("investigating");
  });

  it("gives the card's buttons and the edit rule", () => {
    expect(allowedActions("registered")).toEqual(["start", "close", "cancel"]);
    expect(allowedActions("closed")).toEqual(["reopen"]);
    expect(allowedActions("cancelled")).toEqual([]);
    expect(isEditable("registered")).toBe(true);
    expect(isEditable("investigating")).toBe(true);
    expect(isEditable("closed")).toBe(false);
    expect(isEditable("cancelled")).toBe(false);
  });

  it("Avsluta needs Åtgärd always and Beslut for customer and supplier cases", () => {
    expect(closeRequirementsMissing({ type: "customer", correctiveAction: null, decision: null })).toEqual(["correctiveAction", "decision"]);
    expect(closeRequirementsMissing({ type: "supplier", correctiveAction: "Ny leverans", decision: null })).toEqual(["decision"]);
    expect(closeRequirementsMissing({ type: "supplier", correctiveAction: "  ", decision: "accepted" })).toEqual(["correctiveAction"]);
    expect(closeRequirementsMissing({ type: "customer", correctiveAction: "Kreditering", decision: "rejected" })).toEqual([]);
    expect(closeRequirementsMissing({ type: "internal", correctiveAction: "Justerad fixtur", decision: null })).toEqual([]);
    expect(closeRequirementsMissing({ type: "internal", correctiveAction: null, decision: null })).toEqual(["correctiveAction"]);
  });
});

describe("nettokostnaden", () => {
  it("adds the costs and subtracts Ersättning, rounded to öre", () => {
    expect(
      summarizeDeviationCosts([
        { kind: "material", amount: 1200.5 },
        { kind: "labour", amount: 450 },
        { kind: "freight", amount: 99.995 },
        { kind: "credit", amount: 300 },
        { kind: "other", amount: 0.01 },
        { kind: "recovery", amount: 800.25 },
      ])
    ).toEqual({ totalCosts: 2050.51, totalRecovery: 800.25, netCost: 1250.26 });
  });

  it("is zero without lines and negative when the recovery exceeds the costs", () => {
    expect(summarizeDeviationCosts([])).toEqual({ totalCosts: 0, totalRecovery: 0, netCost: 0 });
    expect(summarizeDeviationCosts([{ kind: "recovery", amount: 50 }]).netCost).toBe(-50);
  });
});

describe("kopplingskontrollerna", () => {
  const base = (type: DeviationLinkInput["type"], over: Partial<DeviationLinkInput> = {}): DeviationLinkInput => ({
    type,
    customerId: type === "customer" ? "c1" : null,
    supplierId: type === "supplier" ? "s1" : null,
    salesOrderId: null,
    salesOrderRowId: null,
    invoiceId: null,
    purchaseOrderId: null,
    purchaseOrderRowId: null,
    manufacturingOrderId: null,
    moOperationId: null,
    articleId: null,
    ...over,
  });
  const mismatch = (result: ReturnType<typeof checkDeviationLinks>) => (result.ok ? null : result.field);

  it("requires the counterparty of the type", () => {
    expect(mismatch(checkDeviationLinks(base("customer", { customerId: null }), {}))).toBe("customerId");
    expect(mismatch(checkDeviationLinks(base("supplier", { supplierId: null }), {}))).toBe("supplierId");
  });

  it.each([
    ["supplier", { customerId: "c1" }, "customerId"],
    ["internal", { salesOrderId: "so1" }, "salesOrderId"],
    ["supplier", { salesOrderRowId: "r1" }, "salesOrderRowId"],
    ["internal", { invoiceId: "i1" }, "invoiceId"],
    ["customer", { supplierId: "s1" }, "supplierId"],
    ["customer", { purchaseOrderId: "po1" }, "purchaseOrderId"],
    ["internal", { purchaseOrderRowId: "pr1" }, "purchaseOrderRowId"],
  ] as const)("refuses a document of the wrong type (%s with %o)", (type, over, field) => {
    expect(mismatch(checkDeviationLinks(base(type, over), {}))).toBe(field);
  });

  it("refuses what does not exist", () => {
    expect(mismatch(checkDeviationLinks(base("customer"), { customerExists: false }))).toBe("customerId");
    expect(mismatch(checkDeviationLinks(base("supplier"), { supplierExists: false }))).toBe("supplierId");
    expect(mismatch(checkDeviationLinks(base("internal", { articleId: "a1" }), { articleExists: false }))).toBe("articleId");
    expect(mismatch(checkDeviationLinks(base("customer", { salesOrderRowId: "r1" }), { salesOrderRow: null }))).toBe("salesOrderRowId");
    expect(mismatch(checkDeviationLinks(base("supplier", { purchaseOrderRowId: "r1" }), { purchaseOrderRow: null }))).toBe("purchaseOrderRowId");
    expect(mismatch(checkDeviationLinks(base("internal", { moOperationId: "op1" }), { moOperation: null }))).toBe("moOperationId");
    expect(mismatch(checkDeviationLinks(base("customer", { invoiceId: "i1" }), { invoice: null }))).toBe("invoiceId");
    expect(mismatch(checkDeviationLinks(base("customer", { salesOrderId: "so1" }), { salesOrder: null }))).toBe("salesOrderId");
    expect(mismatch(checkDeviationLinks(base("supplier", { purchaseOrderId: "po1" }), { purchaseOrder: null }))).toBe("purchaseOrderId");
    expect(mismatch(checkDeviationLinks(base("internal", { manufacturingOrderId: "mo1" }), { manufacturingOrder: null }))).toBe(
      "manufacturingOrderId"
    );
  });

  it("KO:n tillhör kunden, fakturan tillhör kunden, IO:n tillhör leverantören", () => {
    expect(
      mismatch(checkDeviationLinks(base("customer", { salesOrderId: "so1" }), { salesOrder: { customerId: "c2", orderNumber: "KO-1" } }))
    ).toBe("salesOrderId");
    expect(
      mismatch(checkDeviationLinks(base("customer", { invoiceId: "i1" }), { invoice: { customerId: "c2", invoiceNumber: "F-1" } }))
    ).toBe("invoiceId");
    expect(
      mismatch(checkDeviationLinks(base("supplier", { purchaseOrderId: "po1" }), { purchaseOrder: { supplierId: "s2", orderNumber: "IO-1" } }))
    ).toBe("purchaseOrderId");
  });

  it("raden tillhör ordern, operationen tillhör TO:n", () => {
    expect(
      mismatch(
        checkDeviationLinks(base("customer", { salesOrderId: "so1", salesOrderRowId: "r1" }), {
          salesOrderRow: { salesOrderId: "so2", articleId: "a1" },
          salesOrder: { customerId: "c1", orderNumber: "KO-1" },
        })
      )
    ).toBe("salesOrderRowId");
    expect(
      mismatch(
        checkDeviationLinks(base("supplier", { purchaseOrderId: "po1", purchaseOrderRowId: "r1" }), {
          purchaseOrderRow: { purchaseOrderId: "po2", articleId: "a1" },
          purchaseOrder: { supplierId: "s1", orderNumber: "IO-1" },
        })
      )
    ).toBe("purchaseOrderRowId");
    expect(
      mismatch(
        checkDeviationLinks(base("internal", { manufacturingOrderId: "mo1", moOperationId: "op1" }), {
          moOperation: { manufacturingOrderId: "mo2" },
          manufacturingOrder: { articleId: "a1", orderNumber: "TO-1" },
        })
      )
    ).toBe("moOperationId");
  });

  it("artikeln är radens/TO:ns — förifylld från den, annars en mismatch", () => {
    const filled = checkDeviationLinks(base("customer", { salesOrderRowId: "r1" }), {
      salesOrderRow: { salesOrderId: "so1", articleId: "a1" },
      salesOrder: { customerId: "c1", orderNumber: "KO-1" },
    });
    expect(filled).toEqual({ ok: true, resolved: expect.objectContaining({ salesOrderId: "so1", articleId: "a1" }) });

    const op = checkDeviationLinks(base("internal", { moOperationId: "op1" }), {
      moOperation: { manufacturingOrderId: "mo1" },
      manufacturingOrder: { articleId: "a9", orderNumber: "TO-1" },
    });
    expect(op).toEqual({ ok: true, resolved: expect.objectContaining({ manufacturingOrderId: "mo1", articleId: "a9" }) });

    expect(
      mismatch(
        checkDeviationLinks(base("supplier", { purchaseOrderRowId: "r1", articleId: "a2" }), {
          purchaseOrderRow: { purchaseOrderId: "po1", articleId: "a1" },
          purchaseOrder: { supplierId: "s1", orderNumber: "IO-1" },
          articleExists: true,
        })
      )
    ).toBe("purchaseOrderRowId");
    expect(
      mismatch(
        checkDeviationLinks(base("customer", { salesOrderRowId: "r1", manufacturingOrderId: "mo1" }), {
          salesOrderRow: { salesOrderId: "so1", articleId: "a1" },
          salesOrder: { customerId: "c1", orderNumber: "KO-1" },
          manufacturingOrder: { articleId: "a2", orderNumber: "TO-1" },
        })
      )
    ).toBe("manufacturingOrderId");
  });

  it("passes a consistent case", () => {
    expect(
      checkDeviationLinks(base("customer", { salesOrderId: "so1", salesOrderRowId: "r1", invoiceId: "i1", articleId: "a1" }), {
        customerExists: true,
        articleExists: true,
        salesOrderRow: { salesOrderId: "so1", articleId: "a1" },
        salesOrder: { customerId: "c1", orderNumber: "KO-1" },
        invoice: { customerId: "c1", invoiceNumber: "F-1" },
      }).ok
    ).toBe(true);
  });
});

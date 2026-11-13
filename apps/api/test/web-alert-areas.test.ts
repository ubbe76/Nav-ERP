import { describe, expect, it } from "vitest";
import {
  alertAreaSections,
  alertKindFromHash,
  attentionSections,
  previewSupplierSections,
  supplierSections,
  type AlertGroup,
  type AlertItem,
} from "../../web/lib/alerts.js";

// Aviseringar per område (2026-11-13): the page and Översiktens Att bevaka
// group the kinds under their menu area, in the menu's order; the page shows
// five rows per kind before Visa fler. Pure web helpers.

function item(key: string, severity: AlertItem["severity"] = "yellow", extra: Partial<AlertItem> = {}): AlertItem {
  return { key, severity, href: `/x/${key}`, primary: key, secondary: null, date: null, ...extra };
}

function group(kind: AlertGroup["kind"], area: AlertGroup["area"], items: AlertItem[], extra: Partial<AlertGroup> = {}): AlertGroup {
  return {
    kind,
    label: kind,
    area,
    severity: items.some((i) => i.severity === "red") ? "red" : "yellow",
    count: items.length,
    listHref: `/list/${kind}`,
    items,
    error: false,
    message: null,
    ...extra,
  };
}

describe("alertAreaSections", () => {
  it("groups the kinds with something to show under their area, areas in the menu's order, kinds in the response's order", () => {
    const groups = [
      group("stock_negative", "lager", [item("a", "red")]),
      group("customer_invoice_overdue", "forsaljning", [item("b", "red"), item("c", "red")]),
      group("email_failed", "system", []),
      group("sales_order_late", "forsaljning", [item("d")]),
      group("purchase_order_late", "inkop", [item("e")]),
      group("bank_unreconciled", "ekonomi", [], { error: true, message: "Kunde inte" }),
    ];
    const sections = alertAreaSections(groups);
    expect(sections.map((s) => [s.area, s.label, s.count, s.tone, s.groups.map((g) => g.kind)])).toEqual([
      ["inkop", "Inköp", 1, "yellow", ["purchase_order_late"]],
      ["forsaljning", "Försäljning", 3, "red", ["customer_invoice_overdue", "sales_order_late"]],
      ["lager", "Lager", 1, "red", ["stock_negative"]],
      // A kind that could not be read is shown (as red) even with count 0.
      ["ekonomi", "Ekonomi", 0, "red", ["bank_unreconciled"]],
    ]);
  });

  it("is empty when nothing is to be shown", () => {
    expect(alertAreaSections([group("stock_negative", "lager", [])])).toEqual([]);
  });

  it("counts the real number, not the rows in the response", () => {
    const [section] = alertAreaSections([group("sales_order_late", "forsaljning", [item("a")], { count: 250 })]);
    expect(section!.count).toBe(250);
  });
});

describe("attentionSections", () => {
  it("is one row per kind with its count, linking to the kind on Aviseringar", () => {
    const sections = attentionSections([
      group("sales_order_late", "forsaljning", [item("a"), item("b")]),
      group("supplier_invoice_due", "inkop", [item("c", "red")]),
      group("cost_center_missing", "ekonomi", [], { error: true }),
    ]);
    expect(sections).toEqual([
      {
        area: "inkop",
        label: "Inköp",
        rows: [{ kind: "supplier_invoice_due", label: "supplier_invoice_due", count: 1, tone: "red", href: "/aviseringar#typ-supplier_invoice_due" }],
      },
      {
        area: "forsaljning",
        label: "Försäljning",
        rows: [{ kind: "sales_order_late", label: "sales_order_late", count: 2, tone: "yellow", href: "/aviseringar#typ-sales_order_late" }],
      },
      {
        area: "ekonomi",
        label: "Ekonomi",
        rows: [{ kind: "cost_center_missing", label: "cost_center_missing", count: null, tone: "red", href: "/aviseringar#typ-cost_center_missing" }],
      },
    ]);
  });
});

describe("alertKindFromHash", () => {
  it("reads a known kind from #typ-<kind> and nothing else", () => {
    expect(alertKindFromHash("#typ-sales_order_late")).toBe("sales_order_late");
    expect(alertKindFromHash("typ-purchase_needed")).toBe("purchase_needed");
    expect(alertKindFromHash("#typ-nope")).toBeNull();
    expect(alertKindFromHash("#omrade-lager")).toBeNull();
    expect(alertKindFromHash("")).toBeNull();
  });
});

describe("previewSupplierSections", () => {
  const needed = group("purchase_needed", "inkop", [item("n1"), item("n2"), item("s1"), item("s2"), item("s3"), item("t1"), item("t2")], {
    supplierGroups: [
      { key: "none", supplierId: null, supplierName: null, count: 2, shown: 2 },
      { key: "s", supplierId: "s", supplierName: "Bult AB", count: 3, shown: 3 },
      { key: "t", supplierId: "t", supplierName: "Tråd AB", count: 2, shown: 2 },
    ],
  });

  it("keeps the first rows under their own supplier heading and drops sections with no row left", () => {
    const preview = previewSupplierSections(supplierSections(needed), 5);
    expect(preview.map((s) => [s.group.key, s.items.map((i) => i.key)])).toEqual([
      ["none", ["n1", "n2"]],
      ["s", ["s1", "s2", "s3"]],
    ]);
    expect(previewSupplierSections(supplierSections(needed), 3).map((s) => [s.group.key, s.items.map((i) => i.key)])).toEqual([
      ["none", ["n1", "n2"]],
      ["s", ["s1"]],
    ]);
  });

  it("returns every section whole when the limit covers them", () => {
    const all = supplierSections(needed);
    expect(previewSupplierSections(all, 50)).toEqual(all);
  });
});

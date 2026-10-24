import { describe, expect, it } from "vitest";
import { ALERT_KINDS, effectivePermissions, type AlertKind } from "@navet/shared";
import {
  ALERT_KIND_CATALOG,
  alertKindDef,
  quoteFollowupSeverity,
  sortKinds,
  supplierInvoiceSeverity,
  visibleKinds,
} from "../src/modules/alerts/service/alert-kinds.js";

// Pure tests — the catalog is the only place a kind's permission lives, so
// this file is its spec: who sees what, the fixed order and the one kind
// whose rows change colour.

const user = (perms: string[]) => ({ role: "user" as const, permissions: effectivePermissions("user", perms) });

describe("the catalog", () => {
  it("has every shared kind exactly once, red before yellow", () => {
    expect([...ALERT_KIND_CATALOG.map((d) => d.kind)].sort()).toEqual([...ALERT_KINDS].sort());
    const colours = ALERT_KIND_CATALOG.map((d) => d.severity);
    const firstYellow = colours.indexOf("yellow");
    expect(colours.slice(firstYellow).every((c) => c === "yellow")).toBe(true);
    expect(ALERT_KIND_CATALOG.map((d) => d.kind)).toEqual([
      "stock_negative",
      "customer_invoice_overdue",
      "supplier_invoice_due",
      "quote_followup",
      "einvoice_failed",
      "email_failed",
      "plugin_delivery_failed",
      "recurring_verification_failed",
      "sales_order_late",
      "purchase_order_late",
      "manufacturing_order_late",
      "purchase_needed",
      "manufacture_needed",
      "bank_unreconciled",
    ]);
  });

  it("gives every kind a label and a list page", () => {
    for (const def of ALERT_KIND_CATALOG) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.listHref.startsWith("/")).toBe(true);
      expect(alertKindDef(def.kind)).toBe(def);
    }
  });
});

describe("visibleKinds", () => {
  it("admin sees everything, in catalog order", () => {
    expect(visibleKinds({ role: "admin", permissions: [] })).toEqual(ALERT_KIND_CATALOG.map((d) => d.kind));
  });

  it("a user without a group sees nothing", () => {
    expect(visibleKinds({ role: "user", permissions: [] })).toEqual([]);
    expect(visibleKinds({ role: "user" })).toEqual([]);
  });

  it("Inköp alone gives the purchase kinds only", () => {
    expect(visibleKinds(user(["inkop"]))).toEqual(["supplier_invoice_due", "purchase_order_late", "purchase_needed"]);
  });

  it("Försäljning gives the customer kinds, Tillverkning the TO kinds, Lager the stock kind", () => {
    expect(visibleKinds(user(["forsaljning"]))).toEqual([
      "customer_invoice_overdue",
      "quote_followup",
      "einvoice_failed",
      "sales_order_late",
    ]);
    expect(visibleKinds(user(["tillverkning"]))).toEqual(["manufacturing_order_late", "manufacture_needed"]);
    expect(visibleKinds(user(["lager"]))).toEqual(["stock_negative"]);
    expect(visibleKinds(user(["ekonomi"]))).toEqual(["recurring_verification_failed", "bank_unreconciled"]);
  });

  it("Utskick som misslyckades and Tillägg are admin-only: every menu together still does not give them", () => {
    const all = user(["artiklar", "inkop", "forsaljning", "tillverkning", "lager", "personal", "ekonomi", "rapporter"]);
    expect(visibleKinds(all)).toEqual(
      ALERT_KIND_CATALOG.map((d) => d.kind).filter((k) => k !== "email_failed" && k !== "plugin_delivery_failed")
    );
  });

  it("the supervisor role is not admin", () => {
    expect(visibleKinds({ role: "supervisor", permissions: effectivePermissions("supervisor", ["inkop"]) })).toEqual([
      "supplier_invoice_due",
      "purchase_order_late",
      "purchase_needed",
    ]);
  });
});

describe("sortKinds", () => {
  it("returns catalog order and drops duplicates", () => {
    const kinds: AlertKind[] = ["manufacture_needed", "stock_negative", "sales_order_late", "stock_negative", "email_failed"];
    expect(sortKinds(kinds)).toEqual(["stock_negative", "email_failed", "sales_order_late", "manufacture_needed"]);
    expect(sortKinds([])).toEqual([]);
  });
});

describe("supplierInvoiceSeverity / quoteFollowupSeverity", () => {
  it("is red once the date has passed and yellow today or ahead", () => {
    expect(supplierInvoiceSeverity("2026-10-20", "2026-10-21")).toBe("red");
    expect(supplierInvoiceSeverity("2026-10-21", "2026-10-21")).toBe("yellow");
    expect(supplierInvoiceSeverity("2026-10-28", "2026-10-21")).toBe("yellow");
    expect(quoteFollowupSeverity("2026-10-20", "2026-10-21")).toBe("red");
    expect(quoteFollowupSeverity("2026-10-21", "2026-10-21")).toBe("yellow");
  });
});

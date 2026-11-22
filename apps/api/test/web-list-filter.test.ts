import { describe, expect, it } from "vitest";
import {
  listArticlesQuerySchema,
  listInquiriesQuerySchema,
  listInvoicesQuerySchema,
  listManufacturingOrdersQuerySchema,
  listPurchaseOrdersQuerySchema,
  listSalesOrdersQuerySchema,
  listSupplierInvoicesQuerySchema,
} from "@navet/shared";
import {
  SHOW_FINISHED_PARAM,
  effectiveFilterValue,
  filterParamValue,
  filterSummary,
  groupChosen,
  parseFilterValue,
  showsFinished,
  toggleFilterGroup,
  toggleFilterValue,
  visibleOptions,
  withFinishedRule,
  withoutFinished,
} from "../../web/lib/listFilter";
import {
  ARTICLE_TYPE_FILTER,
  INQUIRY_FILTER,
  INVOICE_FILTER,
  MANUFACTURING_ORDER_FILTER,
  PURCHASE_ORDER_FILTER,
  QUOTE_FILTER,
  SALES_ORDER_FILTER,
  SUPPLIER_INVOICE_FILTER,
} from "../../web/lib/statusFilters";
import { SPLIT_LISTS } from "../../web/components/split/splitLists";

// Flerval i listornas filter (2026-11-21): the narrow list's chips and the
// table's Status menu choose several values at once, sent as one
// comma-separated param.
describe("multi filter helpers", () => {
  const f = PURCHASE_ORDER_FILTER;
  // Öppna is left only on Förfrågningar (2026-11-22).
  const q = INQUIRY_FILTER;
  const open = q.groups![0]!;

  it("keeps the filter's order whatever order the values were chosen in", () => {
    let chosen = toggleFilterValue(f, [], "received");
    chosen = toggleFilterValue(f, chosen, "draft");
    chosen = toggleFilterValue(f, chosen, "late");
    expect(chosen).toEqual(["draft", "received", "late"]);
    expect(filterParamValue(chosen)).toBe("draft,received,late");
    expect(toggleFilterValue(f, chosen, "draft")).toEqual(["received", "late"]);
  });

  it("reads the address: known values once, in order", () => {
    expect(parseFilterValue(f, "late, received,draft,x,draft")).toEqual(["draft", "received", "late"]);
    expect(parseFilterValue(f, "")).toEqual([]);
    expect(parseFilterValue(f, null)).toEqual([]);
  });

  it("a group chooses all its statuses, and is chosen while they all are", () => {
    const chosen = toggleFilterGroup(q, ["ordered"], open);
    expect(chosen).toEqual(["draft", "sent", "answered", "ordered"]);
    expect(groupChosen(open, chosen)).toBe("all");
    const less = toggleFilterValue(q, chosen, "sent");
    expect(groupChosen(open, less)).toBe("some");
    // Not all chosen: the group chooses the rest; all chosen: it clears them.
    expect(toggleFilterGroup(q, less, open)).toEqual(chosen);
    expect(toggleFilterGroup(q, chosen, open)).toEqual(["ordered"]);
    expect(groupChosen(open, [])).toBe("none");
  });

  it("the menu button says what is chosen", () => {
    expect(filterSummary(f, [], "Alla statusar")).toBe("Alla statusar");
    expect(filterSummary(f, ["draft"], "Alla statusar")).toBe("Utkast");
    expect(filterSummary(f, ["draft", "confirmed"], "Alla statusar")).toBe("Utkast, Bekräftad");
    expect(filterSummary(f, ["draft", "confirmed", "partially_received"], "Alla statusar")).toBe("Utkast, Bekräftad +1");
    expect(filterSummary(f, ["draft", "late"], "Alla statusar")).toBe("Utkast, Sen");
    expect(filterSummary(f, ["draft", "received", "closed", "late"], "Alla statusar")).toBe("Utkast, Mottagen +2");
    expect(filterSummary(q, ["draft", "sent", "answered"], "Alla statusar")).toBe("Öppna");
    expect(filterSummary(q, ["draft", "sent", "answered", "ordered"], "Alla statusar")).toBe("Öppna, Beställd");
  });
});

// Visa avslutade (2026-11-21): the orders' end statuses are left out until
// the box is ticked.
describe("finished orders hidden by default", () => {
  const f = PURCHASE_ORDER_FILTER;

  it("Alla asks for every status but the finished ones; Sen still narrows", () => {
    expect(effectiveFilterValue(f, [], false)).toBe("draft,confirmed,partially_received");
    expect(effectiveFilterValue(f, ["late"], false)).toBe("draft,confirmed,partially_received,late");
    expect(effectiveFilterValue(f, ["draft", "late"], false)).toBe("draft,late");
    // Ticked: as chosen, Alla = no filter.
    expect(effectiveFilterValue(f, [], true)).toBe("");
    expect(effectiveFilterValue(f, ["closed"], true)).toBe("closed");
  });

  it("the chips and the menu leave the finished statuses out until shown", () => {
    expect(visibleOptions(f, false).map((o) => o.label)).toEqual(["Utkast", "Bekräftad", "Delvis mottagen"]);
    expect(visibleOptions(f, true)).toHaveLength(6);
    expect(withoutFinished(f, ["draft", "closed", "late"])).toEqual(["draft", "late"]);
  });

  it("no group that is just Alla: Öppna is gone where the finished are hidden", () => {
    for (const filter of [SALES_ORDER_FILTER, PURCHASE_ORDER_FILTER, MANUFACTURING_ORDER_FILTER, INQUIRY_FILTER]) {
      const visible = visibleOptions(filter, false).map((o) => o.value);
      for (const group of filter.groups ?? []) expect([...group.values].sort()).not.toEqual([...visible].sort());
    }
    expect(INQUIRY_FILTER.groups!.map((g) => g.label)).toEqual(["Öppna"]);
  });

  it("a finished status in the address shows them by itself", () => {
    expect(showsFinished(f, ["closed"], false)).toBe(true);
    expect(showsFinished(f, ["draft"], false)).toBe(false);
    expect(showsFinished(QUOTE_FILTER, [], false)).toBe(true);
  });

  it("the table page and the export ask the API for the same rows", () => {
    expect(withFinishedRule(SALES_ORDER_FILTER, { search: "Exempel" })).toEqual({
      search: "Exempel",
      status: "confirmed,in_production",
    });
    expect(withFinishedRule(SALES_ORDER_FILTER, { [SHOW_FINISHED_PARAM]: "true" })).toEqual({ status: undefined });
    expect(withFinishedRule(MANUFACTURING_ORDER_FILTER, { status: "closed" })).toEqual({ status: "closed" });
    expect(withFinishedRule(MANUFACTURING_ORDER_FILTER, { status: "late" })).toEqual({
      status: "planned,released,in_progress,late",
    });
    // Lists without finished statuses are left alone.
    expect(withFinishedRule(QUOTE_FILTER, { status: "lost" })).toEqual({ status: "lost" });
    expect(withFinishedRule(INVOICE_FILTER, {})).toEqual({});
  });
});

describe("the lists' filters", () => {
  // Every value a filter can send is one the list's API takes — together,
  // so a chip or a checkbox never gives 400.
  const cases = [
    [SALES_ORDER_FILTER, listSalesOrdersQuerySchema],
    [QUOTE_FILTER, listSalesOrdersQuerySchema],
    [PURCHASE_ORDER_FILTER, listPurchaseOrdersQuerySchema],
    [INQUIRY_FILTER, listInquiriesQuerySchema],
    [MANUFACTURING_ORDER_FILTER, listManufacturingOrdersQuerySchema],
    [INVOICE_FILTER, listInvoicesQuerySchema],
    [SUPPLIER_INVOICE_FILTER, listSupplierInvoicesQuerySchema],
    [ARTICLE_TYPE_FILTER, listArticlesQuerySchema],
  ] as const;

  it("every value is one the API takes, all at once", () => {
    for (const [filter, schema] of cases) {
      const all = [...filter.options, ...(filter.narrow ?? [])].map((c) => c.value);
      const result = schema.safeParse({ [filter.param]: filterParamValue(all) });
      expect(result.success, `${filter.param}=${all.join(",")}`).toBe(true);
      for (const group of filter.groups ?? []) {
        for (const v of group.values) expect(filter.options.map((o) => o.value)).toContain(v);
      }
    }
  });

  it("the narrow lists use the same definitions as the tables", () => {
    expect(SPLIT_LISTS["/inkop/ordrar"]!.filter).toBe(PURCHASE_ORDER_FILTER);
    expect(SPLIT_LISTS["/forsaljning/ordrar"]!.filter).toBe(SALES_ORDER_FILTER);
    expect(SPLIT_LISTS["/forsaljning/offerter"]!.filter).toBe(QUOTE_FILTER);
    expect(SPLIT_LISTS["/inkop/forfragningar"]!.filter).toBe(INQUIRY_FILTER);
    expect(SPLIT_LISTS["/tillverkning/ordrar"]!.filter).toBe(MANUFACTURING_ORDER_FILTER);
    expect(SPLIT_LISTS["/forsaljning/fakturor"]!.filter).toBe(INVOICE_FILTER);
    expect(SPLIT_LISTS["/inkop/leverantorsfakturor"]!.filter).toBe(SUPPLIER_INVOICE_FILTER);
    expect(SPLIT_LISTS["/artiklar/register"]!.filter).toBe(ARTICLE_TYPE_FILTER);
    expect(SPLIT_LISTS["/kunder"]!.filter).toBeUndefined();
    // No Sen on quotes; Halvfabrikat sent only on the TO list.
    expect(QUOTE_FILTER.narrow).toBeUndefined();
    expect(MANUFACTURING_ORDER_FILTER.narrow!.map((c) => c.value)).toEqual(["late", "component_late"]);
  });
});

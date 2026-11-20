import { describe, expect, it } from "vitest";
import { hasListQuery, listViewOf, tablesOf, withListView } from "../../web/lib/listView";
import { SPLIT_LISTS } from "../../web/components/split/splitLists";
import { functionOf } from "../../web/lib/navFunctions";

// Lista och kort (Programramen, steg 2): which view a list page draws, kept
// per list in a cookie; the narrow lists' registry.
describe("list view cookie", () => {
  it("is the list (beside the card) unless the user chose the table for that list", () => {
    expect(listViewOf(undefined, "/forsaljning/ordrar")).toBe("list");
    const one = withListView(undefined, "/forsaljning/ordrar", "table");
    expect(listViewOf(one, "/forsaljning/ordrar")).toBe("table");
    expect(listViewOf(one, "/inkop/ordrar")).toBe("list");
    const two = withListView(one, "/inkop/ordrar", "table");
    expect(tablesOf(two)).toEqual(["/forsaljning/ordrar", "/inkop/ordrar"]);
    expect(tablesOf(withListView(two, "/forsaljning/ordrar", "list"))).toEqual(["/inkop/ordrar"]);
    // Twice the same choice keeps one entry.
    expect(tablesOf(withListView(two, "/inkop/ordrar", "table"))).toEqual(["/forsaljning/ordrar", "/inkop/ordrar"]);
  });

  it("ignores what is not a list path, and a broken value", () => {
    expect(tablesOf(encodeURIComponent("x|/kunder|"))).toEqual(["/kunder"]);
    expect(tablesOf("%E0%A4%A")).toEqual([]);
  });

  it("a page opened with a filter, a search or a shortcut shows the table", () => {
    expect(hasListQuery({})).toBe(false);
    expect(hasListQuery({ status: undefined, search: "" })).toBe(false);
    expect(hasListQuery({ ny: "1" })).toBe(true);
    expect(hasListQuery({ status: "confirmed" })).toBe(true);
    expect(hasListQuery({ page: ["2"] })).toBe(true);
  });
});

describe("SPLIT_LISTS", () => {
  it("each list is its own function, and its documents belong to it", () => {
    for (const [key, config] of Object.entries(SPLIT_LISTS)) {
      expect(config.path).toBe(key);
      expect(functionOf(key)).toBe(key);
      expect(config.filters[0]).toEqual({ label: "Alla", query: "" });
      expect(config.api.startsWith("/api/v1/")).toBe(true);
    }
    const order = SPLIT_LISTS["/forsaljning/ordrar"]!.row({
      id: "o1",
      orderNumber: "KO-5001",
      customerName: "Exempel AB",
      status: "confirmed",
      nextDeliveryDate: "2026-11-27",
    });
    expect(order).toMatchObject({ href: "/forsaljning/ordrar/o1", primary: "Exempel AB", secondary: "KO-5001 · lev 11-27", status: { label: "Bekräftad" } });
    expect(functionOf(order.href)).toBe("/forsaljning/ordrar");
    const article = SPLIT_LISTS["/artiklar/register"]!.row({ id: "a1", articleNumber: "1001", name: "Plåt", type: "purchased", active: true });
    expect(functionOf(`/artiklar/3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c`)).toBe("/artiklar/register");
    // Programramen steg 3: the list's row opens the summary beside the list;
    // the summary and the whole card are the same function (one tab).
    expect(article).toMatchObject({ href: "/artiklar/register/a1", secondary: "1001 · Köpt", status: null });
    expect(functionOf(`/artiklar/register/3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c`)).toBe("/artiklar/register");
  });
});

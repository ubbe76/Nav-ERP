import { describe, expect, it } from "vitest";
import {
  LIST_COLUMN_MAX_WIDTH as SHARED_MAX,
  LIST_COLUMN_MIN_WIDTH as SHARED_MIN,
  listColumnsKeySchema,
  TABLE_DENSITIES as SHARED_DENSITIES,
} from "@navet/shared";
import {
  applyListColumns,
  canHideColumn,
  clampColumnWidth,
  LIST_COLUMN_MAX_WIDTH,
  LIST_COLUMN_MIN_WIDTH,
  listColumnsKey,
  TABLE_DENSITIES,
} from "../../web/lib/listColumns";

// Täthet och kolumner (Nav som program, punkt 6): the web's rules for which
// columns a list shows and the key its setup is saved under.
const COLUMNS = [
  { key: "number", label: "Ordernummer", width: "140px" },
  { key: "select", label: "Välj", width: "40px", header: "☐" },
  { key: "customer", label: "Kund", width: "1fr" },
  { key: "amount", label: "Belopp", width: "120px" },
  { key: "actions", label: "", width: "60px" },
];

describe("the web mirror", () => {
  it("has the shared constants", () => {
    expect(TABLE_DENSITIES).toEqual(SHARED_DENSITIES);
    expect(LIST_COLUMN_MIN_WIDTH).toBe(SHARED_MIN);
    expect(LIST_COLUMN_MAX_WIDTH).toBe(SHARED_MAX);
  });
});

describe("canHideColumn", () => {
  it("never hides the first column or a control column", () => {
    expect(COLUMNS.map((c, i) => canHideColumn(c, i, COLUMNS))).toEqual([false, false, true, true, false]);
  });

  it("keeps the number column when a checkbox column comes first", () => {
    const withCheckbox = [{ key: "select", label: "", width: "36px", header: "☐" }, ...COLUMNS.filter((c) => c.key !== "select")];
    expect(withCheckbox.map((c, i) => canHideColumn(c, i, withCheckbox))).toEqual([false, false, true, true, false]);
    expect(applyListColumns(withCheckbox, { hidden: ["number", "customer"], widths: {} }).map((c) => c.key)).toEqual([
      "select",
      "number",
      "amount",
      "actions",
    ]);
  });
});

describe("applyListColumns", () => {
  it("leaves the columns as built without a setup", () => {
    expect(applyListColumns(COLUMNS, undefined)).toBe(COLUMNS);
  });

  it("hides what may be hidden and applies dragged widths in px", () => {
    const shown = applyListColumns(COLUMNS, {
      hidden: ["amount", "number", "select", "actions", "gone"],
      widths: { customer: 300, number: 90, gone: 50 },
    });
    expect(shown.map((c) => [c.key, c.width])).toEqual([
      ["number", "90px"],
      ["select", "40px"],
      ["customer", "300px"],
      ["actions", "60px"],
    ]);
  });
});

describe("clampColumnWidth", () => {
  it("keeps a dragged width within the schema's bounds, in whole px", () => {
    expect(clampColumnWidth(12)).toBe(LIST_COLUMN_MIN_WIDTH);
    expect(clampColumnWidth(99999)).toBe(LIST_COLUMN_MAX_WIDTH);
    expect(clampColumnWidth(123.6)).toBe(124);
  });
});

describe("listColumnsKey", () => {
  it("is the list's path, and only a path the settings take", () => {
    expect(listColumnsKey("/forsaljning/ordrar")).toBe("/forsaljning/ordrar");
    expect(listColumnsKey("/forsaljning/ordrar/")).toBe("/forsaljning/ordrar");
    expect(listColumnsKey("/artiklar/3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c")).toBeNull();
    expect(listColumnsKey("/artiklar/3f2a1b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c/lager")).toBeNull();
    expect(listColumnsKey("/Lager")).toBeNull();
    for (const path of ["/forsaljning/ordrar", "/lager/abc-analys", "/inkop/leverantorsfakturor"]) {
      expect(listColumnsKeySchema.safeParse(listColumnsKey(path)).success).toBe(true);
    }
  });
});

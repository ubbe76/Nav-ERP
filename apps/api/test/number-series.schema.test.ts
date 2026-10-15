import { describe, expect, it } from "vitest";
import { numberSeriesKeys, updateNumberSeriesSchema } from "@navet/shared";

describe("number series shared schema", () => {
  it("lists every migration-seeded series key, including the customer and supplier series", () => {
    expect(numberSeriesKeys).toEqual(
      expect.arrayContaining([
        "purchase_order",
        "sales_order",
        "manufacturing_order",
        "inquiry",
        "invoice",
        "supplier_invoice",
        "customer_payment",
        "supplier_payment",
        "customer",
        "supplier",
        "stock_count",
        "fixed_asset",
        "payment_batch",
      ])
    );
  });

  it("accepts an empty prefix — the customer and supplier series have none", () => {
    const parsed = updateNumberSeriesSchema.parse({ prefix: "", nextNumber: 2000 });
    expect(parsed.prefix).toBe("");
  });
});

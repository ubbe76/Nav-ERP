import { describe, expect, it } from "vitest";
import {
  BUSINESS_DATE_MAX,
  BUSINESS_DATE_MIN,
  businessDateSchema,
  createQuoteSchema,
  customerDeliveryDateQuerySchema,
  deliveryTimeCheckSchema,
  supplierDeliveryDateQuerySchema,
  updateSalesOrderHeaderSchema,
} from "@navet/shared";
import {
  BUSINESS_DATE_MAX as API_MAX,
  BUSINESS_DATE_MIN as API_MIN,
} from "../src/modules/system/service/delivery-days.js";

// Pure schema tests — no database. z.string().date() takes any four-digit
// year, but a date near 0001 or 9999 breaks the date arithmetic downstream
// (addDays renders year 10000 as "+010000-08", which Postgres rejects with a
// 500). Every field that feeds that arithmetic takes businessDateSchema.

const uuid = "5b3f2a10-0000-4000-8000-000000000001";

describe("businessDateSchema", () => {
  it("accepts ordinary dates and the bounds themselves", () => {
    for (const d of ["2026-10-17", BUSINESS_DATE_MIN, BUSINESS_DATE_MAX]) {
      expect(businessDateSchema.parse(d)).toBe(d);
    }
  });

  it("rejects dates outside 1900–2999 and malformed input", () => {
    for (const d of ["9999-12-31", "0001-01-01", "1899-12-31", "3000-01-01", "2026-13-40", "igår", ""]) {
      expect(businessDateSchema.safeParse(d).success, d).toBe(false);
    }
  });

  it("shares its bounds with the API's clamp for stored data", () => {
    expect([BUSINESS_DATE_MIN, BUSINESS_DATE_MAX]).toEqual([API_MIN, API_MAX]);
  });
});

describe("date fields that feed date arithmetic", () => {
  it("the delivery date suggestions refuse an out-of-range date", () => {
    expect(supplierDeliveryDateQuerySchema.safeParse({ supplierId: uuid, date: "9999-12-31" }).success).toBe(false);
    expect(supplierDeliveryDateQuerySchema.safeParse({ supplierId: uuid, date: "2026-10-21" }).success).toBe(true);
    expect(customerDeliveryDateQuerySchema.safeParse({ customerId: uuid, date: "0001-01-01" }).success).toBe(false);
    expect(customerDeliveryDateQuerySchema.safeParse({ customerId: uuid }).success).toBe(true);
  });

  it("the sales order's expected delivery date is bounded on create and header update", () => {
    const quote = { customerId: uuid, rows: [{ articleId: uuid, quantity: 1, unitPrice: 10 }] };
    expect(createQuoteSchema.safeParse({ ...quote, expectedDeliveryDate: "9999-12-31" }).success).toBe(false);
    expect(createQuoteSchema.safeParse({ ...quote, expectedDeliveryDate: "2026-10-21" }).success).toBe(true);
    expect(createQuoteSchema.safeParse(quote).success).toBe(true);

    expect(updateSalesOrderHeaderSchema.safeParse({ expectedDeliveryDate: "0001-01-01" }).success).toBe(false);
    expect(updateSalesOrderHeaderSchema.safeParse({ expectedDeliveryDate: "2026-10-21" }).success).toBe(true);
    // null clears the date — still allowed.
    expect(updateSalesOrderHeaderSchema.safeParse({ expectedDeliveryDate: null }).success).toBe(true);
  });
});

describe("deliveryTimeCheckSchema — rows", () => {
  it("refuses an empty rows list even with an order, and requires one of the two", () => {
    expect(deliveryTimeCheckSchema.safeParse({ salesOrderId: uuid, rows: [] }).success).toBe(false);
    expect(deliveryTimeCheckSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(deliveryTimeCheckSchema.safeParse({}).success).toBe(false);
    expect(deliveryTimeCheckSchema.safeParse({ salesOrderId: uuid }).success).toBe(true);
    expect(deliveryTimeCheckSchema.safeParse({ rows: [{ articleId: uuid, quantity: 1 }] }).success).toBe(true);
    expect(deliveryTimeCheckSchema.safeParse({ salesOrderId: uuid, rows: [{ articleId: uuid, quantity: 1 }] }).success).toBe(
      true
    );
  });
});

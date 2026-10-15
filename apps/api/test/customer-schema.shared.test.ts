import { describe, expect, it } from "vitest";
import {
  countryCodeSchema,
  createCustomerSchema,
  createDeliveryAddressSchema,
  invoiceRowInputSchema,
  updateFreightSettingsSchema,
  updateInvoiceRowSchema,
  updateCustomerSchema,
  updateDeliveryAddressSchema,
} from "@navet/shared";

// Pure schema tests — no database. Migration 0085's country field: ISO
// 3166-1 alpha-2, trimmed and upper-cased on input, defaulting to SE where
// the schema says it does. These exercise the zod layer directly (the route
// handlers call schema.parse(req.body) before ever reaching the service —
// see sales.routes.ts's POST /customers), since the service-level tests in
// sales.service.test.ts call the service directly and bypass this parsing.

describe("countryCodeSchema", () => {
  it("upper-cases and trims a lowercase code", () => {
    expect(countryCodeSchema.parse("dk")).toBe("DK");
    expect(countryCodeSchema.parse(" no ")).toBe("NO");
  });

  it("accepts an already upper-case code unchanged", () => {
    expect(countryCodeSchema.parse("SE")).toBe("SE");
  });

  it("rejects a country name instead of an ISO code", () => {
    expect(() => countryCodeSchema.parse("Sverige")).toThrow();
  });

  it("rejects codes of the wrong length", () => {
    expect(() => countryCodeSchema.parse("S")).toThrow();
    expect(() => countryCodeSchema.parse("SWE")).toThrow();
  });
});

describe("createCustomerSchema — country and discountPercent defaults", () => {
  it("defaults country to SE and discountPercent to 0 when omitted", () => {
    const parsed = createCustomerSchema.parse({ name: "Kund AB" });
    expect(parsed.country).toBe("SE");
    expect(parsed.discountPercent).toBe(0);
  });

  it("normalizes a lowercase country on create", () => {
    const parsed = createCustomerSchema.parse({ name: "Dansk Kund", country: "dk" });
    expect(parsed.country).toBe("DK");
  });

  it("rejects a Swedish country NAME on create (must be the ISO code)", () => {
    expect(() => createCustomerSchema.parse({ name: "Kund AB", country: "Sverige" })).toThrow();
  });

  it("rejects discountPercent outside 0-100", () => {
    expect(() => createCustomerSchema.parse({ name: "Kund AB", discountPercent: 101 })).toThrow();
    expect(() => createCustomerSchema.parse({ name: "Kund AB", discountPercent: -1 })).toThrow();
  });

  it("rejects a blank discountPercent string rather than coercing it to 0 (blank-string guard)", () => {
    expect(() => createCustomerSchema.parse({ name: "Kund AB", discountPercent: "" })).toThrow();
  });
});

// Migration 0087: ourSupplierNumber/collectiveInvoicing/privatePerson/website.
describe("createCustomerSchema/updateCustomerSchema — ourSupplierNumber, collectiveInvoicing, privatePerson, website", () => {
  it("defaults collectiveInvoicing and privatePerson to false, leaves ourSupplierNumber/website undefined when omitted", () => {
    const parsed = createCustomerSchema.parse({ name: "Kund AB" });
    expect(parsed.collectiveInvoicing).toBe(false);
    expect(parsed.privatePerson).toBe(false);
    expect(parsed.ourSupplierNumber).toBeUndefined();
    expect(parsed.website).toBeUndefined();
  });

  it("accepts explicit values on create", () => {
    const parsed = createCustomerSchema.parse({
      name: "Kund AB",
      ourSupplierNumber: "LEV-1",
      collectiveInvoicing: true,
      privatePerson: true,
      website: "www.example.se",
    });
    expect(parsed.ourSupplierNumber).toBe("LEV-1");
    expect(parsed.collectiveInvoicing).toBe(true);
    expect(parsed.privatePerson).toBe(true);
    expect(parsed.website).toBe("www.example.se");
  });

  it("allows ourSupplierNumber and website to be nulled on PATCH", () => {
    const parsed = updateCustomerSchema.parse({ ourSupplierNumber: null, website: null });
    expect(parsed.ourSupplierNumber).toBeNull();
    expect(parsed.website).toBeNull();
  });

  it("allows collectiveInvoicing/privatePerson to be omitted (leave untouched) on PATCH", () => {
    const parsed = updateCustomerSchema.parse({ name: "Kund AB" });
    expect(parsed.collectiveInvoicing).toBeUndefined();
    expect(parsed.privatePerson).toBeUndefined();
  });
});

describe("updateCustomerSchema — country is not nullable, invoiceCountry is", () => {
  it("accepts a normalized country on PATCH", () => {
    const parsed = updateCustomerSchema.parse({ country: "no" });
    expect(parsed.country).toBe("NO");
  });

  it("rejects an invalid country on PATCH", () => {
    expect(() => updateCustomerSchema.parse({ country: "Sverige" })).toThrow();
  });

  it("allows invoiceCountry and invoiceName to be nulled", () => {
    const parsed = updateCustomerSchema.parse({ invoiceCountry: null, invoiceName: null });
    expect(parsed.invoiceCountry).toBeNull();
    expect(parsed.invoiceName).toBeNull();
  });
});

describe("delivery address schemas — country default and validation", () => {
  it("defaults a new delivery address's country to SE", () => {
    const parsed = createDeliveryAddressSchema.parse({ label: "Lager", address: "Gata 1" });
    expect(parsed.country).toBe("SE");
  });

  it("normalizes a lowercase country on the delivery address", () => {
    const parsed = createDeliveryAddressSchema.parse({ label: "Lager", address: "Gata 1", country: "fi" });
    expect(parsed.country).toBe("FI");
  });

  it("rejects an invalid country on the delivery address PATCH", () => {
    expect(() => updateDeliveryAddressSchema.parse({ country: "Sverige" })).toThrow();
  });
});

describe("frakt etapp 2 — scheman", () => {
  it("customer accepts and clears defaultFreightProductId", () => {
    const id = "6f1c7a8e-2b3d-4c5e-8f90-123456789abc";
    expect(updateCustomerSchema.parse({ defaultFreightProductId: id }).defaultFreightProductId).toBe(id);
    expect(updateCustomerSchema.parse({ defaultFreightProductId: null }).defaultFreightProductId).toBeNull();
  });
  it("an invoice row may carry shipmentId but a row update may not", () => {
    const id = "6f1c7a8e-2b3d-4c5e-8f90-123456789abc";
    expect(invoiceRowInputSchema.parse({ description: "Frakt", quantity: 1, unitPrice: 100, shipmentId: id }).shipmentId).toBe(id);
    expect(updateInvoiceRowSchema.parse({ shipmentId: id, quantity: 2 })).not.toHaveProperty("shipmentId");
  });
  it("tracking interval is one of three", () => {
    expect(updateFreightSettingsSchema.parse({ trackingInterval: "every_4h" }).trackingInterval).toBe("every_4h");
    expect(() => updateFreightSettingsSchema.parse({ trackingInterval: "weekly" })).toThrow();
  });
});

describe("defaultFreightProductId", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("is an optional uuid on create, and nullable on update to clear the förval", () => {
    expect(createCustomerSchema.parse({ name: "Kund AB", defaultFreightProductId: ID }).defaultFreightProductId).toBe(ID);
    expect(createCustomerSchema.parse({ name: "Kund AB" }).defaultFreightProductId).toBeUndefined();
    expect(updateCustomerSchema.parse({ defaultFreightProductId: null }).defaultFreightProductId).toBeNull();
  });

  it("rejects a value that is not a uuid", () => {
    expect(createCustomerSchema.safeParse({ name: "Kund AB", defaultFreightProductId: "dhl" }).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ defaultFreightProductId: "dhl" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ name: "Kund AB", defaultFreightProductId: null }).success).toBe(false);
  });
});

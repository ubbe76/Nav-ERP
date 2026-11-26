import { describe, expect, it } from "vitest";
import { copyCustomerToSupplierSchema, copySupplierToCustomerSchema } from "@navet/shared";
import { duplicateSearchTerms, likelyDuplicates, partnerCopyBody, PARTNER_COPY_TARGET } from "../../web/lib/partnerCopy";

// Kopiera till kund / Kopiera till leverantör — the web's pure rules: the
// body the button posts, and who the dialog names as probably the same
// company on the other side.

describe("Kopiera till kund / leverantör — webbens regler", () => {
  it("posts the source under its own name, the number only when typed — what the schemas take", () => {
    const id = crypto.randomUUID();
    expect(partnerCopyBody("supplier", id, "")).toEqual({ supplierId: id });
    expect(partnerCopyBody("supplier", id, " K-1 ")).toEqual({ supplierId: id, customerNumber: "K-1" });
    expect(partnerCopyBody("customer", id, "  ")).toEqual({ customerId: id });
    expect(partnerCopyBody("customer", id, "L-1")).toEqual({ customerId: id, supplierNumber: "L-1" });
    expect(copySupplierToCustomerSchema.safeParse(partnerCopyBody("supplier", id, "K-1")).success).toBe(true);
    expect(copyCustomerToSupplierSchema.safeParse(partnerCopyBody("customer", id, "L-1")).success).toBe(true);
    expect(PARTNER_COPY_TARGET.supplier.createEndpoint).toBe("/api/v1/customers/from-supplier");
    expect(PARTNER_COPY_TARGET.customer.createEndpoint).toBe("/api/v1/suppliers/from-customer");
  });

  it("searches on the organisationsnummer and the name, each once", () => {
    expect(duplicateSearchTerms({ name: " Exempel AB ", orgNumber: "556000-0000" })).toEqual(["556000-0000", "Exempel AB"]);
    expect(duplicateSearchTerms({ name: "Exempel AB", orgNumber: null })).toEqual(["Exempel AB"]);
    expect(duplicateSearchTerms({ name: "Exempel AB", orgNumber: " " })).toEqual(["Exempel AB"]);
  });

  it("names the same organisationsnummer (digits only) or the same name, each partner once", () => {
    const source = { name: "Exempel  AB", orgNumber: "556000-0000" };
    const found = likelyDuplicates(source, [
      { id: "1", number: "1001", name: "Annat namn AB", orgNumber: "5560000000" },
      { id: "2", number: "1002", name: "exempel ab", orgNumber: null },
      { id: "3", number: "1003", name: "Exempel AB Göteborg", orgNumber: "556999-9999" },
      { id: "1", number: "1001", name: "Annat namn AB", orgNumber: "5560000000" },
    ]);
    expect(found.map((p) => [p.id, p.reason])).toEqual([
      ["1", "org"],
      ["2", "name"],
    ]);
    // Without an organisationsnummer only the name counts.
    expect(likelyDuplicates({ name: "Exempel AB", orgNumber: null }, [{ id: "4", number: "1004", name: "Exempel AB", orgNumber: null }]).map((p) => p.reason)).toEqual([
      "name",
    ]);
    expect(likelyDuplicates({ name: "Exempel AB", orgNumber: null }, [{ id: "5", number: "1005", name: "Annat AB", orgNumber: null }])).toEqual([]);
  });
});

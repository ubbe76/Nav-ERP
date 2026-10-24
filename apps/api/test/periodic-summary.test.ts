import { describe, expect, it } from "vitest";
import {
  aggregatePeriodicSummary,
  buyerVatNumber,
  formatKronor,
  formatOre,
  ledgerDifference,
  ledgerDifferenceWarnings,
  oreToKronor,
  periodicSummaryPeriod,
  type EuSalesLine,
} from "../src/modules/economy/service/periodic-summary.js";

// Periodisk sammanställning (Momskoder steg 3) — the pure half: the period
// rule, the buyer's number as reported and the summing per buyer.

let seq = 0;
function line(overrides: Partial<EuSalesLine>): EuSalesLine {
  seq += 1;
  return {
    invoiceId: `inv-${seq}`,
    invoiceNumber: `FA${String(1000 + seq)}`,
    invoiceType: "invoice",
    vatNumber: "DE123456789",
    customerId: "cust-de",
    customerName: "Kunde GmbH",
    customerCountry: "DE",
    code: "EUV",
    amount: "0",
    ...overrides,
  };
}

describe("periodicSummaryPeriod", () => {
  it("takes a calendar month as ÅÅMM", () => {
    expect(periodicSummaryPeriod("2026-10-01", "2026-10-31")).toEqual({ kind: "month", periodCode: "2610", fileSuffix: "2610" });
    expect(periodicSummaryPeriod("2009-10-01", "2009-10-31")?.periodCode).toBe("0910");
    expect(periodicSummaryPeriod("2028-02-01", "2028-02-29")?.periodCode).toBe("2802");
  });

  it("takes a calendar quarter as ÅÅ-K (and ÅÅKx in the file name)", () => {
    expect(periodicSummaryPeriod("2026-07-01", "2026-09-30")).toEqual({ kind: "quarter", periodCode: "26-3", fileSuffix: "26K3" });
    expect(periodicSummaryPeriod("2026-01-01", "2026-03-31")?.periodCode).toBe("26-1");
    expect(periodicSummaryPeriod("2026-10-01", "2026-12-31")?.periodCode).toBe("26-4");
  });

  it("refuses everything else", () => {
    expect(periodicSummaryPeriod("2026-10-02", "2026-10-31")).toBeNull();
    expect(periodicSummaryPeriod("2026-10-01", "2026-10-30")).toBeNull();
    expect(periodicSummaryPeriod("2028-02-01", "2028-02-28")).toBeNull();
    // A three-month run that is not a calendar quarter.
    expect(periodicSummaryPeriod("2026-02-01", "2026-04-30")).toBeNull();
    expect(periodicSummaryPeriod("2026-01-01", "2026-06-30")).toBeNull();
    expect(periodicSummaryPeriod("2026-01-01", "2026-12-31")).toBeNull();
    expect(periodicSummaryPeriod("2026-10-31", "2026-10-01")).toBeNull();
  });
});

describe("buyerVatNumber", () => {
  it("normalizes to upper case letters and digits", () => {
    expect(buyerVatNumber("de 123.456.789", "DE")).toEqual({ status: "ok", vatNumber: "DE123456789" });
    expect(buyerVatNumber("esa-28480514", "ES")).toEqual({ status: "ok", vatNumber: "ESA28480514" });
  });

  it("adds the customer's country prefix to an older number without one (Greece EL)", () => {
    expect(buyerVatNumber("123456789", "DE")).toEqual({ status: "ok", vatNumber: "DE123456789" });
    expect(buyerVatNumber("U12345678", "AT")).toEqual({ status: "ok", vatNumber: "ATU12345678" });
    expect(buyerVatNumber("A28480514", "ES")).toEqual({ status: "ok", vatNumber: "ESA28480514" });
    expect(buyerVatNumber("123456789", "GR")).toEqual({ status: "ok", vatNumber: "EL123456789" });
    expect(buyerVatNumber("123456789", "gr")).toEqual({ status: "ok", vatNumber: "EL123456789" });
  });

  it("writes a GR prefix as EL", () => {
    expect(buyerVatNumber("GR123456789", "GR")).toEqual({ status: "ok", vatNumber: "EL123456789" });
  });

  it("keeps another member state's number as it is", () => {
    expect(buyerVatNumber("ATU12345678", "DE")).toEqual({ status: "ok", vatNumber: "ATU12345678" });
  });

  it("reports a missing number", () => {
    expect(buyerVatNumber(null, "DE")).toEqual({ status: "missing" });
    expect(buyerVatNumber("  - ", "DE")).toEqual({ status: "missing" });
  });

  it("refuses a Swedish number, an unprefixed number outside the EU and a number that is too long", () => {
    expect(buyerVatNumber("SE556677889901", "DE")).toEqual({ status: "invalid", vatNumber: "SE556677889901" });
    expect(buyerVatNumber("556677889901", "SE")).toEqual({ status: "invalid", vatNumber: "556677889901" });
    expect(buyerVatNumber("123456789", "NO")).toEqual({ status: "invalid", vatNumber: "123456789" });
    // 2 + 13 characters — over Skatteverket's 14.
    expect(buyerVatNumber("DE1234567890123", "DE")).toEqual({ status: "invalid", vatNumber: "DE1234567890123" });
    expect(buyerVatNumber("DE1", "DE")).toEqual({ status: "invalid", vatNumber: "DE1" });
  });
});

describe("oreToKronor / formatKronor", () => {
  it("rounds half away from zero", () => {
    expect(oreToKronor(10050)).toBe(101);
    expect(oreToKronor(10049)).toBe(100);
    expect(oreToKronor(-10050)).toBe(-101);
    expect(oreToKronor(-10049)).toBe(-100);
    expect(oreToKronor(-49)).toBe(0);
    expect(Object.is(oreToKronor(-49), -0)).toBe(false);
    expect(oreToKronor(0)).toBe(0);
  });

  it("groups thousands with a space and an ASCII minus", () => {
    expect(formatKronor(1234567)).toBe("1 234 567");
    expect(formatKronor(-2000)).toBe("-2 000");
    expect(formatKronor(999)).toBe("999");
  });
});

describe("aggregatePeriodicSummary", () => {
  it("sums goods (EUV) and services (EUT) per buyer, sorted on the VAT number", () => {
    const { rows, warnings } = aggregatePeriodicSummary([
      line({ vatNumber: "FI01409351", customerId: "fi", customerName: "Oy Ab", customerCountry: "FI", code: "EUV", amount: "16400.00" }),
      line({ vatNumber: "ESA28480514", customerId: "es", customerName: "SA", customerCountry: "ES", code: "EUV", amount: "3200.00" }),
      line({ vatNumber: "ESA28480514", customerId: "es", customerName: "SA", customerCountry: "ES", code: "EUT", amount: "15300.00" }),
    ]);
    expect(warnings).toEqual([]);
    expect(rows.map((row) => [row.vatNumber, row.goods, row.triangular, row.services, row.goodsUsed, row.servicesUsed])).toEqual([
      ["ESA28480514", 3200, null, 15300, true, true],
      ["FI01409351", 16400, null, 0, true, false],
    ]);
  });

  it("subtracts a credit note — a buyer that nets to zero keeps a 0 in the used column", () => {
    const invoice = line({ amount: "1000.00", invoiceNumber: "FA1001" });
    const credit = line({ amount: "1000.00", invoiceType: "credit", invoiceNumber: "FA1002" });
    const { rows } = aggregatePeriodicSummary([credit, invoice]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vatNumber: "DE123456789", goods: 0, services: 0, goodsUsed: true, servicesUsed: false });
    expect(rows[0]!.invoices.map((ref) => ref.invoiceNumber)).toEqual(["FA1001", "FA1002"]);
  });

  it("gives a negative net when the credits exceed the sales", () => {
    const { rows } = aggregatePeriodicSummary([
      line({ code: "EUT", amount: "500.00" }),
      line({ code: "EUT", amount: "1200.00", invoiceType: "credit" }),
    ]);
    expect(rows[0]).toMatchObject({ goods: 0, services: -700, goodsUsed: false, servicesUsed: true });
  });

  it("sums öre first and rounds per row", () => {
    const { rows } = aggregatePeriodicSummary([
      line({ amount: "0.30" }),
      line({ amount: "0.30" }),
      line({ code: "EUT", amount: "100.50" }),
    ]);
    expect(rows[0]).toMatchObject({ goods: 1, services: 101 });
  });

  it("lists each VAT number once, whichever customers and invoices carry it", () => {
    const { rows } = aggregatePeriodicSummary([
      line({ vatNumber: "de 123 456 789", customerId: "b", customerName: "Beta GmbH", amount: "100.00", invoiceNumber: "FA1003" }),
      line({ vatNumber: "DE123456789", customerId: "a", customerName: "Alfa GmbH", amount: "200.00", invoiceNumber: "FA1001" }),
      line({ vatNumber: "123456789", customerId: "a", customerName: "Alfa GmbH", amount: "50.00", invoiceNumber: "FA1002" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goods).toBe(350);
    expect(rows[0]!.customers).toEqual([
      { id: "a", name: "Alfa GmbH" },
      { id: "b", name: "Beta GmbH" },
    ]);
    expect(rows[0]!.invoices.map((ref) => ref.invoiceNumber)).toEqual(["FA1001", "FA1002", "FA1003"]);
  });

  it("leaves invoices without a usable number out of the rows and warns per customer", () => {
    const missing1 = line({ vatNumber: null, customerId: "fr", customerName: "Client SARL", customerCountry: "FR", amount: "10.00" });
    const missing2 = line({ vatNumber: "", customerId: "fr", customerName: "Client SARL", customerCountry: "FR", amount: "20.00" });
    const swedish = line({ vatNumber: "SE556677889901", customerId: "se", customerName: "Svensk AB", customerCountry: "SE", amount: "30.00" });
    const norway = line({ vatNumber: "123456789", customerId: "no", customerName: "Norsk AS", customerCountry: "NO", amount: "40.00" });
    const { rows, warnings } = aggregatePeriodicSummary([missing1, missing2, swedish, norway]);
    expect(rows).toEqual([]);
    expect(warnings.map((warning) => [warning.kind, warning.invoices.map((ref) => ref.id)])).toEqual([
      ["missing_vat_number", [missing1.invoiceId, missing2.invoiceId]],
      ["invalid_vat_number", [norway.invoiceId]],
      ["invalid_vat_number", [swedish.invoiceId]],
      ["non_eu_country", [norway.invoiceId]],
    ]);
    expect(warnings[0]!.message).toBe(
      "Client SARL: fakturor med EU-försäljning saknar köparens momsregistreringsnummer och kommer inte med i sammanställningen"
    );
    expect(warnings[2]!.message).toContain("SE556677889901");
    expect(warnings[3]!.message).toBe("Norsk AS har landet NO, som inte är ett EU-land — kontrollera momskoden på fakturorna");
  });

  it("keeps a valid number of a customer outside the EU in the rows but warns about the country", () => {
    const { rows, warnings } = aggregatePeriodicSummary([
      line({ vatNumber: "DE123456789", customerId: "ch", customerName: "Schweiz AG", customerCountry: "CH", amount: "100.00" }),
    ]);
    expect(rows.map((row) => row.vatNumber)).toEqual(["DE123456789"]);
    expect(warnings.map((warning) => warning.kind)).toEqual(["non_eu_country"]);
  });
});

describe("ledgerDifferenceWarnings / ledgerDifference (öre)", () => {
  it("is silent when the rows' öre match ruta 35 and 39", () => {
    expect(ledgerDifferenceWarnings({ goods: 100025, services: 50000 }, { box35: 100025, box39: 50000 })).toEqual([]);
    expect(ledgerDifference(100025, 100025)).toBe(0);
  });

  it("warns per column that differs, in kronor and öre", () => {
    const warnings = ledgerDifferenceWarnings({ goods: 1000000, services: 50000 }, { box35: 1200050, box39: 50000 });
    expect(warnings).toEqual([
      {
        kind: "ledger_difference",
        message:
          "Varor: sammanställningen 10 000,00 kr, bokfört i ruta 35 12 000,50 kr (skillnad -2 000,50 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod",
        invoices: [],
      },
    ]);
    expect(ledgerDifferenceWarnings({ goods: 0, services: 70000 }, { box35: 0, box39: 50000 })[0]!.message).toContain("Tjänster");
  });

  it("warns about a few öre that round away, and rounds the difference half away from zero", () => {
    expect(ledgerDifferenceWarnings({ goods: 100000, services: 0 }, { box35: 100030, box39: 0 })).toHaveLength(1);
    expect(ledgerDifference(100000, 100030)).toBe(-0.3);
    expect(ledgerDifference(100000, 100050)).toBe(-0.5);
    expect(ledgerDifference(100050, 100000)).toBe(0.5);
  });
});

describe("formatOre", () => {
  it("writes kronor with two decimals, a space per thousand and an ASCII minus", () => {
    expect(formatOre(123456789)).toBe("1 234 567,89");
    expect(formatOre(-30)).toBe("-0,30");
    expect(formatOre(5)).toBe("0,05");
    expect(formatOre(0)).toBe("0,00");
  });
});

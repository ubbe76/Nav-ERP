import { describe, expect, it } from "vitest";
import { sieAmount, sieDate, sieField } from "../src/modules/economy/service/sie-format.js";

// Pure formatting rules straight from the SIE 4 spec (§5.7–5.10).

describe("sieField", () => {
  it("leaves a bare token unquoted", () => {
    expect(sieField("1930")).toBe("1930");
    expect(sieField("PC8")).toBe("PC8");
  });

  it("quotes anything containing a space", () => {
    expect(sieField("Kundfordringar hos koncern")).toBe('"Kundfordringar hos koncern"');
  });

  it("quotes an empty field so the column is not lost", () => {
    expect(sieField("")).toBe('""');
  });

  it("escapes embedded quotes with a backslash", () => {
    expect(sieField('Kassa "special"')).toBe('"Kassa \\"special\\""');
  });

  it("escapes backslashes too", () => {
    expect(sieField("A\\B")).toBe('"A\\\\B"');
  });

  it("strips control characters, which the spec forbids inside strings", () => {
    expect(sieField("Rad\tmed\nstyrtecken")).toBe('"Rad med styrtecken"');
  });
});

describe("sieAmount", () => {
  it("uses a decimal point and drops the decimals when the amount is whole", () => {
    expect(sieAmount(1000)).toBe("1000");
    expect(sieAmount(23780.78)).toBe("23780.78");
  });

  it("writes credit as a negative number and never writes a plus sign", () => {
    expect(sieAmount(-2380.39)).toBe("-2380.39");
    expect(sieAmount(2380.39)).toBe("2380.39");
  });

  it("never uses a thousands separator", () => {
    expect(sieAmount(1234567.89)).toBe("1234567.89");
  });

  it("caps at two decimals", () => {
    expect(sieAmount(1.005)).toBe("1.01");
    expect(sieAmount(0.1 + 0.2)).toBe("0.3");
  });

  it("writes zero as a bare 0, never -0", () => {
    expect(sieAmount(0)).toBe("0");
    expect(sieAmount(-0)).toBe("0");
    expect(sieAmount(-0.001)).toBe("0");
  });
});

describe("sieDate", () => {
  it("turns an ISO date into YYYYMMDD", () => {
    expect(sieDate("2026-01-01")).toBe("20260101");
    expect(sieDate("2026-12-31")).toBe("20261231");
  });
});

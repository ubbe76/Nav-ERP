import { describe, expect, it } from "vitest";
import {
  PeriodicSummaryAmountTooLargeError,
  buildPeriodicSummaryFile,
  contactNameField,
  normalizeContactPhone,
  periodicSummaryFileName,
  reporterVatDigits,
  type PeriodicSummaryFileInput,
} from "../src/modules/economy/service/periodic-summary-file.js";

// Skatteverket, "Lämna periodisk sammanställning med filöverföring" — the
// page's example 1 without its avropslager row (Nav has none) and its
// trepartshandel amount (no momskod carries it), and without the stray
// space before the e-mail.
const EXAMPLE = [
  "SKV574008;",
  "556000016701;2001;Per Persson;0123-45690;post@filmkopia.se",
  "DK31283522;21700;;;",
  "ESA28480514;3200;;15300;",
  "FI01409351;16400;;;",
].join("\r\n");

function input(overrides: Partial<PeriodicSummaryFileInput> = {}): PeriodicSummaryFileInput {
  return {
    reporterVatDigits: "556000016701",
    periodCode: "2001",
    contactName: "Per Persson",
    contactPhone: "0123-45690",
    contactEmail: "post@filmkopia.se",
    rows: [
      { vatNumber: "DK31283522", goods: 21700, services: null },
      { vatNumber: "ESA28480514", goods: 3200, services: 15300 },
      { vatNumber: "FI01409351", goods: 16400, services: null },
    ],
    ...overrides,
  };
}

describe("buildPeriodicSummaryFile", () => {
  it("writes the page's example, CRLF and ISO-8859-1, every line terminated", () => {
    const file = buildPeriodicSummaryFile(input());
    expect(file.toString("latin1")).toBe(`${EXAMPLE}\r\n`);
    expect(file.includes("\n\r\n")).toBe(false);
    expect(file.toString("latin1").split("\r\n").filter((l) => l === "")).toEqual([""]);
  });

  it("writes a quarter code and an empty e-mail field", () => {
    const text = buildPeriodicSummaryFile(input({ periodCode: "26-3", contactEmail: null, rows: [] })).toString("latin1");
    expect(text).toBe("SKV574008;\r\n556000016701;26-3;Per Persson;0123-45690;\r\n");
  });

  it("writes 0 for a used column that nets to zero and a leading minus for a negative amount", () => {
    const text = buildPeriodicSummaryFile(
      input({
        rows: [
          { vatNumber: "DE123456789", goods: 0, services: null },
          { vatNumber: "FR12345678901", goods: null, services: -700 },
          { vatNumber: "NL123456789B01", goods: -0, services: 0 },
        ],
      })
    ).toString("latin1");
    expect(text.split("\r\n").slice(2, 5)).toEqual(["DE123456789;0;;;", "FR12345678901;;;-700;", "NL123456789B01;0;;0;"]);
  });

  it("allows 12 characters per amount including the minus, and refuses 13", () => {
    const ok = buildPeriodicSummaryFile(
      input({ rows: [{ vatNumber: "DE123456789", goods: 999_999_999_999, services: -99_999_999_999 }] })
    ).toString("latin1");
    expect(ok).toContain("DE123456789;999999999999;;-99999999999;");
    expect(() => buildPeriodicSummaryFile(input({ rows: [{ vatNumber: "DE123456789", goods: 1_000_000_000_000, services: null }] }))).toThrow(
      PeriodicSummaryAmountTooLargeError
    );
    expect(() => buildPeriodicSummaryFile(input({ rows: [{ vatNumber: "DE123456789", goods: null, services: -100_000_000_000 }] }))).toThrow(
      PeriodicSummaryAmountTooLargeError
    );
  });

  it("encodes Swedish letters in latin1 and replaces anything outside it with ?", () => {
    const file = buildPeriodicSummaryFile(input({ contactName: "Åsa Öberg Łukasz", rows: [] }));
    expect(file.toString("latin1")).toContain("556000016701;2001;Åsa Öberg ?ukasz;0123-45690;");
    expect(file.includes(Buffer.from([0xc5]))).toBe(true); // Å
    expect(file.length).toBe(file.toString("latin1").length);
  });
});

describe("the reporter's fields", () => {
  it("takes the company's momsregistreringsnummer as twelve digits without SE", () => {
    expect(reporterVatDigits("SE556000016701")).toBe("556000016701");
    expect(reporterVatDigits("se 556000-0167 01")).toBe("556000016701");
    expect(reporterVatDigits("556000016701")).toBe("556000016701");
    expect(reporterVatDigits("SE5560000167")).toBeNull();
    expect(reporterVatDigits("DE123456789012")).toBeNull();
    expect(reporterVatDigits(null)).toBeNull();
  });

  it("normalizes the phone (spaces out) and checks Skatteverket's format", () => {
    expect(normalizeContactPhone("08-123 456 78")).toBe("08-12345678");
    expect(normalizeContactPhone("0123-45690")).toBe("0123-45690");
    expect(normalizeContactPhone("+46 8 123 456 78")).toBe("+46812345678");
    expect(normalizeContactPhone("+46-812345678")).toBe("+46-812345678");
    expect(normalizeContactPhone("0812345678")).toBe("0812345678");
    expect(normalizeContactPhone("08-12-34")).toBeNull();
    expect(normalizeContactPhone("08/123456")).toBeNull();
    expect(normalizeContactPhone("-08123")).toBeNull();
    expect(normalizeContactPhone("08-")).toBeNull();
    expect(normalizeContactPhone("1234567890-1234567")).toBeNull(); // 18 characters
    expect(normalizeContactPhone("123456789-1234567")).toBe("123456789-1234567"); // 17
    expect(normalizeContactPhone(null)).toBeNull();
    expect(normalizeContactPhone("  ")).toBeNull();
  });

  it("keeps the contact name to one field of at most 35 characters", () => {
    expect(contactNameField("  Per Persson ")).toBe("Per Persson");
    expect(contactNameField("Per;Persson")).toBe("Per Persson");
    expect(contactNameField("Per\tPersson")).toBe("Per Persson");
    expect(contactNameField("x".repeat(35))).toBe("x".repeat(35));
    expect(contactNameField("x".repeat(36))).toBeNull();
    expect(contactNameField("")).toBeNull();
    expect(contactNameField(null)).toBeNull();
  });

  it("names the file with letters and digits only", () => {
    expect(periodicSummaryFileName("2610")).toBe("PeriodiskSammanstallning2610.txt");
    expect(periodicSummaryFileName("26K3")).toBe("PeriodiskSammanstallning26K3.txt");
  });
});

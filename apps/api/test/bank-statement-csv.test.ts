import { describe, expect, it } from "vitest";
import { BankStatementCsvMappingError } from "../src/modules/banking/service/banking.errors.js";
import { isAmbiguousCsvAmount, parseBankCsvAmount, parseBankCsvDate, parseBankStatementCsv, readBankCsvHeaders, rowOrder } from "../src/modules/banking/service/bank-statement-csv.js";

const MAPPING = { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text", balanceColumn: "Saldo", referenceColumn: "Referens" };

// A Swedish internet bank export: semicolons, decimal comma, thousands
// space, newest first, a summary line at the top.
const FILE = [
  "Kontoutdrag Företagskonto 1234-5678 (uttag 2024-10-10)",
  "Bokföringsdag;Valutadag;Text;Referens;Belopp;Saldo",
  "2024-10-09;2024-10-09;KORTKÖP ICA;;-899,00;107 580,00",
  "2024-10-09;2024-10-09;BG INBETALNING;501262;10 000,00;108 479,00",
  "2024-10-08;2024-10-08;AVGIFT;;-150,00;98 479,00",
  "",
].join("\r\n");

describe("parseBankCsvAmount", () => {
  it("reads Swedish decimal commas with thousands spaces, and the other way round when told", () => {
    expect(parseBankCsvAmount("1 234,56")).toBe(1234.56);
    expect(parseBankCsvAmount("-1.234,56")).toBe(-1234.56);
    expect(parseBankCsvAmount("1,234.56", false)).toBe(1234.56);
    expect(parseBankCsvAmount("1.234,56", true)).toBe(1234.56);
    expect(parseBankCsvAmount("−12,50")).toBe(-12.5);
    expect(parseBankCsvAmount("12,50-")).toBe(-12.5);
    expect(parseBankCsvAmount("250 kr")).toBe(250);
    expect(parseBankCsvAmount("")).toBeNull();
    expect(parseBankCsvAmount("abc")).toBeNull();
    expect(parseBankCsvAmount("1,2,3")).toBeNull();
  });

  it("flags a lone point followed by exactly three digits as ambiguous unless the convention is stated", () => {
    expect(isAmbiguousCsvAmount("1.234")).toBe(true);
    expect(isAmbiguousCsvAmount("-12.500 kr")).toBe(true);
    expect(isAmbiguousCsvAmount("1.234", true)).toBe(false);
    expect(isAmbiguousCsvAmount("1.234", false)).toBe(false);
    expect(isAmbiguousCsvAmount("1.23")).toBe(false);
    expect(isAmbiguousCsvAmount("1.234,50")).toBe(false);
    expect(isAmbiguousCsvAmount("1234.567")).toBe(false);
  });
});

describe("rowOrder", () => {
  const r = (bookingDate: string, amount: number, balance: number | null) => ({ bookingDate, amount, balance });
  it("decides by the dates when they differ, by the balance chain within one day", () => {
    expect(rowOrder([r("2024-10-09", -1, 1), r("2024-10-08", -1, 2)])).toBe("descending");
    expect(rowOrder([r("2024-10-08", -1, 1), r("2024-10-09", -1, 0)])).toBe("ascending");
    // One day, newest first: 107 580 after −899 means the row below carried 108 479.
    expect(rowOrder([r("2024-10-09", -899, 107580), r("2024-10-09", 10000, 108479), r("2024-10-09", -150, 98479)])).toBe("descending");
    // One day, oldest first.
    expect(rowOrder([r("2024-10-09", -150, 98479), r("2024-10-09", 10000, 108479), r("2024-10-09", -899, 107580)])).toBe("ascending");
    expect(rowOrder([r("2024-10-09", -1, null), r("2024-10-09", -1, null)])).toBe("unknown");
    expect(rowOrder([r("2024-10-09", -1, 5), r("2024-10-09", -1, 7)])).toBe("unknown");
    expect(rowOrder([r("2024-10-09", -1, 5)])).toBe("unknown");
  });
});

describe("parseBankCsvDate", () => {
  it("accepts the formats banks export", () => {
    expect(parseBankCsvDate("2024-10-09")).toBe("2024-10-09");
    expect(parseBankCsvDate("2024-10-09 14:05")).toBe("2024-10-09");
    expect(parseBankCsvDate("20241009")).toBe("2024-10-09");
    expect(parseBankCsvDate("09.10.2024")).toBe("2024-10-09");
    expect(parseBankCsvDate("9/10/2024")).toBe("2024-10-09");
    expect(parseBankCsvDate("2024/10/09")).toBe("2024-10-09");
    expect(parseBankCsvDate("2024-02-30")).toBeNull();
    expect(parseBankCsvDate("Saldo")).toBeNull();
  });
});

describe("parseBankStatementCsv", () => {
  it("maps the columns with skipRows, signs amounts, hashes the dedupe key and derives the balances", () => {
    const result = parseBankStatementCsv(Buffer.from(FILE, "utf8"), { ...MAPPING, skipRows: 1 }, "12345678", "SEK");
    expect(result.headers).toEqual(["Bokföringsdag", "Valutadag", "Text", "Referens", "Belopp", "Saldo"]);
    expect(result.warnings).toEqual([]);
    const { statement } = result;
    expect(statement).toMatchObject({ accountIdentifier: "12345678", currency: "SEK", fromDate: "2024-10-08", toDate: "2024-10-09", openingBalance: 98629, closingBalance: 107580, closingBalanceDate: "2024-10-09" });
    expect(statement.entries.map((e) => [e.bookingDate, e.amount, e.text, e.reference])).toEqual([
      ["2024-10-09", -899, "KORTKÖP ICA", null],
      ["2024-10-09", 10000, "BG INBETALNING", "501262"],
      ["2024-10-08", -150, "AVGIFT", null],
    ]);
    expect(statement.entries[1]!.references).toEqual(["501262"]);
    expect(statement.entries[0]!.dedupeKey).toMatch(/^12345678\|csv:[0-9a-f]{64}#1$/);
    expect(statement.entries[0]!.details).toEqual({ transactions: [], balance: 107580 });
  });

  it("reads a one-day export newest first by the balance chain, and warns about ambiguous points", () => {
    const oneDay = ["Bokföringsdag;Text;Belopp;Saldo", "2024-10-09;KORTKÖP;-899,00;107 580,00", "2024-10-09;INBETALNING;10 000,00;108 479,00"].join("\n");
    const result = parseBankStatementCsv(Buffer.from(oneDay), { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text", balanceColumn: "Saldo" }, "X", "SEK");
    expect(result.statement).toMatchObject({ openingBalance: 98479, closingBalance: 107580, closingBalanceDate: "2024-10-09" });
    expect(result.warnings).toEqual([]);
    const dotted = ["Bokföringsdag;Text;Belopp", "2024-10-09;A;1.234", "2024-10-09;B;-2.500"].join("\n");
    const ambiguous = parseBankStatementCsv(Buffer.from(dotted), { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" }, "X", "SEK");
    expect(ambiguous.statement.entries.map((e) => e.amount)).toEqual([1.23, -2.5]);
    expect(ambiguous.warnings).toHaveLength(1);
    expect(ambiguous.warnings[0]).toContain('rad 2 "1.234", rad 3 "-2.500"');
    expect(ambiguous.warnings[0]).toContain("decimalkomma eller decimalpunkt");
    const stated = parseBankStatementCsv(Buffer.from(dotted), { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text", decimalComma: true }, "X", "SEK");
    expect(stated.statement.entries.map((e) => e.amount)).toEqual([1234, -2500]);
    expect(stated.warnings).toEqual([]);
  });

  it("hashes the dedupe key on the given scope (the bank account's id), not the identifier", () => {
    const file = ["Bokföringsdag;Text;Belopp", "2024-10-09;AVGIFT;-150,00"].join("\n");
    const mapping = { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" };
    const scoped = parseBankStatementCsv(Buffer.from(file), mapping, "IDENT-1", "SEK", "account-uuid").statement.entries[0]!;
    const renamed = parseBankStatementCsv(Buffer.from(file), mapping, "IDENT-2", "SEK", "account-uuid").statement.entries[0]!;
    expect(scoped.dedupeKey).toMatch(/^account-uuid\|csv:[0-9a-f]{64}#1$/);
    expect(renamed.dedupeKey).toBe(scoped.dedupeKey);
    expect(renamed.dedupeKey).not.toBe(parseBankStatementCsv(Buffer.from(file), mapping, "IDENT-1", "SEK").statement.entries[0]!.dedupeKey);
  });

  it("the same file gives the same keys; two identical lines get #1 and #2", () => {
    const twice = ["Bokföringsdag;Text;Belopp", "2024-10-09;AVGIFT;-150,00", "2024-10-09;AVGIFT;-150,00"].join("\n");
    const mapping = { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" };
    const a = parseBankStatementCsv(Buffer.from(twice), mapping, "X", "SEK").statement.entries.map((e) => e.dedupeKey);
    const b = parseBankStatementCsv(Buffer.from(twice), mapping, "X", "SEK").statement.entries.map((e) => e.dedupeKey);
    expect(a).toEqual(b);
    expect(a[1]).toBe(`${a[0]!.slice(0, -2)}#2`);
  });

  it("reads windows-1252 with a comma delimiter and decimal point when told", () => {
    const text = 'Datum,Beskrivning,Summa\n2024-10-09,"Kaffe, kontor",-45.50\n';
    const buf = Buffer.from(text, "latin1");
    const result = parseBankStatementCsv(buf, { dateColumn: "Datum", amountColumn: "Summa", textColumn: "Beskrivning", delimiter: ",", decimalComma: false }, "X", "SEK");
    expect(result.statement.entries[0]).toMatchObject({ amount: -45.5, text: "Kaffe, kontor" });
    expect(result.statement.openingBalance).toBeNull();
    expect(result.statement.closingBalance).toBeNull();
  });

  it("reports a missing column and an unreadable cell as a mapping error, skips zero amounts with a warning", () => {
    expect(() => parseBankStatementCsv(Buffer.from(FILE), { ...MAPPING, skipRows: 1, amountColumn: "Summa" }, "X", "SEK")).toThrow(BankStatementCsvMappingError);
    expect(() => parseBankStatementCsv(Buffer.from(FILE), MAPPING, "X", "SEK")).toThrow(BankStatementCsvMappingError); // no skipRows: the header is not where expected
    const bad = ["Bokföringsdag;Text;Belopp", "2024-10-09;X;abc"].join("\n");
    expect(() => parseBankStatementCsv(Buffer.from(bad), { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" }, "X", "SEK")).toThrow(/är inget belopp/);
    const zero = ["Bokföringsdag;Text;Belopp", "2024-10-09;X;0,00", ";;", "Summa;;"].join("\n");
    const result = parseBankStatementCsv(Buffer.from(zero), { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" }, "X", "SEK");
    expect(result.statement.entries).toEqual([]);
    expect(result.warnings).toEqual(["Rad 2 har belopp 0 och hoppades över", "Rad 4 saknar belopp och hoppades över"]);
  });

  it("readBankCsvHeaders gives the header row the mapping step needs", () => {
    expect(readBankCsvHeaders(Buffer.from(FILE), { skipRows: 1 })).toEqual(["Bokföringsdag", "Valutadag", "Text", "Referens", "Belopp", "Saldo"]);
    expect(readBankCsvHeaders(Buffer.from(FILE))).toEqual(["Kontoutdrag Företagskonto 1234-5678 (uttag 2024-10-10)"]);
  });
});

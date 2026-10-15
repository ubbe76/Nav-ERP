import { describe, expect, it } from "vitest";
import { buildCsv, CSV_EXPORT_MAX_ROWS, type CsvColumn } from "@navet/shared";

// Pure serializer tests — no database. The authority for the Excel-friendly
// Swedish CSV conventions (`;`, CRLF, BOM, decimal comma).

const BOM = "﻿";

interface Row {
  name: string;
  amount: number | null;
  qty: number;
  date: string | null;
  stamp: string | null;
}

const COLS: CsvColumn<Row>[] = [
  { label: "Namn", value: (r) => r.name },
  { label: "Belopp", value: (r) => r.amount, format: "money" },
  { label: "Antal", value: (r) => r.qty, format: "number" },
  { label: "Datum", value: (r) => r.date, format: "date" },
  { label: "Tidpunkt", value: (r) => r.stamp, format: "datetime" },
];

function lines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("buildCsv", () => {
  it("emits one BOM, a semicolon header row and CRLF newlines", () => {
    const csv = buildCsv(COLS, []);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.indexOf(BOM, 1)).toBe(-1); // exactly one BOM
    expect(lines(csv)[0]).toBe(`${BOM}Namn;Belopp;Antal;Datum;Tidpunkt`);
  });

  it("renders money with two decimals and a decimal comma, no thousands separator", () => {
    const csv = buildCsv(COLS, [{ name: "A", amount: 12345.5, qty: 1, date: null, stamp: null }]);
    expect(lines(csv)[1]).toContain("12345,50");
  });

  it("renders numbers with up to four decimals, trailing zeros trimmed", () => {
    const csv = buildCsv(COLS, [
      { name: "A", amount: null, qty: 2.5, date: null, stamp: null },
      { name: "B", amount: null, qty: 3, date: null, stamp: null },
      { name: "C", amount: null, qty: 0.1235, date: null, stamp: null },
    ]);
    const [, a, b, c] = lines(csv);
    expect(a).toContain(";2,5;");
    expect(b).toContain(";3;");
    expect(c).toContain(";0,1235;");
  });

  it("renders null/undefined as empty cells", () => {
    const csv = buildCsv(COLS, [{ name: "A", amount: null, qty: 1, date: null, stamp: null }]);
    expect(lines(csv)[1]).toBe("A;;1;;");
  });

  it("passes dates through and renders datetimes in Europe/Stockholm", () => {
    // 2026-03-31T22:30Z is 2026-04-01 00:30 in Stockholm (CEST).
    const csv = buildCsv(COLS, [
      { name: "A", amount: null, qty: 1, date: "2026-08-22", stamp: "2026-03-31T22:30:00.000Z" },
    ]);
    expect(lines(csv)[1]).toContain("2026-08-22");
    expect(lines(csv)[1]).toContain("2026-04-01 00:30");
  });

  it("quotes only cells containing separator, quote or newline, doubling quotes", () => {
    const csv = buildCsv(COLS, [
      { name: "Skruv; rostfri", amount: null, qty: 1, date: null, stamp: null },
      { name: 'Bult "special"', amount: null, qty: 1, date: null, stamp: null },
      { name: "Rad\nbryt", amount: null, qty: 1, date: null, stamp: null },
      { name: "Vanlig", amount: null, qty: 1, date: null, stamp: null },
    ]);
    expect(csv).toContain('"Skruv; rostfri"');
    expect(csv).toContain('"Bult ""special"""');
    expect(csv).toContain('"Rad\nbryt"');
    expect(csv).not.toContain('"Vanlig"');
  });

  it("ends with a trailing CRLF after the last row", () => {
    const csv = buildCsv(COLS, [{ name: "A", amount: 1, qty: 1, date: null, stamp: null }]);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("exposes the export cap", () => {
    expect(CSV_EXPORT_MAX_ROWS).toBe(10_000);
  });

  it("neutralizes Excel formula injection in text cells with an apostrophe prefix", () => {
    const csv = buildCsv(COLS, [
      { name: '=HYPERLINK("http://evil";"Öppna")', amount: null, qty: 1, date: null, stamp: null },
      { name: "+46 70 123", amount: null, qty: 1, date: null, stamp: null },
      { name: "@handle", amount: null, qty: 1, date: null, stamp: null },
      { name: "- se bilaga", amount: null, qty: 1, date: null, stamp: null },
    ]);
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).toContain("'+46 70 123");
    expect(csv).toContain("'@handle");
    expect(csv).toContain("'- se bilaga");
  });

  it("does not touch our own numeric renderings with the injection guard", () => {
    const csv = buildCsv(COLS, [{ name: "A", amount: -12.5, qty: -3, date: null, stamp: null }]);
    expect(lines(csv)[1]).toBe("A;-12,50;-3;;");
  });
});

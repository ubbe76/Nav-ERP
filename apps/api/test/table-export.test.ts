import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { validateXML } from "xmllint-wasm";
import {
  buildCsv,
  CSV_EXPORT_MAX_ROWS,
  exportCell,
  exportTable,
  listQuerySchema,
  tableCsv,
  type CsvColumn,
} from "@navet/shared";
import {
  buildStoredZip,
  excelDateSerial,
  excelDateTimeSerial,
  readStoredZipEntries,
  writeXlsx,
} from "../src/modules/system/service/xlsx-writer.js";
import { renderExport, tableXlsx, XLSX_CONTENT_TYPE, xlsxTwinPath } from "../src/modules/system/service/table-export.js";
import { registerListCsvRoute, registerTableExportRoutes } from "../src/modules/system/routes/csv-export.js";
import { buildImportTemplate } from "../src/modules/import/service/import-template.js";
import { expectXlsxMatchesCsv, readXlsxRows } from "./helpers/read-xlsx.js";

// #35 etapp 1: Excel beside every CSV. The writer's typed cells, the ONE
// column model both renderings share, and the route helpers' /xlsx twins —
// no database (the real lists and reports are covered in their own files).

async function assertWellFormed(name: string, xml: string): Promise<void> {
  const fileName = name.replace(/[^A-Za-z0-9.]/g, "_");
  const result = await validateXML({ xml: [{ fileName, contents: xml }], normalization: "format" });
  expect(result.errors.map((e) => e.message), name).toEqual([]);
}

describe("xlsx writer: number and date cells", () => {
  const workbook = () =>
    writeXlsx({
      sheets: [
        {
          name: "Export",
          freezeHeader: true,
          rows: [
            [{ value: "Text", bold: true }, { value: "Tal", bold: true }, { value: "Belopp", bold: true }, { value: "Datum", bold: true }, { value: "Tid", bold: true }],
            ["007", { number: 12.5 }, { number: 1234.5, format: "money" }, { date: "2026-11-12" }, { dateTime: "2026-11-12 14:05" }],
            ["=1+1", { number: -3 }, { number: Number.NaN }, { date: "inte ett datum" }, null],
          ],
        },
      ],
    });

  it("reads back as real numbers and dates through the import's reader", async () => {
    const rows = await readXlsxRows(workbook());
    expect(rows[0]).toEqual(["Text", "Tal", "Belopp", "Datum", "Tid"]);
    expect(rows[1]![0]).toBe("007"); // text stays text — the leading zeros survive
    expect(rows[1]![1]).toBe(12.5);
    expect(rows[1]![2]).toBe(1234.5);
    expect(rows[1]![3]).toEqual(new Date(Date.UTC(2026, 10, 12)));
    expect(Math.round((rows[1]![4] as Date).getTime() / 1000)).toBe(Date.UTC(2026, 10, 12, 14, 5) / 1000);
    // A formula-looking text is an inline string, never a formula.
    expect(rows[2]![0]).toBe("=1+1");
    expect(rows[2]![1]).toBe(-3);
    // A non-finite number and an unreadable date leave the cell empty.
    expect(rows[2]![2] ?? null).toBeNull();
    expect(rows[2]![3] ?? null).toBeNull();
  });

  it("writes <v> cells with the money and date styles, and well-formed parts", async () => {
    const parts = readStoredZipEntries(workbook());
    const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet).toContain(`<c r="B2"><v>12.5</v></c>`);
    expect(sheet).toContain(`<c r="C2" s="5"><v>1234.5</v></c>`);
    expect(sheet).toContain(`<c r="D2" s="6"><v>${excelDateSerial("2026-11-12")}</v></c>`);
    expect(sheet).toContain(`<c r="E2" s="7"><v>`);
    expect(sheet).toContain(`<c r="A2" t="inlineStr">`);
    expect(sheet).not.toContain("NaN");
    expect(sheet).toContain(`state="frozen"`);
    const styles = parts.get("xl/styles.xml")!.toString("utf8");
    expect(styles).toContain(`formatCode="yyyy\\-mm\\-dd"`);
    expect(styles).toContain(`<cellXfs count="8">`);
    for (const [name, data] of parts) await assertWellFormed(name, data.toString("utf8"));
  });

  it("is deterministic, and a text-only workbook keeps the templates' style sheet", () => {
    expect(workbook().equals(workbook())).toBe(true);
    const template = readStoredZipEntries(buildImportTemplate("articles")).get("xl/styles.xml")!.toString("utf8");
    const textOnly = readStoredZipEntries(writeXlsx({ sheets: [{ name: "A", rows: [["a", { value: "b", bold: true }]] }] }));
    expect(textOnly.get("xl/styles.xml")!.toString("utf8")).toBe(template);
    expect(template).not.toContain("numFmts");
    expect(template).toContain(`<cellXfs count="5">`);
  });

  it("computes Excel serials from the calendar day alone", () => {
    expect(excelDateSerial("2000-01-01")).toBe(36526);
    expect(excelDateSerial("1900-03-01")).toBe(61);
    expect(excelDateSerial("2026-03-29")).toBe(excelDateSerial("2026-03-28")! + 1); // a DST day is one day
    expect(excelDateSerial("2026-02-30")).toBeNull();
    expect(excelDateSerial("2026-1-1")).toBeNull();
    expect(excelDateTimeSerial("2000-01-01 12:00")).toBe(36526.5);
    expect(excelDateTimeSerial("2000-01-01 25:00")).toBeNull();
  });

  it("buildStoredZip packs several files, readable and deterministic", () => {
    const files = [
      { name: "artiklar-del-1.xlsx", data: workbook() },
      { name: "artiklar-del-2.csv", data: Buffer.from("a;b\r\n", "utf8") },
    ];
    const zip = buildStoredZip(files);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    const entries = readStoredZipEntries(zip);
    expect([...entries.keys()]).toEqual(["artiklar-del-1.xlsx", "artiklar-del-2.csv"]);
    expect(entries.get("artiklar-del-1.xlsx")!.equals(files[0]!.data)).toBe(true);
    expect(buildStoredZip(files).equals(zip)).toBe(true);
  });
});

interface Row {
  number: string;
  name: string;
  count: number;
  quantity: string | null;
  amount: string | null;
  share: string | null;
  day: string | null;
  at: string | null;
}

const COLUMNS: CsvColumn<Row>[] = [
  { label: "Nummer", value: (r) => r.number },
  { label: "Benämning", value: (r) => r.name },
  { label: "Antal rader", value: (r) => r.count },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Belopp", value: (r) => r.amount, format: "money" },
  { label: "Andel %", cell: "percent", value: (r) => r.share },
  { label: "Datum", value: (r) => r.day, format: "date" },
  { label: "Skapad", value: (r) => r.at, format: "datetime" },
];

const ROWS: Row[] = [
  // 23:30 UTC on a winter day is 00:30 the NEXT day in Stockholm.
  { number: "0042", name: "Skruv; 8x40", count: 3, quantity: "12.50000", amount: "1234.565", share: "33.3333", day: "2026-11-12", at: "2026-01-15T23:30:00.000Z" },
  { number: "-7", name: "=SUM(A1)", count: 0, quantity: null, amount: "-0.5", share: null, day: null, at: null },
];

describe("one column model, two renderings", () => {
  it("buildCsv is tableCsv over exportTable — the CSV is what it always was", () => {
    const csv = buildCsv(COLUMNS, ROWS);
    expect(tableCsv(exportTable(COLUMNS, ROWS))).toBe(csv);
    expect(csv).toBe(
      "﻿Nummer;Benämning;Antal rader;Antal;Belopp;Andel %;Datum;Skapad\r\n" +
        `0042;"Skruv; 8x40";3;12,5;1234,57;33.3333;2026-11-12;2026-01-16 00:30\r\n` +
        "'-7;'=SUM(A1);0;;-0,50;;;\r\n"
    );
  });

  it("types the cells: text stays text, numbers are numbers, dates are Stockholm days", () => {
    const table = exportTable(COLUMNS, ROWS);
    const cells = table.columns.map((column, i) => exportCell(column, table.rows[0]![i]));
    expect(cells).toEqual([
      { type: "text", text: "0042" },
      { type: "text", text: "Skruv; 8x40" },
      { type: "number", number: 3, money: false },
      { type: "number", number: 12.5, money: false },
      { type: "number", number: 1234.57, money: true },
      { type: "number", number: 33.3333, money: false },
      { type: "date", date: "2026-11-12" },
      { type: "datetime", dateTime: "2026-01-16 00:30" },
    ]);
    // No formula guard in Excel (an inline string is never evaluated), empty stays empty.
    const second = table.columns.map((column, i) => exportCell(column, table.rows[1]![i]));
    expect(second[0]).toEqual({ type: "text", text: "-7" });
    expect(second[1]).toEqual({ type: "text", text: "=SUM(A1)" });
    expect(second[3]).toBeNull();
    expect(second[6]).toBeNull();
    // A value that does not fit its type is written as the text it is.
    expect(exportCell({ label: "Antal", format: "number" }, "blandat")).toEqual({ type: "text", text: "blandat" });
    expect(exportCell({ label: "Datum", format: "date" }, "2026-11")).toEqual({ type: "text", text: "2026-11" });
  });

  it("the workbook carries the same rows and values as the CSV, typed", async () => {
    const table = exportTable(COLUMNS, ROWS);
    const rows = await expectXlsxMatchesCsv(tableXlsx(table), tableCsv(table));
    expect(rows[1]!.slice(0, 7)).toEqual(["0042", "Skruv; 8x40", 3, 12.5, 1234.57, 33.3333, new Date(Date.UTC(2026, 10, 12))]);
    expect(rows[1]![7]).toBeInstanceOf(Date);
    expect(rows[2]!.slice(0, 5)).toEqual(["-7", "=SUM(A1)", 0, null, -0.5]);
  });

  it("gives the sheet a bold frozen header and bounded column widths", () => {
    const wide = exportTable<{ text: string }>([{ label: "Text", value: (r) => r.text }], [{ text: "x".repeat(500) }]);
    const sheet = readStoredZipEntries(tableXlsx(wide)).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet).toContain(`state="frozen"`);
    expect(sheet).toContain(`<c r="A1" s="1" t="inlineStr">`);
    expect(sheet).toContain(`<col min="1" max="1" width="60" customWidth="1"/>`);
    const narrow = readStoredZipEntries(tableXlsx(exportTable(COLUMNS, []))).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(narrow).toContain(`<col min="4" max="4" width="8" customWidth="1"/>`);
  });

  it("renderExport names the file after the format", () => {
    const table = exportTable(COLUMNS, ROWS);
    const csv = renderExport(table, "artiklar-2026-11-12", "csv");
    expect(csv).toMatchObject({ filename: "artiklar-2026-11-12.csv", contentType: "text/csv; charset=utf-8" });
    const xlsx = renderExport(table, "artiklar-2026-11-12", "xlsx");
    expect(xlsx).toMatchObject({ filename: "artiklar-2026-11-12.xlsx", contentType: XLSX_CONTENT_TYPE });
    expect(Buffer.isBuffer(xlsx.content)).toBe(true);
    expect(xlsxTwinPath("/articles/csv")).toBe("/articles/xlsx");
    expect(() => xlsxTwinPath("/articles")).toThrow();
  });
});

const testSchema = listQuerySchema.extend({ type: z.enum(["purchased", "manufactured"]).optional() });

function makeListApp(overrides: {
  rows?: Row[];
  total?: number;
  preHandler?: Parameters<typeof registerListCsvRoute>[1]["preHandler"];
  capture?: (query: unknown) => void;
}) {
  const app = Fastify();
  registerListCsvRoute<z.infer<typeof testSchema>, Row>(app, {
    path: "/articles/csv",
    preHandler: overrides.preHandler,
    querySchema: testSchema,
    filenameBase: "artiklar",
    columns: COLUMNS,
    fetch: async (query) => {
      overrides.capture?.(query);
      return { rows: overrides.rows ?? [], total: overrides.total ?? (overrides.rows ?? []).length };
    },
  });
  return app;
}

describe("registerListCsvRoute: the /xlsx twin", () => {
  it("serves the same filtered, capped set as a dated .xlsx attachment", async () => {
    const seen: unknown[] = [];
    const app = makeListApp({ rows: ROWS, capture: (q) => seen.push(q) });
    const xlsx = await app.inject({ url: "/articles/xlsx?search=stål&type=purchased&limit=25&offset=50&page=3" });
    const csv = await app.inject({ url: "/articles/csv?search=stål&type=purchased&limit=25&offset=50&page=3" });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toBe(XLSX_CONTENT_TYPE);
    expect(xlsx.headers["content-disposition"]).toMatch(/attachment; filename="artiklar-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="artiklar-\d{4}-\d{2}-\d{2}\.csv"/);
    // The same query reached the fetch for both: filters kept, pagination replaced.
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toMatchObject({ search: "stål", type: "purchased", limit: CSV_EXPORT_MAX_ROWS, offset: 0 });
    const rows = await expectXlsxMatchesCsv(xlsx.rawPayload, csv.body);
    expect(rows).toHaveLength(3);
    expect(typeof rows[1]![4]).toBe("number");
    expect(rows[1]![6]).toBeInstanceOf(Date);
  });

  it("fails loudly with 400 beyond the cap, like the CSV", async () => {
    const app = makeListApp({ rows: [], total: CSV_EXPORT_MAX_ROWS + 1 });
    const res = await app.inject({ url: "/articles/xlsx" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("10 000");
    expect((await makeListApp({ rows: [], total: CSV_EXPORT_MAX_ROWS }).inject({ url: "/articles/xlsx" })).statusCode).toBe(200);
  });

  it("runs the same preHandler and the same filter validation", async () => {
    const guarded = makeListApp({
      preHandler: async (_req, reply) => {
        reply.code(403).send({ error: "Förbjuden" });
      },
    });
    expect((await guarded.inject({ url: "/articles/xlsx" })).statusCode).toBe(403);
    expect((await makeListApp({}).inject({ url: "/articles/xlsx?type=nonsense" })).statusCode).toBe(400);
  });
});

describe("registerTableExportRoutes", () => {
  function makeReportApp() {
    const app = Fastify();
    let calls = 0;
    registerTableExportRoutes(
      app,
      "/reports/demo/csv",
      {
        preHandler: async (req, reply) => {
          if ((req.query as { deny?: string }).deny) reply.code(403).send({ error: "Förbjuden" });
        },
      },
      async (req, reply) => {
        calls++;
        if ((req.query as { missing?: string }).missing) return reply.code(404).send({ code: "not-found" });
        return { basename: "demo-2026-01-01-2026-12-31", table: exportTable(COLUMNS, ROWS) };
      }
    );
    return { app, calls: () => calls };
  }

  it("serves one table as CSV and as Excel, named alike", async () => {
    const { app } = makeReportApp();
    const csv = await app.inject({ url: "/reports/demo/csv" });
    const xlsx = await app.inject({ url: "/reports/demo/xlsx" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain(`filename="demo-2026-01-01-2026-12-31.csv"`);
    expect(csv.body).toBe(buildCsv(COLUMNS, ROWS));
    expect(xlsx.headers["content-type"]).toBe(XLSX_CONTENT_TYPE);
    expect(xlsx.headers["content-disposition"]).toContain(`filename="demo-2026-01-01-2026-12-31.xlsx"`);
    await expectXlsxMatchesCsv(xlsx.rawPayload, csv.body);
  });

  it("passes the report's own error answer and the route options to both", async () => {
    const { app, calls } = makeReportApp();
    for (const format of ["csv", "xlsx"]) {
      const missing = await app.inject({ url: `/reports/demo/${format}?missing=1` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("not-found");
      expect((await app.inject({ url: `/reports/demo/${format}?deny=1` })).statusCode).toBe(403);
    }
    expect(calls()).toBe(2); // the denied requests never reached the report
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { validateXML } from "xmllint-wasm";
import { db, suppliers } from "@navet/db";
import type { ImportEntity } from "@navet/shared";
import { parseXlsxBuffer } from "../src/modules/import/service/xlsx.js";
import { noteRows, readStoredZipEntries, writeXlsx, xmlText } from "../src/modules/import/service/xlsx-writer.js";
import {
  buildImportTemplate,
  buildImportTemplateWorkbook,
  headerComment,
} from "../src/modules/import/service/import-template.js";
import { IMPORT_FIELD_HELP } from "../src/modules/import/service/field-help.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

// The hand-written xlsx writer behind the import templates: what it writes
// must come back through the import's own reader (read-excel-file), and the
// OOXML parts must be there and well-formed — there is no XML parser in
// production, so xmllint-wasm (a devDependency) checks that here.

async function assertWellFormed(name: string, xml: string): Promise<void> {
  // xmllint-wasm's in-memory file system takes a flat file name — a part
  // name with directories ("xl/worksheets/sheet1.xml") is ENOENT there.
  const fileName = name.replace(/[^A-Za-z0-9.]/g, "_");
  const result = await validateXML({ xml: [{ fileName, contents: xml }], normalization: "format" });
  expect(result.errors.map((e) => e.message), name).toEqual([]);
}

describe("writeXlsx", () => {
  it("round-trips the Import sheet through parseXlsxBuffer: same headings, no rows, Import first", async () => {
    const buf = buildImportTemplate("articles");
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.sheetName).toBe("Import");
    expect(parsed.sheetCount).toBe(2);
    expect(parsed.headers).toEqual(IMPORT_FIELD_HELP.articles.map((h) => h.header));
    expect(parsed.rows).toEqual([]);
  });

  it("writes every OOXML part, with the comments and the VML drawing the header sheet needs", () => {
    const entries = readStoredZipEntries(buildImportTemplate("articles"));
    expect([...entries.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/comments1.xml",
      "xl/drawings/vmlDrawing1.vml",
      "xl/worksheets/sheet2.xml",
    ]);

    const contentTypes = entries.get("[Content_Types].xml")!.toString("utf8");
    expect(contentTypes).toContain('Extension="vml"');
    expect(contentTypes).toContain('PartName="/xl/comments1.xml"');

    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet1).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet1).toContain('<legacyDrawing r:id="rId2"/>');
    expect(sheet1).toContain("<cols>");
    // Heading cells are bold (cellXfs 1) inline strings.
    expect(sheet1).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Artikelnummer</t></is></c>');

    const rels = entries.get("xl/worksheets/_rels/sheet1.xml.rels")!.toString("utf8");
    expect(rels).toContain('Target="../comments1.xml"');
    expect(rels).toContain('Target="../drawings/vmlDrawing1.vml"');

    const comments = entries.get("xl/comments1.xml")!.toString("utf8");
    const vml = entries.get("xl/drawings/vmlDrawing1.vml")!.toString("utf8");
    for (const [i, help] of IMPORT_FIELD_HELP.articles.entries()) {
      expect(comments).toContain(xmlText(headerComment(help)));
      expect(vml).toContain(`<x:Row>0</x:Row><x:Column>${i}</x:Column>`);
    }
    // "Obligatorisk." leads only on required columns.
    expect(comments).toContain('<comment ref="A1" authorId="0"><text><r><rPr><sz val="9"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">Obligatorisk. ');
    expect(headerComment({ required: false, description: "Fritext." })).toBe("Fritext.");
    expect(headerComment({ required: true, description: "Fritext." })).toBe("Obligatorisk. Fritext.");
  });

  it("escapes XML in cells and comments and drops characters XML forbids", async () => {
    const buf = writeXlsx({
      sheets: [
        {
          name: "Import",
          rows: [[{ value: 'A & B <c> "d"', bold: true, comment: "Pris & moms < 100 \u0000\u0007" }]],
        },
      ],
    });
    const entries = readStoredZipEntries(buf);
    const sheet = entries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet).toContain("A &amp; B &lt;c&gt; &quot;d&quot;");
    const comments = entries.get("xl/comments1.xml")!.toString("utf8");
    expect(comments).toContain("Pris &amp; moms &lt; 100 </t>");
    expect(comments).not.toContain("\u0000");

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.headers).toEqual(['A & B <c> "d"']);
    for (const [name, data] of entries) {
      await assertWellFormed(name, data.toString("utf8"));
    }
  });

  it("every part of every template is well-formed XML", async () => {
    for (const entity of Object.keys(IMPORT_FIELD_HELP) as ImportEntity[]) {
      const entries = readStoredZipEntries(buildImportTemplate(entity));
      for (const [name, data] of entries) {
        await assertWellFormed(`${entity}/${name}`, data.toString("utf8"));
      }
    }
  });

  it("drops a lone surrogate and U+FFFE but keeps astral characters", () => {
    expect(xmlText("a\ud800b\udc00c\ufffed")).toBe("abcd");
    expect(xmlText("\ud7ff\ue000\ufffd")).toBe("\ud7ff\ue000\ufffd");
    expect(xmlText("rör 😀")).toBe("rör 😀");
    expect(xmlText("tab\tny\nrad\r")).toBe("tab\tny\nrad\r");
  });

  it("formats the text columns as Text (numFmtId 49) and keeps the bold headings", async () => {
    const entries = readStoredZipEntries(buildImportTemplate("articles"));
    const styles = entries.get("xl/styles.xml")!.toString("utf8");
    expect(styles).toContain('<cellXfs count="5">');
    expect(styles).toContain('<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');

    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    const articles = IMPORT_FIELD_HELP.articles;
    for (const [i, help] of articles.entries()) {
      const col = new RegExp(`<col min="${i + 1}" max="${i + 1}"[^>]*/>`).exec(sheet1)![0];
      if (help.text) expect(col, help.field).toContain('style="4"');
      else expect(col, help.field).not.toContain("style=");
    }
    // Artikelnummer is a text column; its heading keeps the bold style.
    expect(articles[0]!.text).toBe(true);
    expect(sheet1).toContain('<c r="A1" s="1" t="inlineStr">');
    // Standardpris is a number and stays General.
    expect(articles.find((h) => h.field === "standardCost")!.text).toBeUndefined();

    // A text column also works without a width, and the reader still reads
    // the sheet back.
    const buf = writeXlsx({
      sheets: [{ name: "Import", textColumns: [1], rows: [["Nummer", "Postnummer"], ["007", "012 34"]] }],
    });
    const plain = readStoredZipEntries(buf).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(plain).toContain('<cols><col min="2" max="2" width="9.140625" style="4"/></cols>');
    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.headers).toEqual(["Nummer", "Postnummer"]);
    expect(parsed.rows).toEqual([["007", "012 34"]]);
    for (const [name, data] of readStoredZipEntries(buf)) {
      await assertWellFormed(name, data.toString("utf8"));
    }
  });

  it("grows the comment box with the text so long explanations are not clipped", () => {
    expect(noteRows("kort")).toBe(6);
    expect(noteRows("x".repeat(45 * 5))).toBe(6);
    expect(noteRows("x".repeat(45 * 9))).toBe(10);
    const longText = "y".repeat(45 * 12);
    const vml = readStoredZipEntries(
      writeXlsx({ sheets: [{ name: "Import", rows: [[{ value: "A", comment: "kort" }, { value: "B", comment: longText }]] }] })
    )
      .get("xl/drawings/vmlDrawing1.vml")!
      .toString("utf8");
    expect(vml).toContain("<x:Anchor>1, 15, 0, 2, 4, 15, 6, 10</x:Anchor>");
    expect(vml).toContain("<x:Anchor>2, 15, 0, 2, 5, 15, 13, 10</x:Anchor>");
  });

  it("is deterministic — the same description gives the same bytes", () => {
    expect(buildImportTemplate("customers").equals(buildImportTemplate("customers"))).toBe(true);
  });

  it("a sheet without comments gets no comments part", () => {
    const entries = readStoredZipEntries(
      writeXlsx({ sheets: [{ name: "Blad", rows: [["a", "b"], ["1", null]] }] })
    );
    expect([...entries.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(entries.get("[Content_Types].xml")!.toString("utf8")).not.toContain('Extension="vml"');
    expect(entries.get("xl/worksheets/sheet1.xml")!.toString("utf8")).not.toContain("legacyDrawing");
  });

  it("the Instruktioner sheet carries the intro and one row per column", () => {
    const workbook = buildImportTemplateWorkbook("routing");
    const sheet = workbook.sheets[1]!;
    expect(sheet.name).toBe("Instruktioner");
    const first = sheet.rows[0]![0];
    expect(typeof first === "object" && first !== null ? first.value : first).toBe("Importmall: Operationer");
    const header = sheet.rows.findIndex((row) => typeof row[0] === "object" && row[0] !== null && row[0].value === "Kolumn");
    expect(header).toBeGreaterThan(0);
    const dataRows = sheet.rows.slice(header + 1);
    expect(dataRows).toHaveLength(IMPORT_FIELD_HELP.routing.length);
    const cell = (row: (typeof dataRows)[number], i: number) => {
      const c = row[i];
      return typeof c === "object" && c !== null ? c.value : c;
    };
    expect(cell(dataRows[0]!, 0)).toBe("Artikelnummer");
    expect(cell(dataRows[0]!, 1)).toBe("Ja");
    expect(cell(dataRows[5]!, 0)).toBe("Tidsenhet");
    expect(cell(dataRows[5]!, 1)).toBe("Nej");
  });
});

// --- round trip through the real import -------------------------------------

const importService = createImportService(createImportRepository(db));

const TRUNCATE = sql`
  TRUNCATE bom_components, stock_transactions, articles, article_groups,
    customer_contacts, customer_delivery_addresses, customers,
    supplier_contacts, supplier_delivery_addresses, suppliers,
    payment_terms, delivery_terms, carriers, price_lists CASCADE
`;

describe("round trip: a template with one row of the examples goes through parse → preview without errors", () => {
  beforeEach(async () => {
    await db.execute(TRUNCATE);
  });
  afterAll(async () => {
    await db.execute(TRUNCATE);
  });

  // The template's headings with the examples as the one data row — written
  // with the test fixture builder (shared strings, as Excel itself saves),
  // i.e. the file a user produces by filling the template in and saving.
  function filledTemplate(entity: ImportEntity): Buffer {
    const help = IMPORT_FIELD_HELP[entity];
    return buildXlsxBuffer([
      { name: "Import", rows: [help.map((h) => h.header), help.map((h) => h.example)] },
      { name: "Instruktioner", rows: [["Läses inte"]] },
    ]);
  }

  it.each(["articles", "customers", "suppliers"] as const)("%s", async (entity) => {
    // The article template's Leverantörsnummer must name a supplier that exists.
    const supplierExample = IMPORT_FIELD_HELP.articles.find((h) => h.field === "primarySupplierNumber")!.example;
    if (entity === "articles") await db.insert(suppliers).values({ supplierNumber: supplierExample, name: "Exempelleverantören" });
    const parsed = await importService.parse(entity, filledTemplate(entity));
    expect(parsed.headers).toEqual(IMPORT_FIELD_HELP[entity].map((h) => h.header));
    // Every column of the template is recognised.
    for (const help of IMPORT_FIELD_HELP[entity]) {
      expect(parsed.suggestedMapping[help.header], help.field).toBe(help.field);
    }

    const preview = await importService.preview(entity, { mapping: parsed.suggestedMapping, rows: parsed.rows });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.errors).toEqual([]);
    expect(preview.rows[0]!.action).toBe("create");
    expect(preview.summary.error).toBe(0);
  });

  it("the Import sheet written by the writer itself parses the same way", async () => {
    const parsed = await importService.parse("articles", buildImportTemplate("articles"));
    expect(parsed.rows).toEqual([]);
    expect(parsed.suggestedMapping).toEqual(
      Object.fromEntries(IMPORT_FIELD_HELP.articles.map((h) => [h.header, h.field]))
    );
  });
});

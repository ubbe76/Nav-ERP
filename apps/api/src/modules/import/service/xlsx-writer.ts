// Minimal, deterministic .xlsx WRITER for the import templates — the
// production twin of test/helpers/xlsx-fixture.ts, and like the SIE and bank
// files it adds no dependency: a workbook is a zip of a handful of OOXML
// parts, and the template needs only what is hand-written here.
//
// What it does: one or more sheets with text cells (inline strings — no
// shared string table), bold and wrapped cell styles, column widths, a
// frozen header row, and classic cell comments (comments<n>.xml PLUS the
// legacy VML drawing Excel insists on before it shows a comment; LibreOffice
// reads the same pair). Everything is XML-escaped and characters XML 1.0
// forbids are dropped. The zip is STORED (no deflate) with a FIXED
// timestamp, so the same workbook description always yields the same bytes
// — import-templates-generated.test.ts compares the checked-in files byte
// for byte.
import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

export interface XlsxCell {
  value: string;
  bold?: boolean;
  /** Wrap text, top-aligned — for long explanations. */
  wrap?: boolean;
  /** A classic cell comment (shown on hover in Excel/LibreOffice). */
  comment?: string;
}

export interface XlsxSheet {
  /** Tab name, at most 31 characters and none of : \ / ? * [ ] */
  name: string;
  /** Column widths in characters, by column index; missing = Excel default. */
  columnWidths?: number[];
  /** Freeze row 1 so the headings stay visible while scrolling. */
  freezeHeader?: boolean;
  /** Row heights in points, by row index; missing = default. */
  rowHeights?: number[];
  /** null = no cell written at that position. */
  rows: (XlsxCell | string | null)[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  /** The author comments are attributed to. */
  commentAuthor?: string;
}

// --- zip (STORED) ------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

// MS-DOS date/time of 2026-01-01 00:00:00 — any fixed value will do; the
// point is that two runs over the same input produce identical archives.
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zipStored(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

// --- XML helpers -------------------------------------------------------------

// XML 1.0 allows #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] |
// [#x10000-#x10FFFF]; a control character or lone surrogate in a text would
// make the part unparseable, so it is dropped rather than escaped.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu;

export function xmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A1, B1 … Z1, AA1 — every cell is addressed explicitly.
export function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// cellXfs index: bit 0 = bold, bit 1 = wrap (top-aligned). Four styles.
function styleIndex(cell: XlsxCell): number {
  return (cell.bold ? 1 : 0) + (cell.wrap ? 2 : 0);
}

function toCell(raw: XlsxCell | string | null): XlsxCell | null {
  if (raw === null) return null;
  return typeof raw === "string" ? { value: raw } : raw;
}

function sheetXml(sheet: XlsxSheet, hasComments: boolean): string {
  const views = sheet.freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;

  const widths = sheet.columnWidths ?? [];
  const cols =
    widths.length > 0
      ? `<cols>${widths
          .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const height = sheet.rowHeights?.[rowIndex];
      const heightAttr = height !== undefined ? ` ht="${height}" customHeight="1"` : "";
      const rendered = cells
        .map((raw, columnIndex) => {
          const cell = toCell(raw);
          if (cell === null) return "";
          const ref = `${columnName(columnIndex)}${r}`;
          const style = styleIndex(cell);
          const styleAttr = style === 0 ? "" : ` s="${style}"`;
          return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r}"${heightAttr}>${rendered}</row>`;
    })
    .join("");

  // legacyDrawing comes after sheetData/pageMargins in the schema's element
  // order; rId1 is the comments part, rId2 the VML drawing (sheetRels below).
  const legacy = hasComments ? `<legacyDrawing r:id="rId2"/>` : "";
  return `${XML_HEADER}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${legacy}</worksheet>`;
}

interface CommentRef {
  row: number;
  column: number;
  text: string;
}

function collectComments(sheet: XlsxSheet): CommentRef[] {
  const comments: CommentRef[] = [];
  sheet.rows.forEach((cells, row) => {
    cells.forEach((raw, column) => {
      const cell = toCell(raw);
      if (cell?.comment !== undefined && cell.comment !== "") {
        comments.push({ row, column, text: cell.comment });
      }
    });
  });
  return comments;
}

function commentsXml(comments: CommentRef[], author: string): string {
  const list = comments
    .map(
      (c) =>
        `<comment ref="${columnName(c.column)}${c.row + 1}" authorId="0"><text><r><rPr><sz val="9"/><rFont val="Tahoma"/><family val="2"/></rPr><t xml:space="preserve">${xmlText(c.text)}</t></r></text></comment>`
    )
    .join("");
  return `${XML_HEADER}<comments xmlns="${NS_MAIN}"><authors><author>${xmlText(author)}</author></authors><commentList>${list}</commentList></comments>`;
}

// The legacy drawing Excel requires to render classic comments: one hidden
// note shape per comment, anchored beside its cell. This is the shape Excel
// itself writes (ECMA-376 Part 4, VML), trimmed to what the readers use.
// Every shape id is unique within the workbook via `shapeBase`.
function vmlDrawing(comments: CommentRef[], shapeBase: number): string {
  const shapes = comments
    .map((c, i) => {
      // Anchor: left col, left offset, top row, top offset, right col, right
      // offset, bottom row, bottom offset — the note sits to the right of the
      // cell and spans a few rows.
      const anchor = `${c.column + 1}, 15, ${c.row}, 2, ${c.column + 4}, 15, ${c.row + 6}, 10`;
      return (
        `<v:shape id="_x0000_s${shapeBase + i + 1}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:216pt;height:96pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">` +
        `<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>` +
        `<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>` +
        `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${anchor}</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${c.row}</x:Row><x:Column>${c.column}</x:Column></x:ClientData>` +
        `</v:shape>`
      );
    })
    .join("");
  return (
    `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
    `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${shapeBase / 1024}"/></o:shapelayout>` +
    `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>` +
    shapes +
    `</xml>`
  );
}

const STYLES_XML =
  `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  // 0 plain, 1 bold, 2 wrap, 3 bold + wrap (see styleIndex).
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

export function writeXlsx(workbook: XlsxWorkbook): Buffer {
  const author = workbook.commentAuthor ?? "Nav";
  const entries: ZipEntry[] = [];
  const overrides: string[] = [];
  let hasAnyComments = false;
  // Shape ids must be unique across the workbook: 1024 per sheet, like Excel.
  let shapeBase = 1024;

  workbook.sheets.forEach((sheet, i) => {
    const n = i + 1;
    const comments = collectComments(sheet);
    const hasComments = comments.length > 0;
    entries.push({ name: `xl/worksheets/sheet${n}.xml`, data: Buffer.from(sheetXml(sheet, hasComments), "utf8") });
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
    if (hasComments) {
      hasAnyComments = true;
      entries.push({
        name: `xl/worksheets/_rels/sheet${n}.xml.rels`,
        data: Buffer.from(
          `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}/comments" Target="../comments${n}.xml"/><Relationship Id="rId2" Type="${REL_TYPE}/vmlDrawing" Target="../drawings/vmlDrawing${n}.vml"/></Relationships>`,
          "utf8"
        ),
      });
      entries.push({ name: `xl/comments${n}.xml`, data: Buffer.from(commentsXml(comments, author), "utf8") });
      entries.push({ name: `xl/drawings/vmlDrawing${n}.vml`, data: Buffer.from(vmlDrawing(comments, shapeBase), "utf8") });
      overrides.push(
        `<Override PartName="/xl/comments${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`
      );
      shapeBase += 1024;
    }
  });

  const vmlDefault = hasAnyComments
    ? `<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>`
    : "";
  const contentTypes =
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>${vmlDefault}` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    overrides.join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRels = `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbookXml =
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    workbook.sheets
      .map((sheet, i) => `<sheet name="${xmlText(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
    workbook.sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("") +
    `<Relationship Id="rId${workbook.sheets.length + 1}" Type="${REL_TYPE}/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return zipStored([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    ...entries,
  ]);
}

// --- reading the archive back (tests) ---------------------------------------

// Lists the STORED entries of an archive this writer produced — enough for
// the tests to assert on the parts and their XML without a zip dependency.
export function readStoredZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    if (method !== 0) throw new Error(`Entry ${name} is not stored`);
    entries.set(name, archive.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

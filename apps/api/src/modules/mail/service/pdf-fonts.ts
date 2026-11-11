import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The typeface of every PDF the API draws (granskning 2026-11-11, the
// user's choice): Liberation Sans, embedded. pdfkit's built-in Helvetica is
// a WinAnsi font — every character above 0xFF (Ł, ś, č, ř, ő, ș, Ω, ≤, ≈,
// √, U+2212 …) was encoded wrong and garbled the REST of the text call too
// ("Łódź Meble Spółka z o.o." came out as rubbish). An embedded TrueType
// font is written as glyph ids with a ToUnicode map, so any character the
// font has prints and extracts, and one it lacks (⌀ U+2300) becomes the
// font's .notdef box without touching its neighbours. Every character has
// its own glyph in 2.1.5 (no-break space, soft hyphen …), so the ToUnicode
// map gives back exactly what was printed — "1 234,50" keeps its U+00A0.
//
// Liberation Sans is metric-compatible with Helvetica/Arial (same advance
// widths; only a few kerning pairs differ), and registerDocumentFonts gives
// it Helvetica's VERTICAL metrics
// too — pdfkit places text by the font's ascender and spaces lines by
// ascender + gap − descender, and Liberation's own (905/−212/33 per 1000
// against Helvetica's 718/−207/231) would have moved every line ~0.19 em
// down and changed every heightOfString. With the patch below every y,
// row height and page break is what it was with Helvetica. It also gives
// the control characters Helvetica's zero width (CONTROL_CHARACTERS below).
//
// The files are Liberation Sans 2.1.5 (liberationfonts/liberation-fonts,
// the official GitHub release), in apps/api/assets/fonts with their
// license (SIL Open Font License 1.1) — production must not depend on a
// package's internals. ONE place registers them; every renderer calls
// registerDocumentFonts right after `new PDFDocument` and uses the names
// below, never "Helvetica".

export const FONT = "LiberationSans";
export const FONT_BOLD = "LiberationSans-Bold";
export const FONT_ITALIC = "LiberationSans-Italic";

// Helvetica's AFM metrics as pdfkit computes them (Ascender, Descender,
// lineGap = FontBBox height − (Ascender − Descender)); the bold cut has a
// taller bounding box and therefore a larger gap. pdfgranskning.test.ts compares
// these with pdfkit's own standard fonts.
const FACES = [
  { name: FONT, file: "LiberationSans-Regular.ttf", metrics: { ascender: 718, descender: -207, lineGap: 231 } },
  { name: FONT_BOLD, file: "LiberationSans-Bold.ttf", metrics: { ascender: 718, descender: -207, lineGap: 265 } },
  { name: FONT_ITALIC, file: "LiberationSans-Italic.ttf", metrics: { ascender: 718, descender: -207, lineGap: 231 } },
] as const;

// Where the files are, relative to this module: the source tree (dev, the
// tests — src/modules/mail/service/) or the esbuild bundle (dist/server.js,
// in the image /app/apps/api/dist with the fonts COPY:d to
// /app/apps/api/assets — apps/api/Dockerfile). Both resolve to
// apps/api/assets/fonts.
const FONT_DIR_CANDIDATES = ["../../../../assets/fonts/", "../assets/fonts/"];

export function documentFontDir(): string {
  for (const candidate of FONT_DIR_CANDIDATES) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(`${dir}${FACES[0].file}`)) return dir;
  }
  throw new Error(
    `Typsnitten för PDF-dokumenten saknas (${FACES[0].file}); letade i ${FONT_DIR_CANDIDATES.map((c) =>
      fileURLToPath(new URL(c, import.meta.url))
    ).join(", ")}`
  );
}

// Read once per process — every document parses its own copy (pdfkit embeds
// a per-document subset), but the bytes come from here.
let fontFiles: Map<string, Buffer> | null = null;
function loadFontFiles(): Map<string, Buffer> {
  if (!fontFiles) {
    const dir = documentFontDir();
    fontFiles = new Map(FACES.map((face) => [face.name, readFileSync(`${dir}${face.file}`)]));
  }
  return fontFiles;
}

// The part of pdfkit's EmbeddedFont the patch touches (pdfkit 0.19; not in
// @types/pdfkit). pdfgranskning.test.ts fails if a pdfkit upgrade renames them.
interface PdfkitEmbeddedFont {
  ascender: number;
  descender: number;
  lineGap: number;
  layout(text: string, features?: unknown, onlyWidth?: boolean): unknown;
}

// Control characters (C0 and DEL) have no glyph in the TrueType font, so
// they would measure and draw as its .notdef box — 1536/2048 em wide. The
// line wrapper measures a word WITH its "\n" (only drawing strips it), so a
// multi-line text broke earlier than with Helvetica, and a "\r" from a
// pasted CRLF text or a tab printed a box. Helvetica (AFM) gave them no
// width and no mark; so does this.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function registerDocumentFonts(doc: PDFKit.PDFDocument): void {
  const files = loadFontFiles();
  for (const face of FACES) {
    doc.registerFont(face.name, files.get(face.name)!);
    // pdfkit opens a registered font on first use and caches the object per
    // document, so the patched metrics hold for every later doc.font(name).
    doc.font(face.name);
    const font = (doc as unknown as { _font: PdfkitEmbeddedFont })._font;
    Object.assign(font, face.metrics);
    // layout() is the one path behind both widthOfString and encode.
    const layout = font.layout.bind(font);
    font.layout = (text, features, onlyWidth) => layout(text.replace(CONTROL_CHARACTERS, ""), features, onlyWidth);
  }
  doc.font(FONT);
}

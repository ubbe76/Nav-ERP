// Fakturaskanning — the PDF's text layer as lines with coordinates (spec
// §3.2). pdfjs-dist (Mozilla, Apache-2.0, the legacy build for Node) is
// imported lazily so the app start and every test that never touches the
// inbox do not load it.
//
// Safety: no font faces, no system fonts, no XFA, no worker or cMap/font
// fetching (nothing is loaded from the network; pdfjs 6 has dropped the
// eval-based font path and its isEvalSupported option altogether), at most MAX_PAGES pages and
// a time limit per file. Anything pdfjs throws becomes PdfUnreadableError —
// the caller keeps the scan in `new`, never a 500.

export const PDF_MAX_PAGES = 20;
export const PDF_TIMEOUT_MS = 15_000;
// Below this many characters in the whole document there is no usable text
// layer (a scanned PDF).
export const TEXT_LAYER_MIN_CHARS = 50;

// Items on the same line differ this much in y at most (PDF points).
const LINE_TOLERANCE = 3;
// A horizontal gap wider than this starts a new cell on the line.
const CELL_GAP = 12;

export interface PdfTextCell {
  text: string;
  x: number;
  width: number;
}

export interface PdfTextLine {
  // The cells joined with two spaces — what the rules search.
  text: string;
  x: number;
  // From the top of the page, in points.
  y: number;
  page: number;
  cells: PdfTextCell[];
}

export interface PdfText {
  pages: { lines: PdfTextLine[] }[];
  charCount: number;
  // The document's real page count (only PDF_MAX_PAGES are read).
  pageCount: number;
  truncated: boolean;
}

export class PdfUnreadableError extends Error {
  constructor() {
    super("The PDF could not be read");
    this.name = "PdfUnreadableError";
  }
}

export function hasTextLayer(text: PdfText): boolean {
  return text.charCount >= TEXT_LAYER_MIN_CHARS;
}

interface RawItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

// Groups the page's text items into lines (y within LINE_TOLERANCE, sorted
// on x) and each line into cells (split where the gap exceeds CELL_GAP).
// Exported for the tests.
export function buildLines(items: RawItem[], page: number): PdfTextLine[] {
  const sorted = items.filter((i) => i.text.trim() !== "").sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: RawItem[][] = [];
  for (const item of sorted) {
    const group = groups[groups.length - 1];
    if (group && Math.abs(group[0]!.y - item.y) <= LINE_TOLERANCE) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => {
    const byX = [...group].sort((a, b) => a.x - b.x);
    const cells: PdfTextCell[] = [];
    for (const item of byX) {
      const last = cells[cells.length - 1];
      const gap = last ? item.x - (last.x + last.width) : Infinity;
      if (last && gap <= CELL_GAP) {
        last.text = `${last.text}${gap > 1 ? " " : ""}${item.text}`.replace(/\s+/g, " ");
        last.width = item.x + item.width - last.x;
      } else {
        cells.push({ text: item.text.replace(/\s+/g, " ").trim(), x: item.x, width: item.width });
      }
    }
    for (const cell of cells) cell.text = cell.text.trim();
    return {
      text: cells.map((c) => c.text).join("  "),
      x: cells[0]!.x,
      y: group[0]!.y,
      page,
      cells,
    };
  });
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export async function extractPdfText(
  data: Buffer,
  opts: { maxPages?: number; timeoutMs?: number } = {}
): Promise<PdfText> {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
  const pdfjs = await loadPdfJs();
  // pdfjs takes ownership of (and may detach) the array it gets — a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfUnreadableError()), timeoutMs);
  });
  try {
    return await Promise.race([read(), timeout]);
  } catch {
    throw new PdfUnreadableError();
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }

  async function read(): Promise<PdfText> {
    const doc = await task.promise;
    const pageCount = doc.numPages;
    const pages: { lines: PdfTextLine[] }[] = [];
    let charCount = 0;
    for (let n = 1; n <= Math.min(pageCount, maxPages); n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: RawItem[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        charCount += item.str.replace(/\s/g, "").length;
        items.push({ text: item.str, x: item.transform[4] as number, y: viewport.height - (item.transform[5] as number), width: item.width });
      }
      pages.push({ lines: buildLines(items, n) });
      page.cleanup();
    }
    return { pages, charCount, pageCount, truncated: pageCount > maxPages };
  }
}

export function allLines(text: PdfText): PdfTextLine[] {
  return text.pages.flatMap((p) => p.lines);
}

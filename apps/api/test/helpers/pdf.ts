import { inflateSync } from "node:zlib";

// pdfkit encodes its standard-14 fonts (Helvetica etc.) with WinAnsiEncoding
// (Windows-1252), which is identical to Latin-1 everywhere except the
// 0x80-0x9F byte range: Latin-1 reserves those as invisible C1 control
// codes, but Windows-1252 assigns them printable punctuation — dashes,
// curly quotes, ellipsis, bullet, etc. A naive `Buffer.toString("latin1")`
// silently swallows those bytes into unprintable characters instead of the
// glyph pdfkit actually drew. This table restores the real Unicode code
// points for the bytes pdfkit's own WIN_ANSI_MAP can produce (unassigned
// Windows-1252 slots — 0x81/0x8d/0x8f/0x90/0x9d — are never emitted, so they
// are left out and fall back to their raw byte value like everything else).
const WIN_ANSI_HIGH_BYTES: Record<number, number> = {
  0x80: 0x20ac, // €
  0x82: 0x201a, // ‚
  0x83: 0x0192, // ƒ
  0x84: 0x201e, // „
  0x85: 0x2026, // …
  0x86: 0x2020, // †
  0x87: 0x2021, // ‡
  0x88: 0x02c6, // ˆ
  0x89: 0x2030, // ‰
  0x8a: 0x0160, // Š
  0x8b: 0x2039, // ‹
  0x8c: 0x0152, // Œ
  0x8e: 0x017d, // Ž
  0x91: 0x2018, // '
  0x92: 0x2019, // '
  0x93: 0x201c, // "
  0x94: 0x201d, // "
  0x95: 0x2022, // •
  0x96: 0x2013, // – (en dash)
  0x97: 0x2014, // — (em dash)
  0x98: 0x02dc, // ˜
  0x99: 0x2122, // ™
  0x9a: 0x0161, // š
  0x9b: 0x203a, // ›
  0x9c: 0x0153, // œ
  0x9e: 0x017e, // ž
  0x9f: 0x0178, // Ÿ
};

// Decodes one pdfkit show-text hex string (as found inside `<...>` in a
// content stream) using WinAnsiEncoding rather than plain Latin-1.
export function decodeWinAnsiHex(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    out += String.fromCharCode(WIN_ANSI_HIGH_BYTES[byte] ?? byte);
  }
  return out;
}

// Counts the pages of a PDF buffer by counting page objects — layout tests
// use this to prove that wrapped text actually consumes vertical space
// (a collision bug keeps everything on one page).
export function pdfPageCount(buffer: Buffer): number {
  return buffer.toString("latin1").match(/\/Type \/Page[^s]/g)?.length ?? 0;
}

// The PDF's objects by number: the dictionary text and, for a stream, its
// (inflated) data. pdfkit writes every object as `n 0 obj <<…>> [stream …
// endstream] endobj` with a direct /Length, so the stream bytes are sliced
// exactly — binary font data can never be mistaken for text. A document
// re-saved by pdf-lib (the drawings appended, several orders merged) packs
// its dictionaries into object streams (/Type /ObjStm); those are unpacked
// into the same map.
type PdfObject = { dict: string; data: Buffer | null };
function pdfObjects(buffer: Buffer): Map<number, PdfObject> {
  const text = buffer.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\s/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text))) {
    const start = match.index + match[0].length;
    const endAt = text.indexOf("endobj", start);
    const streamAt = text.indexOf("stream", start);
    if (streamAt !== -1 && streamAt < endAt) {
      const dict = text.slice(start, streamAt);
      let from = streamAt + "stream".length;
      if (text[from] === "\r") from++;
      if (text[from] === "\n") from++;
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? text.indexOf("endstream", from) - from);
      const raw = buffer.subarray(from, from + length);
      let data: Buffer = raw;
      if (dict.includes("/FlateDecode")) {
        try {
          data = inflateSync(raw);
        } catch {
          // A stream that is not really deflated — keep the raw bytes.
        }
      }
      objects.set(Number(match[1]), { dict, data });
      header.lastIndex = Math.max(from + length, header.lastIndex);
    } else {
      objects.set(Number(match[1]), { dict: text.slice(start, endAt), data: null });
    }
  }
  for (const { dict, data } of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(dict) || !data) continue;
    const count = Number(/\/N (\d+)/.exec(dict)?.[1] ?? 0);
    const first = Number(/\/First (\d+)/.exec(dict)?.[1] ?? 0);
    const body = data.toString("latin1");
    const pairs = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const from = first + pairs[2 * i + 1]!;
      const to = i + 1 < count ? first + pairs[2 * i + 3]! : body.length;
      objects.set(pairs[2 * i]!, { dict: body.slice(from, to), data: null });
    }
  }
  return objects;
}

// A ToUnicode CMap (pdfkit writes `<start> <end> [<u> <u u> …]` bfranges;
// bfchar and the `<start> <end> <u>` form are read too): code → text.
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const units = (hex: string) =>
    String.fromCharCode(...hex.replace(/\s+/g, "").match(/.{4}/g)!.map((unit) => parseInt(unit, 16)));
  for (const [, body] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, from, to, rest] of body!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const first = parseInt(from!, 16);
      const last = parseInt(to!, 16);
      if (rest!.startsWith("[")) {
        [...rest!.matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach(([, hex], i) => map.set(first + i, units(hex!)));
      } else {
        const base = parseInt(rest!.slice(1, -1).replace(/\s+/g, ""), 16);
        for (let code = first; code <= last; code++) map.set(code, String.fromCharCode(base + code - first));
      }
    }
  }
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, code, hex] of body!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(code!, 16), units(hex!));
  }
  return map;
}

// The document's pages in page-tree order, each with its content streams and
// a decoder for one show-text hex string under one of ITS font resource
// names (a merged document reuses /F2 on every page for different fonts).
// The documents embed Liberation Sans (pdf-fonts.ts): Identity-H, two bytes
// per glyph, read back through the font's ToUnicode map — the glyph a font
// lacks (its .notdef, code 0) comes back as U+FFFD. A standard-14 font (the
// fakturaskanning test invoices, invoice-pdf.ts) has no ToUnicode and is
// read as WinAnsi, one byte per character.
type PdfPage = { streams: string[]; decode: (font: string | null, hex: string) => string };
function pdfPages(buffer: Buffer): PdfPage[] {
  const objects = pdfObjects(buffer);
  const ref = (dict: string, key: string) => {
    const found = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(dict);
    return found ? objects.get(Number(found[1])) : undefined;
  };
  const cmaps = new Map<number, Map<number, string> | null>();
  const cmapOf = (num: number) => {
    if (!cmaps.has(num)) {
      const font = objects.get(num);
      const data = font ? ref(font.dict, "ToUnicode")?.data : undefined;
      cmaps.set(num, data ? parseToUnicode(data.toString("latin1")) : null);
    }
    return cmaps.get(num)!;
  };
  // Page order: the catalog's page tree; file order when there is none.
  const ordered: number[] = [];
  const walk = (num: number) => {
    const node = objects.get(num);
    if (!node) return;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      for (const [, kid] of (/\/Kids\s*\[([^\]]*)\]/.exec(node.dict)?.[1] ?? "").matchAll(/(\d+) 0 R/g)) walk(Number(kid));
    } else ordered.push(num);
  };
  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog\b/.test(object.dict));
  const root = catalog ? /\/Pages\s+(\d+) 0 R/.exec(catalog.dict) : null;
  if (root) walk(Number(root[1]));
  else for (const [num, object] of objects) if (/\/Type\s*\/Page\b(?!s)/.test(object.dict)) ordered.push(num);

  return ordered.map((num) => {
    const page = objects.get(num)!.dict;
    const resources = ref(page, "Resources")?.dict ?? page;
    const fontDict = ref(resources, "Font")?.dict ?? /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? "";
    const fonts = new Map<string, Map<number, string> | null>();
    for (const [, name, fontNum] of fontDict.matchAll(/\/([^\s/<>]+)\s+(\d+) 0 R/g)) fonts.set(name!, cmapOf(Number(fontNum)));
    const contents = /\/Contents\s*\[([^\]]*)\]/.exec(page)?.[1] ?? /\/Contents\s+(\d+ 0 R)/.exec(page)?.[1] ?? "";
    const streams = [...contents.matchAll(/(\d+) 0 R/g)]
      .map(([, ref]) => objects.get(Number(ref))?.data)
      .filter((data): data is Buffer => Boolean(data))
      .map((data) => data.toString("latin1"));
    const decode = (font: string | null, hex: string) => {
      const cmap = font === null ? null : (fonts.get(font) ?? null);
      if (!cmap) return decodeWinAnsiHex(hex);
      let out = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const text = cmap.get(parseInt(hex.slice(i, i + 4), 16));
        out += text === undefined || text === "\u0000" ? "\ufffd" : text;
      }
      return out;
    };
    return { streams, decode };
  });
}

// Show-text operations of one content stream in order, each with the font
// it was set in (`/F2 9 Tf`) and the baseline of its text matrix.
function textOperations(stream: string): { font: string | null; y: number | null; hex: string[] }[] {
  const ops: { font: string | null; y: number | null; hex: string[] }[] = [];
  let font: string | null = null;
  let y: number | null = null;
  const token = /\/([^\s/\[\]<>()]+)\s+[-\d.]+\s+Tf|[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+) Tm|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
  for (const [, fontName, tmY, array, single] of stream.matchAll(token)) {
    if (fontName !== undefined) font = fontName;
    else if (tmY !== undefined) y = Number(tmY);
    else if (array !== undefined) ops.push({ font, y, hex: [...array.matchAll(/<([0-9a-fA-F]*)>/g)].map(([, hex]) => hex!) });
    else ops.push({ font, y, hex: [single!] });
  }
  return ops;
}

// Extracts the rendered text from a PDF buffer, page after page, so tests
// can assert on printed strings. Lines are concatenated without separators.
// Every character comes back as printed — a sv-SE number keeps its
// no-break thousands separator, so compare with formatNumber's output.
export function pdfText(buffer: Buffer): string {
  return pdfPagesText(buffer).join("");
}

// pdfText per page, in page order (a renderer that revisits a page with
// switchToPage still writes into that page's own content).
export function pdfPagesText(buffer: Buffer): string[] {
  return pdfPages(buffer).map(({ streams, decode }) =>
    streams
      .flatMap((stream) => textOperations(stream))
      .map((op) => op.hex.map((hex) => decode(op.font, hex)).join(""))
      .join("")
  );
}

// Like pdfText, but per show-text operation with its baseline: pdfkit writes
// every text run as `x y Tm … [<hex> …] TJ`, y in PDF points from the BOTTOM
// of the page. Layout tests use it to prove one line ends above the next
// (an overlap keeps both on the same baseline band).
export function pdfTextRuns(buffer: Buffer): { text: string; y: number }[] {
  return pdfPages(buffer).flatMap(({ streams, decode }) =>
    streams.flatMap((stream) =>
      textOperations(stream).map((op) => ({ text: op.hex.map((hex) => decode(op.font, hex)).join(""), y: op.y ?? 0 }))
    )
  );
}

// Rectangles in the PDF's content streams: a barcode adds its bars and a QR
// code its modules on top of the frames and bands the layout draws. A layout
// test, not image analysis: the counts tell the code types apart without
// decoding anything (the pallet card, the purchase order's header).
export function pdfRectCount(buffer: Buffer): number {
  return pdfRects(buffer).length;
}

// The rectangles themselves (x, y, width, height in points, y from the TOP
// of the page — pdfkit flips the page with `1 0 0 -1 0 height cm`): a layout
// test can prove a frame ends above the fold without rasterizing.
export function pdfRects(buffer: Buffer): { x: number; y: number; width: number; height: number }[] {
  // Page content only — an embedded font's binary data is a stream too.
  return pdfPages(buffer).flatMap(({ streams }) => streams).flatMap((stream) =>
    [...stream.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re\n/g)].map(([, x, y, width, height]) => ({
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    }))
  );
}

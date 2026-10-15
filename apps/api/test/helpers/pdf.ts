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

// Extracts the rendered text from a PDF buffer: inflates the content
// streams and decodes pdfkit's hex-encoded WinAnsi show-text strings, so
// tests can assert on printed strings.
export function pdfText(buffer: Buffer): string {
  const marker = Buffer.from("stream\n");
  const end = Buffer.from("endstream");
  let streams = "";
  let offset = 0;
  while (true) {
    const start = buffer.indexOf(marker, offset);
    if (start === -1) break;
    const from = start + marker.length;
    const to = buffer.indexOf(end, from);
    if (to === -1) break;
    try {
      streams += inflateSync(buffer.subarray(from, to)).toString("latin1");
    } catch {
      // Not a deflate stream (e.g. embedded image) — skip.
    }
    offset = to + end.length;
  }
  let out = "";
  for (const [, hex] of streams.matchAll(/<([0-9a-fA-F]+)>/g)) {
    out += decodeWinAnsiHex(hex!);
  }
  return out;
}

// Like pdfText, but per show-text operation with its baseline: pdfkit writes
// every text run as `x y Tm … [<hex> …] TJ`, y in PDF points from the BOTTOM
// of the page. Layout tests use it to prove one line ends above the next
// (an overlap keeps both on the same baseline band).
export function pdfTextRuns(buffer: Buffer): { text: string; y: number }[] {
  const marker = Buffer.from("stream\n");
  const end = Buffer.from("endstream");
  const runs: { text: string; y: number }[] = [];
  let offset = 0;
  while (true) {
    const start = buffer.indexOf(marker, offset);
    if (start === -1) break;
    const from = start + marker.length;
    const to = buffer.indexOf(end, from);
    if (to === -1) break;
    let stream = "";
    try {
      stream = inflateSync(buffer.subarray(from, to)).toString("latin1");
    } catch {
      // Not a deflate stream (e.g. embedded image) — skip.
    }
    for (const [, y, body] of stream.matchAll(/[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+) Tm[\s\S]*?\[([^\]]*)\] TJ/g)) {
      let text = "";
      for (const [, hex] of body!.matchAll(/<([0-9a-fA-F]+)>/g)) text += decodeWinAnsiHex(hex!);
      runs.push({ text, y: Number(y) });
    }
    offset = to + end.length;
  }
  return runs;
}

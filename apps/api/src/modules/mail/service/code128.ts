// Code 128 (ISO/IEC 15417), code set B — the barcode printed on the pallet
// card for the article number and the order number. Hand-written on purpose
// (same no-dependency line as the CP437 codec and the XML builder): the
// symbology is a table of 107 patterns, a weighted checksum and a stop
// pattern, small enough to own. Pure: no I/O, no pdfkit — the renderer draws
// the returned module widths with doc.rect().fill().
//
// Only code set B is used (ASCII 32–126), which covers every article and
// order number this system prints; the automatic switch to set C for long
// digit runs would make the symbol narrower but is not needed for the card.

// Symbols 0–106: each pattern is six module widths, alternating bar/space
// starting with a bar (the stop pattern, 106, has seven and ends with a
// bar). Every symbol is 11 modules wide, the stop pattern 13.
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_START_B = 104;
export const CODE128_STOP = 106;
// Quiet zone the renderer must leave on each side, in modules.
export const CODE128_QUIET_ZONE = 10;

// The symbol values (code set B) for `text`, with the start code first and
// the checksum appended — exposed for tests that pin known checksums
// ("Wikipedia" → 88, "PJJ123C" → 55). null when the text is empty or holds a
// character outside ASCII 32–126 (å/ä/ö, control characters): set B cannot
// carry it, and the card then prints the text without a barcode.
export function code128Symbols(text: string): number[] | null {
  if (text.length === 0) return null;
  const values: number[] = [CODE128_START_B];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code > 126) return null;
    values.push(code - 32);
  }
  // Checksum: the start code weighted 1 plus every data symbol weighted by
  // its position (1-based), modulo 103.
  let sum = values[0]!;
  for (let i = 1; i < values.length; i++) sum += values[i]! * i;
  values.push(sum % 103);
  values.push(CODE128_STOP);
  return values;
}

// Module widths of the whole symbol — bar, space, bar, space, … — starting
// AND ending with a bar (the stop pattern's trailing bar), without quiet
// zones. null for text set B cannot encode (see code128Symbols).
export function encodeCode128(text: string): number[] | null {
  const symbols = code128Symbols(text);
  if (!symbols) return null;
  const widths: number[] = [];
  for (const symbol of symbols) {
    for (const digit of PATTERNS[symbol]!) widths.push(Number(digit));
  }
  return widths;
}

// Total width in modules including both quiet zones — what the renderer
// scales to the space it has.
export function code128TotalModules(widths: readonly number[]): number {
  return widths.reduce((sum, w) => sum + w, 0) + CODE128_QUIET_ZONE * 2;
}

// The pattern table itself, for the test that checks every symbol is 11
// modules wide (13 for stop) and that no two symbols share a pattern.
export const CODE128_PATTERNS = PATTERNS;

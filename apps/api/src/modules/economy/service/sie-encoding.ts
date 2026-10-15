// CP437 (IBM PC 8-bit extended ASCII) codec for SIE files.
//
// The SIE 4 specification (§5.8) mandates this encoding and #FORMAT PC8 is
// the only legal value of that field, so a UTF-8 file is not a SIE file even
// if a lenient importer happens to accept it. Node's TextDecoder has no
// "cp437" label — ICU does not ship it — so the table lives here.
//
// Hand-rolled on purpose, matching the CSV parser's "deliberately no
// dependency" stance: this is 128 entries and fully testable, and pulling in
// a charset library for one legacy code page is not worth the supply chain.

// Unicode code point for each byte 0x80–0xFF. Bytes 0x00–0x7F are ASCII and
// map to themselves.
const HIGH_CHARS =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const BYTE_BY_CHAR = new Map<string, number>();
for (let i = 0; i < HIGH_CHARS.length; i++) {
  BYTE_BY_CHAR.set(HIGH_CHARS[i]!, 0x80 + i);
}

// Characters CP437 has no glyph for but which turn up in pasted company
// names and addresses. Transliterating beats emitting "?" — an en dash in a
// company name should not become a question mark in the accountant's file.
const TRANSLITERATIONS: Record<string, string> = {
  "–": "-",
  "—": "-",
  "‑": "-",
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "­": "-",
  "š": "s",
  "Š": "S",
  "ž": "z",
  "Ž": "Z",
  "œ": "oe",
  "Œ": "OE",
  "€": "EUR",
};

export function encodeCp437(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const mapped = BYTE_BY_CHAR.get(char);
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    const transliterated = TRANSLITERATIONS[char];
    if (transliterated !== undefined) {
      for (const ascii of transliterated) bytes.push(ascii.charCodeAt(0));
      continue;
    }
    bytes.push(0x3f); // "?"
  }
  return Buffer.from(bytes);
}

export function decodeCp437(buffer: Buffer): string {
  let text = "";
  for (const byte of buffer) {
    text += byte < 0x80 ? String.fromCharCode(byte) : HIGH_CHARS[byte - 0x80]!;
  }
  return text;
}

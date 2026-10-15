// RFC 6266 Content-Disposition, filename-safe for non-ASCII (å/ä/ö,
// accented letters, etc.) file names. HTTP header field values are Latin-1
// only — a bare `filename="Fönster.pdf"` mangles or truncates the moment a
// browser/proxy doesn't happen to guess UTF-8 for the quoted-string, and some
// stacks reject the header outright. RFC 5987/6266's `filename*=UTF-8''…`
// extended parameter is the correct fix and is honoured by every modern
// browser; the plain `filename="…"` stays alongside it as an ASCII fallback
// for anything that only understands the old form.
//
// Lives in system/service: this module is the repo's established home for
// cross-module leaf helpers with no dependency on any repository or service
// (see db-errors.ts's isUniqueViolation, number-series.ts's
// getNextOrderNumber, ocr.ts's computeOcrNumber) — there is no src/lib, so
// leaves every route module needs live here instead.

// Swedish/common accented letters this codebase's file names actually
// produce (article names, customer/supplier names, document titles) — not an
// exhaustive transliteration table, just enough that the ASCII fallback
// reads sensibly rather than dropping the letter entirely.
const TRANSLITERATIONS: Record<string, string> = {
  å: "a",
  ä: "a",
  ö: "o",
  Å: "A",
  Ä: "A",
  Ö: "O",
  é: "e",
  É: "E",
  ü: "u",
  Ü: "U",
};

// The ASCII `filename="…"` fallback: transliterate the handful of letters
// above, then strip anything still outside printable ASCII plus the two
// characters the quoted-string syntax itself owns — the double quote AND the
// backslash (RFC 6266 §4.3 / RFC 2616 quoted-pair: a backslash escapes the
// next character, so a name ending in one would swallow the closing quote and
// with it the filename* parameter that follows). File names reach this from
// user-uploaded article drawings, so both are genuinely reachable.
function asciiFallback(filename: string): string {
  let out = "";
  for (const ch of filename) {
    out += TRANSLITERATIONS[ch] ?? ch;
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/["\\\x00-\x1f\x7f-\uffff]/g, "");
}

// RFC 5987 `attr-char` percent-encoding for the `filename*` extended value:
// encodeURIComponent already escapes everything outside
// `A-Za-z0-9-_.!~*'()`, but RFC 5987 reserves `* ' ( )` too (they are
// `sub-delims` encodeURIComponent leaves bare), so those four are
// percent-encoded on top.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Builds a full Content-Disposition header value: an ASCII quoted-string
// fallback plus the RFC 5987/6266 UTF-8 extended parameter, so a filename
// with å/ä/ö (or any other non-ASCII character) prints correctly in a
// browser that understands filename*, and degrades to a transliterated,
// still-readable name in one that only understands the plain form.
export function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  return `${disposition}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

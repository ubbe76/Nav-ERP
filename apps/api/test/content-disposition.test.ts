import { describe, expect, it } from "vitest";
import { contentDisposition } from "../src/modules/system/service/content-disposition.js";

// Pure, DB-free — see content-disposition.ts's own comment for why this leaf
// exists (RFC 5987/6266 filename*= for non-ASCII file names).
describe("contentDisposition", () => {
  it("defaults to attachment for a plain ASCII filename, with matching fallback and extended value", () => {
    expect(contentDisposition("Faktura-FA-1.pdf")).toBe(
      `attachment; filename="Faktura-FA-1.pdf"; filename*=UTF-8''Faktura-FA-1.pdf`
    );
  });

  it("honours the inline disposition parameter", () => {
    expect(contentDisposition("ritning.pdf", "inline")).toBe(
      `inline; filename="ritning.pdf"; filename*=UTF-8''ritning.pdf`
    );
  });

  it("transliterates å/ä/ö (upper and lower case) in the ASCII fallback, but RFC-5987-encodes them verbatim in filename*", () => {
    const header = contentDisposition("Fönster Åäö ÅÄÖ.pdf");
    expect(header).toContain('filename="Fonster Aao AAO.pdf"');
    expect(header).toContain("filename*=UTF-8''F%C3%B6nster%20%C3%85%C3%A4%C3%B6%20%C3%85%C3%84%C3%96.pdf");
  });

  it("strips a character with no transliteration entry from the ASCII fallback instead of dropping the whole name", () => {
    const header = contentDisposition("日本語.pdf");
    expect(header).toContain('filename=".pdf"');
    expect(header).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf");
  });

  it("strips double quotes from the ASCII fallback (they would break out of the quoted-string)", () => {
    const header = contentDisposition('Räkning "kopia".pdf');
    expect(header).toContain('filename="Rakning kopia.pdf"');
    // The extended value carries the real quote characters, percent-encoded.
    expect(header).toContain("%22kopia%22");
  });

  it("strips backslashes from the ASCII fallback (a trailing one would escape the closing quote)", () => {
    // Article drawings are uploaded with user-chosen names, and a backslash is
    // a legal filename character on Linux. Left in place, a name ending in one would
    // render as filename="ritning\" — a quoted-pair escaping the closing
    // quote, so a conforming parser reads on and swallows filename*.
    const header = contentDisposition("ritning\\.pdf");
    expect(header).toContain('filename="ritning.pdf"');
    const trailing = contentDisposition("ritning\\");
    expect(trailing).toContain('filename="ritning"');
    expect(trailing).toContain("filename*=UTF-8''ritning%5C");
  });

  it("percent-encodes RFC 5987's extra reserved characters (* ' ( )) that encodeURIComponent leaves bare", () => {
    const header = contentDisposition("Order (kopia)*'.pdf");
    expect(header).toContain("filename*=UTF-8''Order%20%28kopia%29%2A%27.pdf");
    // encodeURIComponent alone would have left ( ) * ' unescaped — assert the
    // raw characters are gone from the extended value. Split on UTF-8'' and
    // not on filename*=, or the charset prefix's own two apostrophes match.
    expect(header.split("UTF-8''")[1]).not.toMatch(/[*'()]/);
  });

  it("round-trips through decodeURIComponent back to the original non-ASCII filename", () => {
    const original = "Beställning Örnsköldsvik åäö.pdf";
    const header = contentDisposition(original);
    const encoded = header.split("UTF-8''")[1]!;
    expect(decodeURIComponent(encoded)).toBe(original);
  });
});

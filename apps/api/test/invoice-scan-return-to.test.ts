import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../web/lib/invoiceScan";

// Skapa leverantör from the Fakturainkorg comes back via ?returnTo= — only a
// path inside the app may be followed. Browsers strip tab and newline out of
// a URL and read "\" as "/", so "/\t/evil.example" is "//evil.example".
describe("safeReturnTo", () => {
  it("follows a path inside the app", () => {
    expect(safeReturnTo("/inkop/fakturainkorg/0b6c8f1e-1111-4222-8333-444455556666")).toBe(
      "/inkop/fakturainkorg/0b6c8f1e-1111-4222-8333-444455556666"
    );
    expect(safeReturnTo("/inkop/fakturainkorg?status=pending#x")).toBe("/inkop/fakturainkorg?status=pending#x");
  });

  it("drops everything that could leave the app", () => {
    for (const value of [
      null,
      undefined,
      "",
      "inkop",
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "\\/evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\u0000/evil.example",
      "/\u007f",
      "/%09/ok-encoded-is-a-path",
    ]) {
      const result = safeReturnTo(value);
      if (value === "/%09/ok-encoded-is-a-path") {
        // Percent-encoded stays a path on this origin.
        expect(result).toBe("/%09/ok-encoded-is-a-path");
      } else {
        expect(result, JSON.stringify(value)).toBeNull();
      }
    }
  });
});

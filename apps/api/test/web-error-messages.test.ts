import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An API error shown to the user goes through apiErrorMessage
// (apps/web/lib/errorMessages.ts): it turns the error's code into the Swedish
// text and falls back to the message itself. `err instanceof Error ?
// err.message : …` skipped the dictionary, so the API's English text reached
// the screen — the web checks of the 2026-11-11 reviews found it on Ny
// anställd and on the article card's Allmänt (a taken barcode), and the
// pattern was on 137 places.
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const ALLOWED = new Set(["lib/errorMessages.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
  });
}

describe("web error messages", () => {
  it("never shows a caught error's raw message outside lib/errorMessages.ts", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => walk(join(WEB, d)))
      .map((path) => relative(WEB, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\b(\w+) instanceof Error \? \1\.message\b/.test(readFileSync(join(WEB, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  // The other shape the first test missed (webbgranskningen 2026-11-11:
  // Behovsberäkning, Beläggning and six report pages): a load's
  // `.catch((err: Error) => setLoadError(err.message))` — a 400 or 403
  // showed the API's English text.
  it("never puts a caught error's raw message straight into state", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => walk(join(WEB, d)))
      .map((path) => relative(WEB, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\bset\w*\(\s*(?:err|error|e)\.message\s*\)/.test(readFileSync(join(WEB, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});

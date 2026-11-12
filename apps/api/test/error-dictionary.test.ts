import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeFromName } from "../src/modules/system/service/error-body.js";

// Guards the Swedish error dictionary in apps/web/lib/errorMessages.ts: every
// error class in the API must have an entry (otherwise the web shows the API's
// message, which is English for many classes), and every entry must name a
// code the API can really send (catches typos). The web can't import the
// API, so both sides are read as text.

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const dictionaryFile = join(here, "..", "..", "web", "lib", "errorMessages.ts");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

const sources = tsFiles(srcDir).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// code -> where the class lives. `this.name = "X"` in the constructor wins
// over the class name, exactly as errorBody() reads err.name.
const derived = new Map<string, string>();
for (const { path, text } of sources) {
  for (const m of text.matchAll(/class (\w+Error) extends [\w.]+/g)) {
    const start = m.index! + m[0].length;
    const next = text.indexOf("\nclass ", start);
    const nextExported = text.indexOf("\nexport class ", start);
    const ends = [next, nextExported].filter((i) => i !== -1);
    const body = text.slice(start, ends.length > 0 ? Math.min(...ends) : text.length);
    const name = /this\.name\s*=\s*"(\w+)"/.exec(body)?.[1] ?? m[1]!;
    const code = codeFromName(name);
    if (code && !derived.has(code)) derived.set(code, `${path.slice(srcDir.length + 1)}: ${name}`);
  }
}

// Codes the API sends as literals (`code: "validation-failed"` in app.ts and
// route handlers) rather than through an error class.
const literal = new Set<string>();
for (const { text } of sources) {
  for (const m of text.matchAll(/\bcode:\s*"([a-z0-9]+(?:-[a-z0-9]+)*)"/g)) literal.add(m[1]!);
}

// Dictionary keys that are legitimate without either source above. Keep
// empty unless a code really comes from elsewhere (e.g. a framework error
// handler) — say where here.
const ALLOWED_EXTRA_KEYS = new Set<string>([]);

// Only the MESSAGES object: the file has other lookup tables with keys of
// their own. Keys may be quoted or bare (`forbidden:`).
const dictionarySource = readFileSync(dictionaryFile, "utf8");
const messagesStart = dictionarySource.indexOf("const MESSAGES");
const messagesBlock = dictionarySource.slice(messagesStart, dictionarySource.indexOf("\n};", messagesStart));
const dictionaryKeys = new Set(
  [...messagesBlock.matchAll(/^ {2}"?([a-z0-9-]+)"?:/gm)].map((m) => m[1]!)
);

describe("error dictionary (apps/web/lib/errorMessages.ts)", () => {
  it("finds the error classes and the dictionary", () => {
    expect(derived.size).toBeGreaterThan(300);
    expect(dictionaryKeys.size).toBeGreaterThan(300);
  });

  it("has an entry for every error class in the API", () => {
    const missing = [...derived].filter(([code]) => !dictionaryKeys.has(code)).map(([code, where]) => `${code} (${where})`);
    expect(missing, "add these codes to MESSAGES in apps/web/lib/errorMessages.ts").toEqual([]);
  });

  it("has no entry for a code the API never sends", () => {
    const unknown = [...dictionaryKeys].filter(
      (key) => !derived.has(key) && !literal.has(key) && !ALLOWED_EXTRA_KEYS.has(key)
    );
    expect(unknown, "typo or dead key in MESSAGES").toEqual([]);
  });
});

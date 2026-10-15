import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// window.confirm can stop showing in Safari on iPhone and then answers
// "cancel" silently, so every confirmation in the web goes through the in-app
// dialog (apps/web/lib/confirm.ts). Only that module's own fallback may call
// the native one.
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const ALLOWED = new Set(["lib/confirm.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
  });
}

describe("web confirmations", () => {
  it("never calls the native confirm outside lib/confirm.ts", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => walk(join(WEB, d)))
      .map((path) => relative(WEB, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\b(window\.)?confirm\(/.test(readFileSync(join(WEB, rel), "utf8").replace(/confirm(Dialog|Delete|Leave)\(/g, "")));
    expect(offenders).toEqual([]);
  });
});

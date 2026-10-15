import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every row on the module hub pages shows an icon from apps/web/lib/hubIcons.tsx,
// keyed on the row's href. A new row in moduleNav.ts without an icon would render
// as an iconless row among iconed ones; an icon for a removed row is dead weight.
//
// Read as text rather than imported, like module-nav-routes.test.ts: the web app
// is a separate build, and hubIcons.tsx imports lucide-react. Only the href
// strings matter, so both files are parsed with a simple regex.
const NAV_FILE = new URL("../../web/lib/moduleNav.ts", import.meta.url);
const ICON_FILE = new URL("../../web/lib/hubIcons.tsx", import.meta.url);

function navHrefs(): string[] {
  const source = readFileSync(NAV_FILE, "utf8");
  return [...new Set([...source.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]!))];
}

function iconKeys(): string[] {
  const source = readFileSync(ICON_FILE, "utf8");
  return [...source.matchAll(/^\s*"(\/[^"]*)":\s*\w+,/gm)].map((m) => m[1]!);
}

describe("hub icons", () => {
  it("finds hrefs and icon keys to check at all (both parsers still match reality)", () => {
    expect(navHrefs().length).toBeGreaterThan(40);
    expect(iconKeys().length).toBeGreaterThan(40);
  });

  it("has an icon for every row in moduleNav.ts", () => {
    const keys = new Set(iconKeys());
    expect(navHrefs().filter((href) => !keys.has(href))).toEqual([]);
  });

  it("has no icon for an address that is not a row", () => {
    const hrefs = new Set(navHrefs());
    expect(iconKeys().filter((key) => !hrefs.has(key))).toEqual([]);
  });

  it("lists each address once", () => {
    const keys = iconKeys();
    expect(keys.length).toBe(new Set(keys).size);
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the web's navigation against dead links AND orphaned pages
// (TODO2 #14).
//
// The sidebar has no submenus any more: apps/web/lib/moduleNav.ts is the ONLY
// place the module structure is written down, and each module page renders its
// section of it as the grid users navigate from. Nothing type-checks a route
// string against the App Router's directories, so both directions can rot:
// an href with a typo goes nowhere, and a new page that nobody added to
// moduleNav.ts has no entry point at all. The second is what actually
// happened before this file existed — Behovsberäkning and Beläggning shipped
// and sat unreachable from the old hub for weeks.
//
// Read as text rather than imported, for the same reason error-codes.test.ts
// reads apps/web/lib/errorMessages.ts: the web app is a separate build with
// its own module resolution, and only the href strings matter here.
const NAV_FILE = new URL("../../web/lib/moduleNav.ts", import.meta.url);
const APP_DIR = new URL("../../web/app/", import.meta.url);

// Pages that legitimately have no card of their own. Each is reached some
// other way, and the reason is what keeps this list from becoming a dumping
// ground for genuinely orphaned pages.
const NOT_IN_NAV = new Set([
  // Where the proxy sends a refused page — never linked.
  "/ingen-behorighet",
  // Reached from + Nytt verifikat on the verification list.
  "/ekonomi/verifikat/nytt",
  // The sidebar's own entries — module roots ARE the grids.
  "/",
  "/aviseringar",
  "/artiklar",
  "/inkop",
  "/forsaljning",
  "/tillverkning",
  "/lager",
  "/personal",
  "/ekonomi",
  "/rapporter",
  "/system",
  "/hjalp",
  // Outside the shell entirely.
  "/login",
  "/register",
  // Reached from within a routine, not from the module menu.
  "/kunder/import", // "Importera" on the customer list
  "/leverantorer/import", // ditto, supplier list
  "/lager/inventering/ny", // "+ Ny inventering" on the count list
  "/system/teman/ny", // "Nytt tema" on the themes list
  "/tillverkning/resurser/import", // "Importera" on the resource, lego resource and production group lists
  // Legacy redirect stub, deliberately unlisted.
  "/lager/inventera",
]);

function navHrefs(): string[] {
  const source = readFileSync(NAV_FILE, "utf8");
  return [...new Set([...source.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]!))];
}

// Every routable path under app/, minus dynamic segments (a card can't link
// to /artiklar/[id] — those are reached from a list).
function appRoutes(): string[] {
  const root = fileURLToPath(APP_DIR);
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("[") || entry.name.startsWith("_") || entry.name.startsWith("(")) continue;
      const path = `${prefix}/${entry.name}`;
      if (existsSync(`${dir}/${entry.name}/page.tsx`)) out.push(path);
      walk(`${dir}/${entry.name}`, path);
    }
  };
  if (existsSync(`${root}/page.tsx`)) out.push("/");
  walk(root.replace(/\/$/, ""), "");
  return out.sort();
}

describe("moduleNav is in sync with the App Router", () => {
  it("finds hrefs and routes to check at all (both parsers still match reality)", () => {
    // Without this, a rename that broke either parse would turn the
    // assertions below into vacuous passes over empty lists.
    expect(navHrefs().length).toBeGreaterThan(40);
    expect(appRoutes().length).toBeGreaterThan(40);
  });

  it("has a page.tsx under apps/web/app for every href", () => {
    const missing = navHrefs().filter((href) => !existsSync(new URL(`.${href}/page.tsx`, APP_DIR)));
    expect(missing).toEqual([]);
  });

  it("has a nav entry for every page (or an explicit reason it needs none)", () => {
    const linked = new Set(navHrefs());
    const orphans = appRoutes().filter((route) => !linked.has(route) && !NOT_IN_NAV.has(route));
    expect(orphans).toEqual([]);
  });

  it("uses absolute in-app paths only — no relative or external links", () => {
    const bad = navHrefs().filter((href) => !href.startsWith("/") || href.startsWith("//"));
    expect(bad).toEqual([]);
  });
});

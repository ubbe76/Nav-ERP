import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// pageAccess.ts only imports ./permissions (no imports of its own), so
// vitest can load it directly.
import { canOpen, landingFor, pageAccessFor } from "../../web/lib/pageAccess.js";

const APP_DIR = new URL("../../web/app/", import.meta.url);

// Every page, dynamic segments replaced by a sample id — unlike
// module-nav-routes.test.ts we DO need /artiklar/[id] etc. to resolve.
function appPages(): string[] {
  const root = fileURLToPath(APP_DIR).replace(/\/$/, "");
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith("(")) continue;
      const seg = entry.name.startsWith("[") ? "x1" : entry.name;
      const path = `${prefix}/${seg}`;
      if (existsSync(`${dir}/${entry.name}/page.tsx`)) out.push(path);
      walk(`${dir}/${entry.name}`, path);
    }
  };
  out.push("/");
  walk(root, "");
  return out;
}

const PUBLIC_PAGES = new Set(["/login", "/register"]); // handled before pageAccess in proxy.ts

const workshop = { role: "user" as const, permissions: ["terminal", "artikeloversikt", "tillverkningsorder_las"] as const };
const sales = { role: "user" as const, permissions: ["forsaljning"] as const };
const nobody = { role: "user" as const, permissions: [] as const };
const admin = { role: "admin" as const, permissions: [] as const };

describe("page access table", () => {
  it("has a rule for every page", () => {
    const missing = appPages().filter((p) => !PUBLIC_PAGES.has(p) && pageAccessFor(p) === null);
    expect(missing).toEqual([]);
  });

  it("gives the workshop profile exactly its pages", () => {
    const open = appPages().filter((p) => !PUBLIC_PAGES.has(p) && canOpen(workshop, p)).sort();
    expect(open).toEqual(
      [
        "/artiklar",
        "/artiklar/oversikt",
        "/hjalp",
        "/hjalp/x1",
        "/ingen-behorighet",
        "/tillverkning",
        "/tillverkning/ordrar",
        "/tillverkning/ordrar/x1",
        "/tillverkning/terminal",
      ].sort()
    );
  });

  it("gives Personal & lön its own menu permission", () => {
    const personal = { role: "user" as const, permissions: ["personal"] as const };
    expect(canOpen(personal, "/personal")).toBe(true);
    expect(canOpen(personal, "/personal/anstallda/x1")).toBe(true);
    expect(canOpen(personal, "/personal/attestering")).toBe(true);
    expect(canOpen(personal, "/tillverkning/scheman")).toBe(false);
    expect(canOpen({ role: "user", permissions: ["tillverkning"] }, "/personal/attestering")).toBe(false);
    expect(canOpen(sales, "/personal")).toBe(false);
    // A menu permission counts as office, so the dashboard is the landing page.
    expect(landingFor(personal)).toBe("/");
  });

  it("keeps System admin-only and Ekonomi behind its permission", () => {
    expect(canOpen(sales, "/system/anvandare")).toBe(false);
    expect(canOpen(admin, "/system/behorighetsgrupper")).toBe(true);
    expect(canOpen(sales, "/ekonomi/verifikat")).toBe(false);
    expect(canOpen({ role: "user", permissions: ["ekonomi"] }, "/ekonomi/verifikat")).toBe(true);
  });

  it("treats an unknown path as admin-only (fail closed)", () => {
    expect(pageAccessFor("/nagot-nytt")).toBe(null);
    expect(canOpen(sales, "/nagot-nytt")).toBe(false);
    expect(canOpen(admin, "/nagot-nytt")).toBe(true);
  });

  it("does not let a prefix leak into a sibling path", () => {
    expect(pageAccessFor("/lagerx")).toBe(null);
  });

  it("lands each profile on a page it can open", () => {
    expect(landingFor(sales)).toBe("/");
    expect(landingFor(workshop)).toBe("/tillverkning");
    expect(landingFor({ role: "user", permissions: ["artikeloversikt"] })).toBe("/artiklar");
    expect(landingFor(nobody)).toBe("/ingen-behorighet");
  });
});

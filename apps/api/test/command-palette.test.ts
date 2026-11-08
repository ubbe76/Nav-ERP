import { describe, expect, it } from "vitest";
// The web's pure palette logic (Nav som program, punkt 2) — loaded directly,
// like the other web mirrors.
import {
  RECENT_MAX,
  addRecent,
  foldText,
  matchPages,
  palettePages,
  parseRecent,
  searchesFor,
  type PalettePage,
} from "../../web/lib/commandPalette.js";

describe("Sök och kommandon (Ctrl+K)", () => {
  const sales = { role: "user" as const, permissions: ["forsaljning" as const] };
  const purchasing = { role: "user" as const, permissions: ["inkop" as const] };
  const admin = { role: "admin" as const, permissions: [] };

  it("offers only pages the user may open — the sidebar's and module pages' own rules", () => {
    const hrefs = palettePages(sales).map((p) => p.href);
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/forsaljning");
    expect(hrefs).toContain("/forsaljning/ordrar");
    expect(hrefs.some((h) => h.startsWith("/system"))).toBe(false);
    expect(hrefs.some((h) => h.startsWith("/inkop"))).toBe(false);
    // Referensränta is open to Försäljning, but lies under Ekonomi, which is not.
    expect(hrefs.some((h) => h.startsWith("/ekonomi"))).toBe(false);
    // An admin sees System; a page listed under two modules appears once.
    const adminPages = palettePages(admin);
    expect(adminPages.some((p) => p.href === "/system")).toBe(true);
    expect(adminPages.filter((p) => p.href === "/lager/vardering")).toHaveLength(1);
  });

  it("matches every word in the title or module, folding å/ä/ö, title starts first", () => {
    const pages: PalettePage[] = [
      { href: "/a", title: "Lagervärdering", module: "Lager" },
      { href: "/b", title: "Värdering per artikel", module: "Rapporter" },
      { href: "/c", title: "Fakturor", module: "Försäljning" },
      { href: "/d", title: "Leverantörsfakturor", module: "Inköp" },
    ];
    expect(foldText("Lagervärdering ÅÄÖ")).toBe("lagervardering aao");
    expect(matchPages("lagervardering", pages).map((p) => p.href)).toEqual(["/a"]);
    expect(matchPages("värdering", pages).map((p) => p.href)).toEqual(["/b", "/a"]);
    expect(matchPages("forsaljning fakt", pages).map((p) => p.href)).toEqual(["/c"]);
    expect(matchPages("faktur", pages).map((p) => p.href)).toEqual(["/c", "/d"]);
    expect(matchPages("   ", pages)).toEqual([]);
  });

  it("searches only the registers whose list the user may open", () => {
    expect(searchesFor(sales).map((s) => s.key)).toEqual(["sales", "invoices", "customers"]);
    expect(searchesFor(purchasing).map((s) => s.key)).toEqual(["purchase", "suppliers"]);
    expect(searchesFor(admin).map((s) => s.key)).toEqual(["sales", "purchase", "manufacturing", "invoices", "articles", "customers", "suppliers"]);
    const [salesSearch] = searchesFor(sales);
    expect(salesSearch!.url("KO 5")).toBe("/api/v1/sales-orders?search=KO%205&limit=3");
    expect(salesSearch!.map({ id: "q1", orderNumber: "OF-1001", customerName: "Hotell Exempel AB", documentKind: "quote" })).toEqual({
      key: "sales:q1",
      href: "/forsaljning/offerter/q1",
      title: "OF-1001 · Hotell Exempel AB",
      kind: "Offert",
    });
  });

  it("keeps the recent pages newest first, once each, and drops what is not a page in Nav", () => {
    let list = addRecent([], { href: "/a", title: "A" });
    list = addRecent(list, { href: "/b", title: "B" });
    list = addRecent(list, { href: "/a", title: "A igen" });
    expect(list).toEqual([
      { href: "/a", title: "A igen" },
      { href: "/b", title: "B" },
    ]);
    for (let i = 0; i < 20; i++) list = addRecent(list, { href: `/p${i}`, title: `P${i}` });
    expect(list).toHaveLength(RECENT_MAX);
    expect(parseRecent(JSON.stringify([{ href: "//evil.example", title: "x" }, { href: "/ok", title: "Ok" }, { href: 3 }]))).toEqual([
      { href: "/ok", title: "Ok" },
    ]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });
});

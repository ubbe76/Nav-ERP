import { describe, expect, it } from "vitest";
// Översikten's Favoriter card groups the favourites by module — the web's
// pure grouping, loaded directly like the other web files.
import { OTHER_FAVORITES, favoriteModule, groupFavorites } from "../../web/lib/favoriteGroups.js";
import { NAV_MODULES } from "../../web/lib/navModules.js";

describe("Favoriter på Översikten, grupperade per modul", () => {
  it("puts a page under its module — by its address first, then by the hub that lists it", () => {
    expect(favoriteModule("/forsaljning/ordrar")).toBe("Försäljning");
    // A saved filter, a shortcut and a document keep their page's module.
    expect(favoriteModule("/forsaljning/ordrar?status=confirmed&page=2")).toBe("Försäljning");
    expect(favoriteModule("/inkop/ordrar?ny=1")).toBe("Inköp");
    expect(favoriteModule("/tillverkning/ordrar/0b7e4a52-6f1c-4d39-9a43-2f8e1c5d7a10")).toBe("Tillverkning");
    expect(favoriteModule("/kvalitet/avvikelser/ny")).toBe("Kvalitet");
    // The module's own page.
    expect(favoriteModule("/lager")).toBe("Lager");
    // Registers outside the module's address: the hub that lists them, and a
    // card under its register.
    expect(favoriteModule("/kunder")).toBe("Försäljning");
    expect(favoriteModule("/kunder/0b7e4a52-6f1c-4d39-9a43-2f8e1c5d7a10")).toBe("Försäljning");
    expect(favoriteModule("/leverantorer")).toBe("Inköp");
    // Listed by two hubs: the module whose address it lies under wins.
    expect(favoriteModule("/rapporter/kassation")).toBe("Rapporter");
    expect(favoriteModule("/lager/vardering")).toBe("Lager");
    // A prefix of a word is not a parent: /lagerX is not under /lager.
    expect(favoriteModule("/lagerplatser-x")).toBeNull();
    // Outside every module.
    expect(favoriteModule("/")).toBeNull();
    expect(favoriteModule("/aviseringar")).toBeNull();
    expect(favoriteModule("/mina-installningar")).toBeNull();
  });

  it("knows every page the module hubs list", () => {
    for (const mod of NAV_MODULES) {
      for (const section of mod.sections) {
        for (const item of section.items) expect(favoriteModule(item.href), item.href).not.toBeNull();
      }
    }
  });

  it("orders the groups as the sidebar, keeps the user's order inside each, and ends with Övrigt", () => {
    const favorites = [
      { href: "/aviseringar", title: "Aviseringar" },
      { href: "/forsaljning/ordrar", title: "Kundorder" },
      { href: "/artiklar", title: "Artiklar" },
      { href: "/kunder", title: "Kunder" },
      { href: "/forsaljning/fakturor", title: "Fakturor" },
      { href: "/hjalp", title: "Hjälp" },
    ];
    const groups = groupFavorites(favorites);
    expect(groups.map((g) => g.title)).toEqual(["Artiklar", "Försäljning", OTHER_FAVORITES]);
    expect(groups[1]!.favorites.map((f) => f.title)).toEqual(["Kundorder", "Kunder", "Fakturor"]);
    expect(groups[2]!.favorites.map((f) => f.title)).toEqual(["Aviseringar", "Hjälp"]);
    expect(groups.flatMap((g) => g.favorites)).toHaveLength(favorites.length);
    expect(groupFavorites([])).toEqual([]);
  });
});

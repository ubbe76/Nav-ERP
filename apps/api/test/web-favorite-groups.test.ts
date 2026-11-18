import { describe, expect, it } from "vitest";
// Översikten's Favoriter card groups the favourites by module — the web's
// pure grouping, loaded directly like the other web files.
import {
  OTHER_FAVORITES,
  favoriteModule,
  groupFavorites,
  moveFavoriteGroup,
  moveFavoriteInGroup,
  withFavorite,
} from "../../web/lib/favoriteGroups.js";
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

  const favorites = [
    { href: "/aviseringar", title: "Aviseringar" },
    { href: "/forsaljning/ordrar", title: "Kundorder" },
    { href: "/artiklar", title: "Artiklar" },
    { href: "/kunder", title: "Kunder" },
    { href: "/forsaljning/fakturor", title: "Fakturor" },
    { href: "/hjalp", title: "Hjälp" },
  ];
  const titles = (list: readonly { title: string }[]) => list.map((f) => f.title);

  it("orders the groups by their first favourite and keeps the user's order inside each", () => {
    const groups = groupFavorites(favorites);
    expect(groups.map((g) => g.title)).toEqual([OTHER_FAVORITES, "Försäljning", "Artiklar"]);
    expect(titles(groups[0]!.favorites)).toEqual(["Aviseringar", "Hjälp"]);
    expect(titles(groups[1]!.favorites)).toEqual(["Kundorder", "Kunder", "Fakturor"]);
    expect(groups.flatMap((g) => g.favorites)).toHaveLength(favorites.length);
    expect(groupFavorites([])).toEqual([]);
  });

  it("moves a whole group, its favourites with it, and saves the list module by module", () => {
    // Försäljning up past Övrigt.
    expect(titles(moveFavoriteGroup(favorites, 1, -1))).toEqual([
      "Kundorder",
      "Kunder",
      "Fakturor",
      "Aviseringar",
      "Hjälp",
      "Artiklar",
    ]);
    // Artiklar down: already last — the list comes back grouped, nothing lost.
    expect(titles(moveFavoriteGroup(favorites, 2, 1))).toEqual([
      "Aviseringar",
      "Hjälp",
      "Kundorder",
      "Kunder",
      "Fakturor",
      "Artiklar",
    ]);
  });

  it("moves a favourite only within its group", () => {
    // Kunder (second in Försäljning) up to first.
    expect(titles(moveFavoriteInGroup(favorites, 1, 1, -1))).toEqual([
      "Aviseringar",
      "Hjälp",
      "Kunder",
      "Kundorder",
      "Fakturor",
      "Artiklar",
    ]);
    // Kundorder (first in Försäljning) up: stays — never into Övrigt.
    expect(titles(moveFavoriteInGroup(favorites, 1, 0, -1))).toEqual([
      "Aviseringar",
      "Hjälp",
      "Kundorder",
      "Kunder",
      "Fakturor",
      "Artiklar",
    ]);
    // Fakturor (last) down: stays.
    expect(titles(moveFavoriteInGroup(favorites, 1, 2, 1)).slice(2, 5)).toEqual(["Kundorder", "Kunder", "Fakturor"]);
  });

  it("adds a favourite after the last one of its module, or last when it starts a group", () => {
    const grouped = moveFavoriteGroup(favorites, 0, -1);
    expect(titles(withFavorite(grouped, { href: "/forsaljning/offerter", title: "Offerter" }))).toEqual([
      "Aviseringar",
      "Hjälp",
      "Kundorder",
      "Kunder",
      "Fakturor",
      "Offerter",
      "Artiklar",
    ]);
    expect(titles(withFavorite(grouped, { href: "/lager/saldon", title: "Lagersaldon" })).at(-1)).toBe("Lagersaldon");
    // The rest of an ungrouped list keeps its order.
    const loose = [
      { href: "/forsaljning/ordrar", title: "Kundorder" },
      { href: "/artiklar", title: "Artiklar" },
      { href: "/kunder", title: "Kunder" },
    ];
    expect(titles(withFavorite(loose, { href: "/forsaljning/fakturor", title: "Fakturor" }))).toEqual([
      "Kundorder",
      "Artiklar",
      "Kunder",
      "Fakturor",
    ]);
  });
});

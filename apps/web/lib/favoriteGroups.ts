// Översikten's Favoriter card groups the favourites by the module they belong
// to, in the sidebar's order, with the user's own order inside each group.
// Pure — the API suite tests it (web-favorite-groups.test.ts).
import { NAV_MODULES } from "./navModules";

// Favourites outside every module: Översikt, Aviseringar, Hjälp, Mina
// inställningar, an add-on's page.
export const OTHER_FAVORITES = "Övrigt";

export interface FavoriteGroup<T> {
  title: string;
  favorites: T[];
}

// The module a favourite belongs to, or null. A path under a module's own
// address belongs to that module (/rapporter/kassation is Rapporter, even
// though Kvalitet lists it too); otherwise the module whose hub lists the
// page or the page it lies under — /kunder/<id> is Försäljning, /leverantorer
// Inköp — the longest match winning, and on a tie the first module in the
// sidebar (/grunddata is listed by Artiklar, Inköp and Försäljning). The
// query string never matters: `?ny=1` and saved filters keep their page's
// module.
export function favoriteModule(href: string): string | null {
  const path = href.split("?")[0]!;
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  const own = NAV_MODULES.find((mod) => under(mod.href));
  if (own) return own.title;
  let best: { title: string; length: number } | null = null;
  for (const mod of NAV_MODULES) {
    for (const section of mod.sections) {
      for (const item of section.items) {
        const itemPath = item.href.split("?")[0]!;
        if (under(itemPath) && (!best || itemPath.length > best.length)) {
          best = { title: mod.title, length: itemPath.length };
        }
      }
    }
  }
  return best?.title ?? null;
}

export function groupFavorites<T extends { href: string }>(favorites: readonly T[]): FavoriteGroup<T>[] {
  const byModule = new Map<string, T[]>();
  for (const favorite of favorites) {
    const title = favoriteModule(favorite.href) ?? OTHER_FAVORITES;
    const group = byModule.get(title);
    if (group) group.push(favorite);
    else byModule.set(title, [favorite]);
  }
  const order = [...NAV_MODULES.map((mod) => mod.title), OTHER_FAVORITES];
  return order.flatMap((title) => {
    const group = byModule.get(title);
    return group ? [{ title, favorites: group }] : [];
  });
}

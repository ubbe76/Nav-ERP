// Favourites grouped by the module they belong to — Översikten's Favoriter
// card and the list editor (Ändra, a behörighetsgrupp's förvalda favoriter).
// The list stays one flat, ordered `{ href, title }[]`; the groups' order is
// the order their first favourite appears in it, and the editor saves the
// list module by module, so moving a group or a favourite within its group
// is just a new flat order. Pure — the API suite tests it
// (web-favorite-groups.test.ts).
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

// The groups in the order their first favourite appears, the favourites in
// list order within each.
export function groupFavorites<T extends { href: string }>(favorites: readonly T[]): FavoriteGroup<T>[] {
  const groups: FavoriteGroup<T>[] = [];
  for (const favorite of favorites) {
    const title = favoriteModule(favorite.href) ?? OTHER_FAVORITES;
    const group = groups.find((g) => g.title === title);
    if (group) group.favorites.push(favorite);
    else groups.push({ title, favorites: [favorite] });
  }
  return groups;
}

function flatten<T>(groups: readonly FavoriteGroup<T>[]): T[] {
  return groups.flatMap((group) => group.favorites);
}

function moved<T>(list: readonly T[], index: number, step: -1 | 1): T[] {
  const target = index + step;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

// Moves a whole module's group one step, its favourites with it.
export function moveFavoriteGroup<T extends { href: string }>(
  favorites: readonly T[],
  groupIndex: number,
  step: -1 | 1
): T[] {
  return flatten(moved(groupFavorites(favorites), groupIndex, step));
}

// Moves a favourite one step within its own group — never past its edge.
export function moveFavoriteInGroup<T extends { href: string }>(
  favorites: readonly T[],
  groupIndex: number,
  index: number,
  step: -1 | 1
): T[] {
  return flatten(
    groupFavorites(favorites).map((group, i) =>
      i === groupIndex ? { ...group, favorites: moved(group.favorites, index, step) } : group
    )
  );
}

// A new favourite goes after the last one of its module, or last of all when
// it starts a new group. The rest of the list keeps its order (a star click
// never reshuffles the sidebar).
export function withFavorite<T extends { href: string }>(favorites: readonly T[], favorite: T): T[] {
  const title = favoriteModule(favorite.href) ?? OTHER_FAVORITES;
  let last = -1;
  favorites.forEach((f, i) => {
    if ((favoriteModule(f.href) ?? OTHER_FAVORITES) === title) last = i;
  });
  if (last < 0) return [...favorites, favorite];
  return [...favorites.slice(0, last + 1), favorite, ...favorites.slice(last + 1)];
}

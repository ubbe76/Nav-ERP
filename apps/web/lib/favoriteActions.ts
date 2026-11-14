import { palettePages, type PaletteUser } from "./commandPalette";
import { canOpen } from "./pageAccess";
import { PERMISSION_IMPLIES, type Permission } from "./permissions";
import type { Favorite } from "./favorites";

// Genvägar som favoriter: "+ Ny …" opens the list page with ?ny=1, which
// opens the page's own dialog at once (useNewFromQuery, or the page's own
// reading of the parameter — kundorder, inköpsorder, leverantör); Ny
// avvikelse is a page of its own. A shortcut is offered only to someone who
// may open the page — the page's button decides the rest, as when clicked.
export const FAVORITE_ACTIONS: readonly Favorite[] = [
  { href: "/forsaljning/offerter?ny=1", title: "+ Ny offert" },
  { href: "/forsaljning/ordrar?ny=1", title: "+ Ny kundorder" },
  { href: "/forsaljning/fakturor?ny=1", title: "+ Ny faktura" },
  { href: "/kunder?ny=1", title: "+ Ny kund" },
  { href: "/inkop/forfragningar?ny=1", title: "+ Ny förfrågan" },
  { href: "/inkop/ordrar?ny=1", title: "+ Ny inköpsorder" },
  { href: "/inkop/leverantorsfakturor?ny=1", title: "+ Ny leverantörsfaktura" },
  { href: "/leverantorer?ny=1", title: "+ Ny leverantör" },
  { href: "/artiklar/register?ny=1", title: "+ Ny artikel" },
  { href: "/tillverkning/ordrar?ny=1", title: "+ Ny tillverkningsorder" },
  { href: "/tillverkning/tidrapporter?ny=1", title: "+ Ny tidrapport" },
  { href: "/kvalitet/avvikelser/ny", title: "+ Ny avvikelse" },
];

export function favoriteActionsFor(user: PaletteUser): Favorite[] {
  return FAVORITE_ACTIONS.filter((action) => canOpen(user, action.href));
}

// Förvalda favoriter on a behörighetsgrupp: what a member of the group may
// open — the group's permissions with what they imply, as the session
// expands them — pages first (Översikt, the module pages and their items),
// then the shortcuts.
export function groupFavoriteChoices(permissions: readonly string[]): { pages: Favorite[]; actions: Favorite[] } {
  const own = permissions as readonly Permission[];
  const expanded = [...new Set([...own, ...own.flatMap((p) => PERMISSION_IMPLIES[p] ?? [])])];
  const member: PaletteUser = { role: "user", permissions: expanded };
  return {
    pages: palettePages(member).map((page) => ({
      href: page.href,
      title: page.title,
    })),
    actions: favoriteActionsFor(member),
  };
}

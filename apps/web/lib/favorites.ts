import { apiGet } from "./api";
import type { ListColumns, TableDensity } from "./listColumns";
import { hasFavoritesCard } from "./overviewCards";

// Favoriter: the user's own shortcuts at the top of the sidebar, stored as
// the personal setting `favorites` (GET/PATCH /me/settings, replaced as a
// whole list). Mirrors favoriteSchema in packages/shared/src/user-settings.ts
// — the web can't import @navet/shared (see lib/units.ts).
export interface Favorite {
  href: string;
  title: string;
}

export const MAX_FAVORITES = 20;
export const FAVORITE_TITLE_MAX = 60;

// The address a page is saved under: its path and filters, without the page
// number — a saved list should open on its first page.
export function favoriteHref(pathname: string, searchParams: URLSearchParams | { toString(): string }): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("page");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

// Server Components: the signed-in user's list, or null when it couldn't be
// read — the sidebar group and the stars then stay hidden instead of
// offering to overwrite a list nobody has seen.
// The favourites and where they show (`favoritesInSidebar`, default true —
// false leaves them to Översikten's Favoriter card). `favorites` null on a
// failed read: the group then stays hidden.
export interface FavoritesState {
  favorites: Favorite[] | null;
  // The list is the behörighetsgrupp's förvalda favoriter (the user has not
  // saved one of their own).
  fromGroup: boolean;
  inSidebar: boolean;
  // Översikten shows the Favoriter card (`overviewCards`).
  onOverview: boolean;
}

// The frame's personal settings in one read (AppShell and Översikten): the
// favourites, plus Täthet and Kolumner (Nav som program, punkt 6) — those
// fall back to normal and none, so a failed read only costs the user's own
// layout.
export interface ShellSettings extends FavoritesState {
  density: TableDensity;
  listColumns: ListColumns;
  // Flikar (punkt 5): documents as tabs on a wide screen; default on.
  documentTabs: boolean;
}

export async function loadShellSettings(cookieHeader: string | undefined): Promise<ShellSettings> {
  const fallback: ShellSettings = {
    favorites: null,
    fromGroup: false,
    inSidebar: true,
    onOverview: false,
    density: "normal",
    listColumns: {},
    documentTabs: true,
  };
  if (!cookieHeader) return fallback;
  try {
    const settings = await apiGet<{
      favorites?: Favorite[];
      favoritesFromGroup?: boolean;
      favoritesInSidebar?: boolean;
      overviewCards?: unknown;
      density?: string;
      listColumns?: ListColumns;
      documentTabs?: boolean;
    }>("/api/v1/me/settings", cookieHeader);
    return {
      favorites: settings.favorites ?? null,
      fromGroup: settings.favoritesFromGroup === true,
      inSidebar: settings.favoritesInSidebar !== false,
      onOverview: hasFavoritesCard(settings.overviewCards),
      density: settings.density === "compact" ? "compact" : "normal",
      listColumns: settings.listColumns ?? {},
      documentTabs: settings.documentTabs !== false,
    };
  } catch {
    return fallback;
  }
}

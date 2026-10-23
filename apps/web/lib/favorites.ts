import { apiGet } from "./api";

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
export async function loadFavorites(cookieHeader: string | undefined): Promise<Favorite[] | null> {
  if (!cookieHeader) return null;
  try {
    const settings = await apiGet<{ favorites?: Favorite[] }>("/api/v1/me/settings", cookieHeader);
    return settings.favorites ?? null;
  } catch {
    return null;
  }
}

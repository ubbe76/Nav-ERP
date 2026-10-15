import { cache } from "react";
import { headers } from "next/headers";
import { apiGet } from "./api";
import { LIST_PAGE_SIZE } from "./listQuery";

interface UserSettingsResponse {
  listPageSize: number;
  hideOnboarding?: boolean;
}

// Server-side only (Server Components): the current user's "Rader per sida"
// preference (GET /me/settings), for listApiQuery()/<Pagination pageSize=…>.
// Wrapped in React's cache() so a page that reads it more than once during
// the same request still makes at most one round trip. Falls back to
// LIST_PAGE_SIZE on any error — a settings-fetch failure (logged out, API
// down) must never stop a list page from rendering.
export const getListPageSize = cache(async (): Promise<number> => {
  try {
    const cookieHeader = (await headers()).get("cookie") ?? undefined;
    const settings = await apiGet<UserSettingsResponse>("/api/v1/me/settings", cookieHeader);
    return settings.listPageSize;
  } catch {
    return LIST_PAGE_SIZE;
  }
});

// Lista och kort (Programramen, steg 2): whether a function's list page shows
// the narrow list beside the card (the default) or the wide table (Visa som
// tabell). Kept per list in a cookie, so the page knows before it fetches
// anything; a convenience per browser, never business data. Pure: the
// cookie's value is the list paths in table view, "|"-separated.
export const LIST_VIEW_COOKIE = "nav-list-view";

export type ListView = "list" | "table";

export function tablesOf(cookieValue: string | undefined): string[] {
  if (!cookieValue) return [];
  try {
    return decodeURIComponent(cookieValue)
      .split("|")
      .filter((p) => p.startsWith("/"));
  } catch {
    return [];
  }
}

export function listViewOf(cookieValue: string | undefined, path: string): ListView {
  return tablesOf(cookieValue).includes(path) ? "table" : "list";
}

// The cookie after choosing `view` for `path`.
export function withListView(cookieValue: string | undefined, path: string, view: ListView): string {
  const tables = tablesOf(cookieValue).filter((p) => p !== path);
  if (view === "table") tables.push(path);
  return encodeURIComponent(tables.join("|"));
}

// A list page opened with a query — a filter, a search, a page, a ?ny=1
// shortcut, a favourite with a filter — shows the table: that is what the
// query is for.
export function hasListQuery(searchParams: Record<string, string | string[] | undefined>): boolean {
  return Object.values(searchParams).some((v) => v !== undefined && v !== "");
}

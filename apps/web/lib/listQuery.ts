export const LIST_PAGE_SIZE = 50;

// Mirrors @navet/shared's user-settings.ts LIST_PAGE_SIZE_OPTIONS — the web
// app cannot import @navet/shared (Turbopack chokes on its .js-suffix
// imports), so the allowed "rader per sida" values are duplicated here.
export const LIST_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

export type PageSearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function pageFromSearchParams(sp: PageSearchParams): number {
  const raw = single(sp.page);
  const page = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

// Translates a list page's URL searchParams (?search=&page=&…) into the API's
// query string (?search=&limit=&offset=&…). extraKeys are passed through
// verbatim (e.g. type/groupId for articles, status for order lists).
// pageSize defaults to LIST_PAGE_SIZE but callers normally pass the user's
// "rader per sida" preference from getListPageSize() (server-side helper in
// listPageSize.ts, fetched once and passed down as a prop).
export function listApiQuery(sp: PageSearchParams, extraKeys: string[] = [], pageSize: number = LIST_PAGE_SIZE): string {
  const params = new URLSearchParams();
  const search = single(sp.search);
  if (search) params.set("search", search);
  for (const key of extraKeys) {
    const value = single(sp[key]);
    if (value) params.set(key, value);
  }
  const page = pageFromSearchParams(sp);
  params.set("limit", String(pageSize));
  params.set("offset", String((page - 1) * pageSize));
  return `?${params.toString()}`;
}

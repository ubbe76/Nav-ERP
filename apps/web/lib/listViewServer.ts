import { cookies } from "next/headers";
import { LIST_VIEW_COOKIE, hasListQuery, listViewOf, type ListView } from "./listView";

// Server side of lib/listView.ts: the view a list page draws now.
export async function listPageView(
  path: string,
  searchParams: Record<string, string | string[] | undefined>
): Promise<ListView> {
  if (hasListQuery(searchParams)) return "table";
  return listViewOf((await cookies()).get(LIST_VIEW_COOKIE)?.value, path);
}

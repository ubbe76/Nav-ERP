import { apiGet } from "./api";

// Flera lager for the server side (AppShell, the pages that write a place
// themselves). A failed read shows the warehouse — no place is ever hidden
// behind an error.
export async function loadMultipleWarehouses(cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader) return true;
  try {
    const settings = await apiGet<{ multipleWarehouses?: boolean }>("/api/v1/settings/stock", cookieHeader);
    return settings.multipleWarehouses !== false;
  } catch {
    return true;
  }
}

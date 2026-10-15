import type { ConfiguratorGroupDetail, ConfiguratorSelection } from "../../lib/configurator";
import { parseDecimal } from "./parseDecimal";

export type RawConfiguration = Record<string, string | boolean>;

// Raw form state -> the selection the API evaluates. `pending` = a half-typed
// measure ("12,") that must not be evaluated yet (it would fall back to the default).
// An untouched group (undefined) is omitted so its default applies; "" is deliberately empty ⇒ null.
export function selectionFromRaw(
  groups: ConfiguratorGroupDetail[],
  raw: RawConfiguration,
): { selection: ConfiguratorSelection; pending: boolean } {
  const selection: ConfiguratorSelection = {};
  for (const g of groups) {
    const v = raw[g.code];
    if (v === undefined) continue;
    if (g.kind === "boolean") selection[g.code] = v === true;
    else if (g.kind === "choice") {
      // "" = the user picked — Välj — (or the stored row left it empty): null clears the default.
      if (typeof v === "string") selection[g.code] = v !== "" ? v : null;
    } else if (typeof v === "string") {
      const n = parseDecimal(v);
      if (n !== null) selection[g.code] = n;
      else if (v.trim() !== "") return { selection, pending: true };
      else selection[g.code] = null;
    }
  }
  return { selection, pending: false };
}

// Stored selection -> form state (Ändra konfiguration / Konfigurera om).
// Measures are shown with decimal comma, as the user types them.
export function rawFromSelection(groups: ConfiguratorGroupDetail[], selection: ConfiguratorSelection): RawConfiguration {
  const raw: RawConfiguration = {};
  for (const g of groups) {
    const v = selection[g.code];
    if (v === undefined) continue;
    // null = the stored row/variant left the group empty: — Välj — / an empty measure, not the default.
    if (v === null) { raw[g.code] = g.kind === "boolean" ? false : ""; continue; }
    if (g.kind === "boolean") raw[g.code] = v === true;
    else if (g.kind === "choice") raw[g.code] = String(v);
    else raw[g.code] = String(v).replace(".", ",");
  }
  return raw;
}

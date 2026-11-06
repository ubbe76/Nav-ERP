// Pure helpers for the lagerplats pickers (no imports — the API test suite loads
// this file directly). A spärrad (blocked) lagerplats still takes goods in but
// is never drawn from: inflow pickers show it with a suffix, pure outflow
// pickers (Utleverans, Leverera, Förbruka) leave it out.

export interface LocationOptionInput {
  warehouseName: string;
  name: string;
  blocked?: boolean;
  active?: boolean;
}

// "Huvudlager — K1", "Huvudlager — K1 (spärrad)". `inactive` adds "(inaktiv)"
// for pickers that list inactive locations too (the logs filter).
export function locationOptionLabel(l: LocationOptionInput, opts: { inactive?: boolean } = {}): string {
  const tags: string[] = [];
  if (l.blocked) tags.push("spärrad");
  if (opts.inactive && l.active === false) tags.push("inaktiv");
  return `${l.warehouseName} — ${l.name}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
}

// Locations a pure outflow may name: the spärrade ones are left out.
export function outflowLocationChoices<T extends { blocked?: boolean }>(locations: T[]): T[] {
  return locations.filter((l) => !l.blocked);
}

// Fields for a picker that shows a current value even if it was blocked since:
// the usual choices (blocked left out) plus the current one, tagged by the label.
export function withCurrentLocation<T extends { id: string; blocked?: boolean }>(
  locations: T[],
  currentId: string | null | undefined
): T[] {
  return locations.filter((l) => !l.blocked || l.id === currentId);
}

// Moves the item at `index` one step up (-1) or down (+1); out of range = same list.
export function moveInList<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items;
  const next = items.slice();
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

// The Plats column of the saldo table: Huvudplats / Alternativ N (index in the
// ordered alternatives + 1) / "–".
export function articleLocationRole(
  locationId: string | null,
  primaryId: string | null | undefined,
  alternativeIds: string[]
): string {
  if (!locationId) return "–";
  if (locationId === primaryId) return "Huvudplats";
  const i = alternativeIds.indexOf(locationId);
  return i >= 0 ? `Alternativ ${i + 1}` : "–";
}

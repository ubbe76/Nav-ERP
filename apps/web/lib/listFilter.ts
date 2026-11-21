// Flerval i listornas filter (2026-11-21, the user: "fler val av status" and
// "välja flera filter samtidigt … även i kolumn-layout"): a list's status (or
// type) filter as a set of chosen values, sent as one comma-separated query
// param ("status=draft,confirmed") — the API's statusListParam. The narrow
// list's chips and the table's Status menu (ListMultiFilter) both build on
// these helpers and on ONE definition per list (lib/statusFilters.ts).
// Import-free, so the API suite can test it.

export interface FilterChoice {
  value: string;
  label: string;
}

// A shortcut over several values (Öppna = Utkast + Bekräftad + Delvis
// mottagen): chosen when all of them are, and choosing it chooses them all.
export interface FilterGroup {
  label: string;
  values: string[];
}

export interface MultiFilter {
  // The query param: "status" on the documents, "type" on the articles.
  param: string;
  options: FilterChoice[];
  groups?: FilterGroup[];
  // Derived pseudo statuses (Sen, Halvfabrikat sent): the API applies them
  // together with the chosen statuses (the late ones AMONG them), so they
  // narrow instead of adding — drawn apart from the statuses.
  narrow?: FilterChoice[];
  // Avslutade (2026-11-21, the user: "Sätt som default att Stängda/Avslutade
  // order inte visas. De visas genom man väljer det i en bockruta"): the
  // end statuses, left out of the list — and of its chips and menu — until
  // the box is ticked. A finished status named in the address (an old link,
  // a favourite) ticks it by itself.
  finished?: { values: string[]; label: string };
}

// The box's query param on the table pages ("true" when ticked).
export const SHOW_FINISHED_PARAM = "showFinished";

function order(filter: MultiFilter): string[] {
  return [...filter.options, ...(filter.narrow ?? [])].map((c) => c.value);
}

// "draft, confirmed,x" → ["draft", "confirmed"]: known values only, once
// each, in the filter's order (so the address reads the same whatever order
// they were chosen in).
export function parseFilterValue(filter: MultiFilter, raw: string | null | undefined): string[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(",").map((p) => p.trim()));
  return order(filter).filter((v) => wanted.has(v));
}

export function toggleFilterValue(filter: MultiFilter, selected: readonly string[], value: string): string[] {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return order(filter).filter((v) => next.has(v));
}

export function groupChosen(group: FilterGroup, selected: readonly string[]): "all" | "some" | "none" {
  const n = group.values.filter((v) => selected.includes(v)).length;
  return n === 0 ? "none" : n === group.values.length ? "all" : "some";
}

// All chosen → all off; otherwise all on (what else was chosen stays).
export function toggleFilterGroup(filter: MultiFilter, selected: readonly string[], group: FilterGroup): string[] {
  const all = groupChosen(group, selected) === "all";
  const next = new Set(selected);
  for (const v of group.values) {
    if (all) next.delete(v);
    else next.add(v);
  }
  return order(filter).filter((v) => next.has(v));
}

// The query param's value; "" = no filter (Alla).
export function filterParamValue(selected: readonly string[]): string {
  return selected.join(",");
}

// What the table's menu button says: "Alla statusar", a chosen group by its
// name in place of its statuses ("Öppna, Mottagen"), one or two labels, or
// the first two and how many more.
export function filterSummary(filter: MultiFilter, selected: readonly string[], allLabel: string): string {
  if (selected.length === 0) return allLabel;
  const narrow = new Set((filter.narrow ?? []).map((c) => c.value));
  const statuses = selected.filter((v) => !narrow.has(v));
  const labels: string[] = [];
  const group = filter.groups?.find((g) => g.values.length > 1 && groupChosen(g, statuses) === "all");
  if (group) labels.push(group.label);
  for (const v of statuses) if (!group?.values.includes(v)) labels.push(labelOf(filter, v));
  for (const v of selected) if (narrow.has(v)) labels.push(labelOf(filter, v));
  return labels.length <= 2 ? labels.join(", ") : `${labels[0]}, ${labels[1]} +${labels.length - 2}`;
}

function labelOf(filter: MultiFilter, value: string): string {
  return [...filter.options, ...(filter.narrow ?? [])].find((c) => c.value === value)?.label ?? value;
}

// Whether the finished statuses are shown: the box, or one of them chosen.
export function showsFinished(filter: MultiFilter, chosen: readonly string[], ticked: boolean): boolean {
  if (!filter.finished) return true;
  return ticked || chosen.some((v) => filter.finished!.values.includes(v));
}

// The status chips and checkboxes to draw: without the finished ones while
// they are hidden.
export function visibleOptions(filter: MultiFilter, show: boolean): FilterChoice[] {
  if (show || !filter.finished) return filter.options;
  return filter.options.filter((o) => !filter.finished!.values.includes(o.value));
}

// Unticking the box: the finished values leave the choice too.
export function withoutFinished(filter: MultiFilter, chosen: readonly string[]): string[] {
  return chosen.filter((v) => !filter.finished?.values.includes(v));
}

// What the list asks the API for. With the finished statuses hidden and no
// status chosen, every other status — so "Alla" is all but the finished
// ones; Sen still narrows them.
export function effectiveFilterValue(filter: MultiFilter, chosen: readonly string[], show: boolean): string {
  if (show || !filter.finished) return filterParamValue(chosen);
  const narrow = new Set((filter.narrow ?? []).map((c) => c.value));
  const statuses = withoutFinished(filter, chosen).filter((v) => !narrow.has(v));
  const base = statuses.length > 0 ? statuses : visibleOptions(filter, false).map((o) => o.value);
  return filterParamValue([...base, ...chosen.filter((v) => narrow.has(v))]);
}

// The table page's address → the API's: the status param as the list asks
// for it (above), the box's own param dropped. Server pages and the CSV/
// Excel export both go through it, so the export follows the list.
export function withFinishedRule<T extends Record<string, string | string[] | undefined>>(filter: MultiFilter, sp: T): T {
  if (!filter.finished) return sp;
  const raw = sp[filter.param];
  const chosen = parseFilterValue(filter, typeof raw === "string" ? raw : undefined);
  const show = showsFinished(filter, chosen, sp[SHOW_FINISHED_PARAM] === "true");
  const next: Record<string, string | string[] | undefined> = { ...sp, [filter.param]: effectiveFilterValue(filter, chosen, show) || undefined };
  delete next[SHOW_FINISHED_PARAM];
  return next as T;
}

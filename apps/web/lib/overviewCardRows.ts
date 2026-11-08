// Fler kort på Översikten: the pure mapping from each newer card's API data
// to its rows (ListCard). Type-only imports, so the API suite can load it
// (overview-cards-mirror.test.ts) — the web cannot import @navet/shared and
// vitest cannot load modules that reach for the Next runtime.
import type { AlertGroup } from "./alerts";
import type { CapacityResult } from "./types";

// One row of a ListCard (components/dashboard/ListCard.tsx). Here rather than
// beside the component so the API suite's typecheck never reaches JSX.
export interface ListCardRow {
  key: string;
  /** null = no card to open (rendered as plain text) */
  href: string | null;
  /** red/yellow marker (and figure colour); null = none */
  tone: "red" | "yellow" | null;
  primary: string;
  secondary: string;
  /** A right-hand figure (a date, a percentage), optional. */
  aside?: string;
}

export const OVERVIEW_CARD_ROWS = 6;

// The Sunday that ends the ISO week of `today` (YYYY-MM-DD, a Stockholm
// day) — "denna vecka" for Leveranser/Inleveranser.
export function endOfIsoWeek(today: string): string {
  const [y = 0, m = 1, d = 1] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const toSunday = (7 - date.getUTCDay()) % 7;
  return new Date(Date.UTC(y, m - 1, d + toSunday)).toISOString().slice(0, 10);
}

// Leveranser / Inleveranser denna vecka: the list's rows (already filtered to
// Nästa leveransdatum ≤ Sunday and sorted earliest first). Late = red, today
// = yellow.
export function deliveryRows(
  orders: { id: string; orderNumber: string; counterpartyName: string | null; nextDeliveryDate: string | null }[],
  today: string,
  hrefBase: string
): ListCardRow[] {
  return orders.map((order) => {
    const date = order.nextDeliveryDate;
    const late = date !== null && date < today;
    const isToday = date === today;
    return {
      key: order.id,
      href: `${hrefBase}/${order.id}`,
      tone: late ? "red" : isToday ? "yellow" : null,
      primary: order.counterpartyName ? `${order.orderNumber} · ${order.counterpartyName}` : order.orderNumber,
      secondary: late ? "Försenad" : isToday ? "I dag" : "",
      aside: date ?? "",
    };
  });
}

// One alert kind's card (Förfallna kundfakturor, Leverantörsfakturor att
// betala, Offerter att följa upp): the group's first rows as Aviseringar
// shows them.
export function alertRows(group: AlertGroup | undefined): ListCardRow[] {
  return (group?.items ?? []).slice(0, OVERVIEW_CARD_ROWS).map((item) => ({
    key: item.key,
    href: item.href,
    tone: item.severity,
    primary: item.primary,
    secondary: item.secondary ?? "",
  }));
}

const hours = (h: number) => `${h.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;

// Beläggning denna vecka: every resource with load or capacity this week,
// the most loaded first; over 100 % red, from 90 % yellow. A resource
// without a week schedule has no percentage.
export function capacityRows(capacity: CapacityResult, href: string): { rows: ListCardRow[]; total: number } {
  const resources = capacity.groups
    .flatMap((g) => g.resources)
    .map((r) => ({ resource: r, cell: r.weeks[0] }))
    .filter((x): x is { resource: (typeof x)["resource"]; cell: NonNullable<(typeof x)["cell"]> } => x.cell !== undefined)
    .filter(({ resource, cell }) => resource.active && (cell.loadHours > 0 || (cell.availableHours ?? 0) > 0));
  resources.sort(
    (a, b) =>
      (b.cell.loadPercent ?? -1) - (a.cell.loadPercent ?? -1) ||
      b.cell.loadHours - a.cell.loadHours ||
      a.resource.code.localeCompare(b.resource.code, "sv", { numeric: true })
  );
  const rows = resources.slice(0, OVERVIEW_CARD_ROWS).map(({ resource, cell }): ListCardRow => {
    const percent = cell.loadPercent;
    return {
      key: resource.workCenterId,
      href,
      tone: percent === null ? null : percent > 100 ? "red" : percent >= 90 ? "yellow" : null,
      primary: `${resource.code} ${resource.name}`,
      secondary:
        cell.availableHours === null ? `${hours(cell.loadHours)} · inget schema` : `${hours(cell.loadHours)} av ${hours(cell.availableHours)}`,
      aside: percent === null ? "–" : `${Math.round(percent)} %`,
    };
  });
  return { rows, total: resources.length };
}

// Öppna avvikelser: the overdue ones first (Åtgärd senast passed, red), then
// the newest open — each case once.
export function deviationRows(
  overdue: DeviationCardRow[],
  open: DeviationCardRow[],
  typeLabels: Record<string, string>
): ListCardRow[] {
  const seen = new Set<string>();
  const rows: ListCardRow[] = [];
  for (const d of [...overdue, ...open]) {
    if (seen.has(d.id) || rows.length >= OVERVIEW_CARD_ROWS) continue;
    seen.add(d.id);
    const parts = [typeLabels[d.type] ?? d.type, d.counterpartyName].filter((p): p is string => !!p);
    rows.push({
      key: d.id,
      href: `/kvalitet/avvikelser/${d.id}`,
      tone: d.overdue ? "red" : null,
      primary: `${d.deviationNumber} ${d.title}`,
      secondary: d.overdue ? `${parts.join(" · ")} · Försenad` : parts.join(" · "),
      aside: d.dueDate ?? "",
    });
  }
  return rows;
}

export interface DeviationCardRow {
  id: string;
  deviationNumber: string;
  type: string;
  title: string;
  counterpartyName: string | null;
  dueDate: string | null;
  overdue: boolean;
}

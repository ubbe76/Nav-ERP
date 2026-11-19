import { round4 } from "./format";
import { toUnitQuantity, type UnitFactor } from "./units";
import type { ArticleType, ManufacturingOrderStatus } from "./types";

// Utleverans: does the stock cover what is about to be delivered? The
// routine shows each row's usable saldo (I lager) and warns, never blocks,
// when Leverera nu is more than the stock: the server books the shortage as
// a minus (Automatiskt's remainder lands on the article's place; a chosen
// place goes minus itself). The warning names the row's TOs that are not done
// yet, since an unfinished TO is the usual reason the goods are missing.
// Pure: no React, no fetch (test web-delivery-stock.test.ts).

// The TO statuses that still have goods to come (a whitelist, like every
// status set). Klar, Stängd and Makulerad have nothing more to receive.
const UNFINISHED_MO_STATUSES: ReadonlySet<string> = new Set<ManufacturingOrderStatus>(["planned", "released", "in_progress"]);

export interface DeliveryStockBalance {
  articleId: string;
  locationId: string;
  quantityOnHand: string | number;
  locationBlocked: boolean;
}

export interface DeliveryStockRow {
  id: string;
  articleId: string;
  articleType: ArticleType;
  // Leverera nu in the article's base unit (0 = not delivered now).
  quantity: number;
  // The place the row is taken from: the row's own, else the delivery's;
  // null = Automatiskt.
  locationId: string | null;
}

export interface DeliveryShortage {
  // What the source holds and what this delivery takes from it, in the
  // article's base unit, summed over every row of the article that takes
  // from the same source (rowCount of them).
  available: number;
  demand: number;
  rowCount: number;
  locationId: string | null;
}

export interface DeliveryMo {
  orderNumber: string;
  status: string;
}

// Usable stock of one article from its per-place balances, split as the API's
// onHandByArticle does: a plus on a spärrad lagerplats is not usable, a minus
// there is a debt the usable stock carries (−3 spärrat, +10 öppet = 7).
export function usableOnHand(balances: readonly DeliveryStockBalance[]): number {
  return round4(
    balances.reduce((sum, b) => {
      const q = Number(b.quantityOnHand);
      return b.locationBlocked && q > 0 ? sum : sum + q;
    }, 0)
  );
}

// What one source holds: the chosen place's balance (a spärrad place is
// refused by the server anyway), or the usable stock for Automatiskt.
function availableFrom(balances: readonly DeliveryStockBalance[], locationId: string | null): number {
  if (locationId === null) return usableOnHand(balances);
  return round4(balances.filter((b) => b.locationId === locationId).reduce((sum, b) => sum + Number(b.quantityOnHand), 0));
}

// The rows whose Leverera nu the stock does not cover, by row id. Rows of the
// same article that take from the same source share its stock. Tjänster are
// never stocked (stock.md) and rows with nothing to deliver now are left out.
// balancesByArticle null = the balances are not known (still loading, or the
// read failed): no warnings rather than false ones.
export function deliveryStockShortages(
  rows: readonly DeliveryStockRow[],
  balancesByArticle: Readonly<Record<string, readonly DeliveryStockBalance[]>> | null
): Record<string, DeliveryShortage> {
  if (!balancesByArticle) return {};
  const stocked = rows.filter((r) => r.articleType !== "service" && r.quantity > 0);
  const key = (r: DeliveryStockRow) => `${r.articleId}|${r.locationId ?? ""}`;
  const groups = new Map<string, { demand: number; rowCount: number }>();
  for (const r of stocked) {
    const g = groups.get(key(r)) ?? { demand: 0, rowCount: 0 };
    groups.set(key(r), { demand: g.demand + r.quantity, rowCount: g.rowCount + 1 });
  }
  const shortages: Record<string, DeliveryShortage> = {};
  for (const r of stocked) {
    const g = groups.get(key(r))!;
    const demand = round4(g.demand);
    const available = availableFrom(balancesByArticle[r.articleId] ?? [], r.locationId);
    if (demand > available) {
      shortages[r.id] = { available, demand, rowCount: g.rowCount, locationId: r.locationId };
    }
  }
  return shortages;
}

export function unfinishedManufacturingOrders<T extends { status: string }>(mos: readonly T[]): T[] {
  return mos.filter((m) => UNFINISHED_MO_STATUSES.has(m.status));
}

const fmt = (n: number) => n.toLocaleString("sv-SE", { maximumFractionDigits: 4 });

// "TO-1042", "TO-1042 och TO-1043", "TO-1, TO-2 och TO-3".
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}

// The warning under a row's Leverera nu, in the row's unit. placeName names
// the chosen place (null = Automatiskt, the usable stock). The TOs' status and
// Inlevererat stand under Benämning, so the warning only says they are not
// done; what delivering anyway means is said once, above the rows.
export function deliveryShortageText(
  shortage: DeliveryShortage,
  row: { unitCode: string; unitFactor: UnitFactor; manufacturingOrders: readonly DeliveryMo[] },
  placeName: string | null
): string {
  const u = row.unitCode;
  const available = fmt(toUnitQuantity(shortage.available, row.unitFactor));
  const demand = fmt(toUnitQuantity(shortage.demand, row.unitFactor));
  const where = placeName ? `på ${placeName}` : "i lager";
  const rows = shortage.rowCount > 1 ? ` på ${shortage.rowCount} rader` : "";
  const text = `Saldot räcker inte: ${available} ${u} ${where}, ${demand} ${u} ska levereras${rows}.`;
  const waiting = unfinishedManufacturingOrders(row.manufacturingOrders).map((m) => m.orderNumber);
  if (waiting.length === 0) return text;
  return `${text} ${listText(waiting)} är inte ${waiting.length === 1 ? "klar" : "klara"}.`;
}

// The notice above the rows, and the question at Rapportera utleverans: the
// rows the stock does not cover (the first SUMMARY_NAMED by article number)
// and how many of them wait for a TO.
const SUMMARY_NAMED = 5;

export function deliveryShortageSummary(
  short: readonly { articleNumber: string; unfinishedMo: boolean }[]
): string | null {
  if (short.length === 0) return null;
  const n = short.length;
  const waiting = short.filter((r) => r.unfinishedMo).length;
  const named = short.slice(0, SUMMARY_NAMED).map((r) => r.articleNumber);
  const more = n > SUMMARY_NAMED ? " m.fl." : "";
  const head =
    n === 1 ? `Saldot räcker inte för ${named[0]}` : `Saldot räcker inte för ${n} rader (${named.join(", ")}${more})`;
  const mo =
    waiting === 0
      ? ""
      : n === 1
        ? " — tillverkningsordern är inte klar"
        : waiting === n
          ? " — tillverkningen är inte klar för någon av dem"
          : ` — tillverkningen är inte klar för ${waiting} av dem`;
  return `${head}${mo}. Levereras ${n === 1 ? "den" : "de"} ändå går saldot minus.`;
}

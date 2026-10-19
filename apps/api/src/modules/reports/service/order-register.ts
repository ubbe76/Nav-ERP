// Orderförteckning — pure: groups the repository's flat row list into orders
// and computes the values. No DB imports.
//
// Values are in the ORDER's currency (purchase orders may be in EUR); the
// totals are converted to SEK with each order's own exchange rate.
//   sales row:    antal × à-pris × (1 − rabatt %)
//   purchase row: antal × à-pris + ställpris (once per row)
// The rest value takes the undelivered/unreceived quantity; a purchase row's
// ställpris counts as rest until anything on the row has been received.
import { toUnitPrice, toUnitQuantity } from "@navet/shared";
import type { OrderRegisterSourceRow } from "../repository/order-register.repository.js";

export interface OrderRegisterRow {
  articleNumber: string;
  articleName: string;
  unit: string | null;
  quantity: number; // in the row's unit
  done: number;
  rest: number;
  unitPrice: number; // per the row's unit
  discountPercent: number;
  setupPrice: number | null;
  amount: number;
  restAmount: number;
  deliveryDate: string | null;
}

export interface OrderRegisterOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderDate: string;
  partnerNumber: string;
  partnerName: string;
  currency: string;
  exchangeRate: number;
  // Earliest effective date among the listed rows with rest, else among all
  // listed rows — the same "next delivery" reading the order lists use.
  deliveryDate: string | null;
  orderValue: number;
  restValue: number;
  rowCount: number;
  rows?: OrderRegisterRow[];
}

export interface OrderRegisterTotals {
  orderCount: number;
  rowCount: number;
  orderValueSek: number;
  restValueSek: number;
  // True when some order is not in SEK — the screen then says the totals
  // are converted.
  converted: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function minDate(dates: (string | null)[]): string | null {
  const present = dates.filter((d): d is string => d !== null);
  return present.length > 0 ? present.reduce((a, b) => (b < a ? b : a)) : null;
}

export function buildOrderRegister(
  source: OrderRegisterSourceRow[],
  withRows: boolean
): { orders: OrderRegisterOrder[]; totals: OrderRegisterTotals } {
  const byOrder = new Map<string, { head: OrderRegisterSourceRow; rows: OrderRegisterSourceRow[] }>();
  for (const row of source) {
    const entry = byOrder.get(row.orderId);
    if (entry) entry.rows.push(row);
    else byOrder.set(row.orderId, { head: row, rows: [row] });
  }

  const orders: OrderRegisterOrder[] = [];
  let orderValueSek = 0;
  let restValueSek = 0;
  let converted = false;

  for (const { head, rows } of byOrder.values()) {
    const built = rows.map((r) => {
      const rest = Math.max(r.quantity - r.done, 0);
      const net = r.unitPrice * (1 - r.discountPercent / 100);
      const setup = r.setupPrice ?? 0;
      const amount = round2(r.quantity * net + setup);
      const restAmount = round2(rest * net + (r.done === 0 ? setup : 0));
      const row: OrderRegisterRow = {
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        unit: r.unitCode,
        quantity: toUnitQuantity(r.quantity, r.unitFactor),
        done: toUnitQuantity(r.done, r.unitFactor),
        rest: toUnitQuantity(rest, r.unitFactor),
        unitPrice: toUnitPrice(r.unitPrice, r.unitFactor),
        discountPercent: r.discountPercent,
        setupPrice: r.setupPrice,
        amount,
        restAmount,
        deliveryDate: r.deliveryDate,
      };
      return { row, hasRest: rest > 0 };
    });

    const orderValue = round2(built.reduce((sum, b) => sum + b.row.amount, 0));
    const restValue = round2(built.reduce((sum, b) => sum + b.row.restAmount, 0));
    const withRest = built.filter((b) => b.hasRest).map((b) => b.row.deliveryDate);
    orders.push({
      id: head.orderId,
      orderNumber: head.orderNumber,
      status: head.status,
      orderDate: head.orderDate,
      partnerNumber: head.partnerNumber,
      partnerName: head.partnerName,
      currency: head.currency,
      exchangeRate: head.exchangeRate,
      deliveryDate: minDate(withRest.length > 0 ? withRest : built.map((b) => b.row.deliveryDate)),
      orderValue,
      restValue,
      rowCount: built.length,
      ...(withRows ? { rows: built.map((b) => b.row) } : {}),
    });
    orderValueSek += orderValue * head.exchangeRate;
    restValueSek += restValue * head.exchangeRate;
    if (head.currency !== "SEK") converted = true;
  }

  return {
    orders,
    totals: {
      orderCount: orders.length,
      rowCount: source.length,
      orderValueSek: round2(orderValueSek),
      restValueSek: round2(restValueSek),
      converted,
    },
  };
}

import type { Db } from "@navet/db";
import {
  POST_CALCULATION_BATCH_MAX,
  type ManufacturingOrderStatus,
  type PostCalculationBatchInput,
  type PostCalculationBatchSaveInput,
  type PostCalculationBatchSelection,
} from "@navet/shared";
import {
  labelBatchOrders,
  latestPostCalculations,
  selectBatchOrders,
  type BatchOrder,
} from "../repository/post-calculation-batch.repository.js";
import { ManufacturingOrderNotFoundError, type CostingService } from "./costing.service.js";
import { isPreliminaryStatus } from "./cost-variance.js";
import { postCalculationPerUnit } from "./post-calculation-batch.js";

// Efterkalkylera flera (#34). Two steps, both over the TO card's own function:
//
//   preview — the selection's orders run through postCalculate WITHOUT save,
//             answered as one row per order: Kalkylerat/st (the
//             avvikelseanalys's base), Efterkalkyl/st, the deviation and the
//             order's latest saved efterkalkyl;
//   save    — the ticked orders run through postCalculate WITH save
//             (recomputed, exactly like the card's Spara). No price is set —
//             the user's decision; that stays on a single calculation.
//
// The orders are run ONE AT A TIME: an efterkalkyl is a dozen queries, and
// 500 of them in parallel would take the whole pool from everyone else. One
// order's failure is that row's `error` (Swedish), never the batch's.

// The selection holds more orders than one batch may run. Raised before any
// calculation; the route answers 400 with `count` and `max`.
export class PostCalculationBatchTooLargeError extends Error {
  readonly count: number;
  readonly max = POST_CALCULATION_BATCH_MAX;
  constructor(count: number) {
    super(`Urvalet har ${count} tillverkningsordrar — högst ${POST_CALCULATION_BATCH_MAX} kan efterkalkyleras åt gången`);
    this.name = "PostCalculationBatchTooLargeError";
    this.count = count;
  }
}

export interface PostCalculationBatchRow {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  status: ManufacturingOrderStatus;
  // Stockholm day of the latest LIVE receipt of finished goods; null without one.
  lastReceivedOn: string | null;
  // N (Inlevererat) — 0 on an open order with nothing received.
  outputQuantity: number;
  // Ej klar: the order is open, so the per-unit figures are null.
  preliminary: boolean;
  // Kalkylerat/st — null on a preliminary row, with N = 0 and on `error`.
  calculatedPerUnit: number | null;
  // Efterkalkyl TVK/st (Utfall/st) — null as above.
  actualPerUnit: number | null;
  // Per unit; null when either side is missing, percent null when
  // Kalkylerat/st is 0.
  variance: { amount: number; percent: number | null } | null;
  // The order's latest SAVED efterkalkyl (such a row is not pre-ticked).
  latestPostCalculation: { calculationId: string; calculatedAt: string } | null;
  warnings: string[];
  // Swedish; the row could not be calculated.
  error: string | null;
}

export interface PostCalculationBatchSelectionOrder {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  status: ManufacturingOrderStatus;
  lastReceivedOn: string | null;
  hasPostCalculation: boolean;
}

export interface PostCalculationBatchSaveResult {
  saved: { manufacturingOrderId: string; orderNumber: string; calculationId: string }[];
  // Swedish messages; orderNumber null for an order that does not exist.
  errors: { manufacturingOrderId: string; orderNumber: string | null; message: string }[];
}

// The Swedish text a failing order gets. Known domain errors by class;
// anything else is reported generically and logged — the batch never fails
// for one order, but the cause must not vanish either.
export function postBatchErrorMessage(err: unknown): { message: string; known: boolean } {
  if (err instanceof ManufacturingOrderNotFoundError) return { message: "Tillverkningsordern finns inte", known: true };
  return { message: "Efterkalkylen kunde inte beräknas", known: false };
}

export function createPostCalculationBatchService(deps: {
  db: Db;
  costing: Pick<CostingService, "postCalculate">;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}) {
  const { db, costing, log } = deps;

  function logUnknown(step: string, manufacturingOrderId: string, err: unknown) {
    log(`Efterkalkylera flera: ${step} failed for manufacturing order ${manufacturingOrderId}`, {
      manufacturingOrderId,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    });
  }

  // The run's match, capped BEFORE any calculation.
  async function selectOrders(selection: PostCalculationBatchSelection): Promise<BatchOrder[]> {
    const rows = await selectBatchOrders(db, selection);
    if (rows.length > POST_CALCULATION_BATCH_MAX) throw new PostCalculationBatchTooLargeError(rows.length);
    return rows;
  }

  return {
    // Visa urval: what Efterkalkylera would run over, without calculating.
    // Never refused for size — `count` says how far over `max` the selection
    // is (the run would answer 400), and at most `max` orders are listed, in
    // the run's order. No figures: the list is the selection.
    async listSelection(
      input: PostCalculationBatchInput
    ): Promise<{ count: number; max: number; orders: PostCalculationBatchSelectionOrder[] }> {
      const rows = await selectBatchOrders(db, input.selection);
      const listed = rows.slice(0, POST_CALCULATION_BATCH_MAX);
      const latest = await latestPostCalculations(db, listed.map((o) => o.id));
      return {
        count: rows.length,
        max: POST_CALCULATION_BATCH_MAX,
        orders: listed.map((o) => ({
          manufacturingOrderId: o.id,
          orderNumber: o.orderNumber,
          articleId: o.articleId,
          articleNumber: o.articleNumber,
          articleName: o.articleName,
          status: o.status,
          lastReceivedOn: o.lastReceivedOn,
          hasPostCalculation: latest.has(o.id),
        })),
      };
    },

    async preview(input: PostCalculationBatchInput): Promise<{ rows: PostCalculationBatchRow[] }> {
      const selected = await selectOrders(input.selection);
      const latest = await latestPostCalculations(db, selected.map((o) => o.id));

      const rows: PostCalculationBatchRow[] = [];
      for (const order of selected) {
        const saved = latest.get(order.id);
        const base = {
          manufacturingOrderId: order.id,
          orderNumber: order.orderNumber,
          articleId: order.articleId,
          articleNumber: order.articleNumber,
          articleName: order.articleName,
          status: order.status,
          lastReceivedOn: order.lastReceivedOn,
          latestPostCalculation: saved
            ? { calculationId: saved.calculationId, calculatedAt: new Date(saved.calculatedAt).toISOString() }
            : null,
        };
        try {
          const { calculation, warnings, analysis } = await costing.postCalculate(order.id, false);
          rows.push({
            ...base,
            // The efterkalkyl's own N and Ej klar — the order's received
            // quantity and status as postCalculate read them.
            outputQuantity: Number(calculation.outputQuantity ?? order.quantityReceived),
            preliminary: calculation.preliminary ?? isPreliminaryStatus(order.status),
            ...postCalculationPerUnit(calculation, analysis),
            warnings,
            error: null,
          });
        } catch (err) {
          const { message, known } = postBatchErrorMessage(err);
          if (!known) logUnknown("preview", order.id, err);
          rows.push({
            ...base,
            outputQuantity: Number(order.quantityReceived),
            preliminary: isPreliminaryStatus(order.status),
            calculatedPerUnit: null,
            actualPerUnit: null,
            variance: null,
            warnings: [],
            error: message,
          });
        }
      }
      return { rows };
    },

    async save(input: PostCalculationBatchSaveInput): Promise<PostCalculationBatchSaveResult> {
      const labels = await labelBatchOrders(db, input.manufacturingOrderIds);
      const result: PostCalculationBatchSaveResult = { saved: [], errors: [] };
      for (const manufacturingOrderId of input.manufacturingOrderIds) {
        const orderNumber = labels.get(manufacturingOrderId) ?? null;
        if (orderNumber === null) {
          result.errors.push({
            manufacturingOrderId,
            orderNumber,
            message: postBatchErrorMessage(new ManufacturingOrderNotFoundError(manufacturingOrderId)).message,
          });
          continue;
        }
        try {
          const { calculation } = await costing.postCalculate(manufacturingOrderId, true);
          result.saved.push({ manufacturingOrderId, orderNumber, calculationId: calculation.id });
        } catch (err) {
          const { message, known } = postBatchErrorMessage(err);
          if (!known) logUnknown("save", manufacturingOrderId, err);
          result.errors.push({ manufacturingOrderId, orderNumber, message });
        }
      }
      return result;
    },
  };
}

export type PostCalculationBatchService = ReturnType<typeof createPostCalculationBatchService>;

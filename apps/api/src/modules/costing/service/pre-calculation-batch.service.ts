import type { Db } from "@navet/db";
import {
  PRE_CALCULATION_BATCH_MAX,
  type ArticleType,
  type PreCalculationBatchInput,
  type PreCalculationBatchSaveInput,
} from "@navet/shared";
import { latestPreCalculations, type LatestPreCalculation } from "../repository/calculated-price.js";
import {
  labelBatchArticles,
  selectBatchArticles,
  selectBatchArticlesByIds,
  type BatchArticle,
} from "../repository/pre-calculation-batch.repository.js";
import {
  ArticleNotFoundError,
  CostCalculationNotFoundError,
  InvalidCalculationQuantityError,
  TrialSalesPriceNotAllowedError,
  type CostingService,
} from "./costing.service.js";
import { batchQuantity, manufacturingCostChange, perUnitFigures, type QuantitySource } from "./pre-calculation-batch.js";

// Förkalkylera flera (#27). Two steps, both over the card's own functions:
//
//   preview — the selection's articles run through preCalculate WITHOUT save,
//             each with its latest saved förkalkyl's quantity (else the
//             fallback), answered as one row per article with the per-unit
//             figures, the previous calculation's TVK/st and the change;
//   save    — the ticked rows run through preCalculate WITH save (recomputed,
//             exactly like the card's Spara kalkyl), then optionally
//             applyStandardCostFromCalculation / applySalesPriceFromCalculation
//             on the saved calculation. No price rule of its own.
//
// The articles are run ONE AT A TIME: a calculation is several queries and a
// multi-level one many more, and 500 of them in parallel would take the
// whole pool from everyone else. One article's failure is that row's `error`
// (Swedish), never the batch's.

// The selection holds more articles than one batch may run. Raised before
// any calculation; the route answers 400 with `count` and `max`.
export class PreCalculationBatchTooLargeError extends Error {
  readonly count: number;
  readonly max = PRE_CALCULATION_BATCH_MAX;
  constructor(count: number) {
    super(`Urvalet har ${count} artiklar — högst ${PRE_CALCULATION_BATCH_MAX} kan förkalkyleras åt gången`);
    this.name = "PreCalculationBatchTooLargeError";
    this.count = count;
  }
}

// The user's Kopierat list (#28), owned by the article module. Injected
// rather than imported — app.ts binds it to articleService.listCopiedArticles.
export interface CopiedArticlesReader {
  listCopiedArticleIds(userId: string): Promise<string[]>;
}

export interface PreCalculationBatchRow {
  articleId: string;
  articleNumber: string;
  name: string;
  type: ArticleType;
  quantity: number;
  quantitySource: QuantitySource;
  // TVK/st, SVK/st and pris/st of the new calculation — null on a row with
  // `error`.
  manufacturingCostPerUnit: number | null;
  selfCostPerUnit: number | null;
  salesPricePerUnit: number | null;
  // The article's latest saved förkalkyl (the one TB and the Kalkylpris
  // read); its TVK/st null when its quantity cannot carry one.
  previous: { calculationId: string; calculatedAt: string; quantity: number; manufacturingCostPerUnit: number | null } | null;
  // TVK/st against the previous, kronor and percent; null without a usable
  // previous TVK/st, and on a row with `error`.
  change: { amount: number; percent: number } | null;
  currentStandardCost: number | null;
  currentSalesPrice: number | null;
  warnings: string[];
  // Swedish; the row could not be calculated and cannot be saved.
  error: string | null;
}

export interface PreCalculationBatchSaveResult {
  saved: { articleId: string; articleNumber: string; calculationId: string; standardCostSet: boolean; salesPriceSet: boolean }[];
  // Swedish messages. An article whose calculation was saved but whose price
  // step failed appears in BOTH lists (the flag false here, the reason there).
  errors: { articleId: string; articleNumber: string | null; message: string }[];
}

// The Swedish text a failing article gets. Known domain errors by class;
// anything else is reported generically and logged — the batch never fails
// for one article, but the cause must not vanish either.
export function batchErrorMessage(err: unknown): { message: string; known: boolean } {
  if (err instanceof ArticleNotFoundError) return { message: "Artikeln finns inte", known: true };
  if (err instanceof CostCalculationNotFoundError) return { message: "Kalkylen finns inte längre", known: true };
  if (err instanceof InvalidCalculationQuantityError) return { message: "Kalkylens antal ger inget pris per styck", known: true };
  if (err instanceof TrialSalesPriceNotAllowedError)
    return { message: "Försäljningspris från en prövad kalkyl kräver behörigheten Artiklar", known: true };
  return { message: "Kalkylen kunde inte beräknas", known: false };
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The previous calculation's TVK/st through the same perUnitFigures as the
// new one, so the change compares like with like.
function previousOf(latest: LatestPreCalculation | undefined): PreCalculationBatchRow["previous"] {
  if (!latest) return null;
  return {
    calculationId: latest.id,
    calculatedAt: new Date(latest.calculatedAt).toISOString(),
    quantity: Number(latest.quantity),
    manufacturingCostPerUnit: perUnitFigures(latest)?.manufacturingCostPerUnit ?? null,
  };
}

// Shown on a preview row whose TVK/st is 0 — the save leaves that article's
// prices alone (see save).
export const ZERO_COST_WARNING = "TVK/st är 0 — standardpris och försäljningspris sätts inte vid Spara";

export function createPreCalculationBatchService(deps: {
  db: Db;
  costing: Pick<CostingService, "preCalculate" | "applyStandardCostFromCalculation" | "applySalesPriceFromCalculation">;
  copied: CopiedArticlesReader;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}) {
  const { db, costing, copied, log } = deps;

  function logUnknown(step: string, articleId: string, err: unknown) {
    log(`Förkalkylera flera: ${step} failed for article ${articleId}`, {
      articleId,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    });
  }

  // The selection resolved to articles, in selection order, capped BEFORE
  // any calculation. Empty is just empty.
  async function selectArticles(userId: string, selection: PreCalculationBatchInput["selection"]): Promise<BatchArticle[]> {
    const rows =
      "copied" in selection
        ? await selectBatchArticlesByIds(db, await copied.listCopiedArticleIds(userId))
        : await selectBatchArticles(db, selection);
    if (rows.length > PRE_CALCULATION_BATCH_MAX) throw new PreCalculationBatchTooLargeError(rows.length);
    return rows;
  }

  return {
    async preview(userId: string, input: PreCalculationBatchInput): Promise<{ rows: PreCalculationBatchRow[] }> {
      const selected = await selectArticles(userId, input.selection);
      // ONE batch read of the latest förkalkyl per article — the same query
      // TB and the Kalkylpris read (calculated-price.ts), so the quantity and
      // "Förra TVK/st" come from the calculation the rest of the house shows.
      const latestById = new Map((await latestPreCalculations(db, selected.map((a) => a.id))).map((c) => [c.articleId, c]));

      const rows: PreCalculationBatchRow[] = [];
      for (const article of selected) {
        const latest = latestById.get(article.id);
        const { quantity, quantitySource } = batchQuantity(latest, input.fallbackQuantity);
        const previous = previousOf(latest);
        const base = {
          articleId: article.id,
          articleNumber: article.articleNumber,
          name: article.name,
          type: article.type,
          quantity,
          quantitySource,
          previous,
          currentStandardCost: numberOrNull(article.standardCost),
          currentSalesPrice: numberOrNull(article.salesPrice),
        };
        try {
          const { calculation, warnings } = await costing.preCalculate(article.id, quantity, false, input.multiLevel, null);
          const figures = perUnitFigures(calculation);
          if (!figures) throw new InvalidCalculationQuantityError(article.id);
          rows.push({
            ...base,
            ...figures,
            change: manufacturingCostChange(figures.manufacturingCostPerUnit, previous?.manufacturingCostPerUnit),
            warnings: figures.manufacturingCostPerUnit === 0 ? [...warnings, ZERO_COST_WARNING] : warnings,
            error: null,
          });
        } catch (err) {
          const { message, known } = batchErrorMessage(err);
          if (!known) logUnknown("preview", article.id, err);
          rows.push({
            ...base,
            manufacturingCostPerUnit: null,
            selfCostPerUnit: null,
            salesPricePerUnit: null,
            change: null,
            warnings: [],
            error: message,
          });
        }
      }
      return { rows };
    },

    // No trial markups in a batch (preCalculate's fifth argument null), so
    // mayApplyTrial: false can never bite a calculation saved here — it is
    // passed anyway so the rule is stated where the price is written.
    async save(input: PreCalculationBatchSaveInput): Promise<PreCalculationBatchSaveResult> {
      const labels = await labelBatchArticles(
        db,
        input.items.map((i) => i.articleId)
      );
      const result: PreCalculationBatchSaveResult = { saved: [], errors: [] };
      for (const item of input.items) {
        const label = labels.get(item.articleId);
        if (!label) {
          result.errors.push({ articleId: item.articleId, articleNumber: null, message: batchErrorMessage(new ArticleNotFoundError(item.articleId)).message });
          continue;
        }
        if (label.isTemplate) {
          result.errors.push({ articleId: item.articleId, articleNumber: label.articleNumber, message: "Konfiguratormallar förkalkyleras inte" });
          continue;
        }

        let calculationId: string;
        let figures: ReturnType<typeof perUnitFigures>;
        try {
          const { calculation } = await costing.preCalculate(item.articleId, item.quantity, true, input.multiLevel, null);
          calculationId = calculation.id;
          figures = perUnitFigures(calculation);
        } catch (err) {
          const { message, known } = batchErrorMessage(err);
          if (!known) logUnknown("save", item.articleId, err);
          result.errors.push({ articleId: item.articleId, articleNumber: label.articleNumber, message });
          continue;
        }

        let standardCostSet = false;
        let salesPriceSet = false;
        const partial: string[] = [];
        // A price of 0 is never written from a sweep: a purchased article
        // without a structure (or one whose components lack prices) has
        // TVK/st 0, and one tick on Sätt standardpris would zero its price
        // among hundreds of rows. The card writes it on purpose; the sweep
        // reports it instead (the preview already warned, ZERO_COST_WARNING).
        if (input.setStandardCost && figures?.manufacturingCostPerUnit === 0) {
          partial.push("standardpriset sattes inte (TVK/st är 0)");
        } else if (input.setStandardCost) {
          try {
            await costing.applyStandardCostFromCalculation(calculationId);
            standardCostSet = true;
          } catch (err) {
            const { message, known } = batchErrorMessage(err);
            if (!known) logUnknown("apply-standard-cost", item.articleId, err);
            partial.push(`standardpriset sattes inte (${message})`);
          }
        }
        if (input.setSalesPrice && figures?.salesPricePerUnit === 0) {
          partial.push("försäljningspriset sattes inte (pris/st är 0)");
        } else if (input.setSalesPrice) {
          try {
            await costing.applySalesPriceFromCalculation(calculationId, { mayApplyTrial: false });
            salesPriceSet = true;
          } catch (err) {
            const { message, known } = batchErrorMessage(err);
            if (!known) logUnknown("apply-sales-price", item.articleId, err);
            partial.push(`försäljningspriset sattes inte (${message})`);
          }
        }
        result.saved.push({ articleId: item.articleId, articleNumber: label.articleNumber, calculationId, standardCostSet, salesPriceSet });
        if (partial.length > 0) {
          result.errors.push({ articleId: item.articleId, articleNumber: label.articleNumber, message: `Kalkylen sparades men ${partial.join(" och ")}` });
        }
      }
      return result;
    },
  };
}

export type PreCalculationBatchService = ReturnType<typeof createPreCalculationBatchService>;

import { renderLabelsPdf, type LabelInput } from "../../mail/service/label-pdf.js";
import { formatLocationLabelCode, type LocationLabelsInput } from "@navet/shared";
import type {
  ArticleLocationsInput,
  CreateStockLocationInput,
  CreateStockTransactionInput,
  CreateStockTransferInput,
  CreateWarehouseInput,
  ListQuery,
  ListStockTransactionsQuery,
  ListStockBatchesQuery,
  ListStockBalancesQuery,
  ListStockLocationRegisterQuery,
  ListStockLocationsQuery,
} from "@navet/shared";
import type {
  UpdateStockLocationInput,
  UpdateWarehouseInput,
} from "@navet/shared";
import type { StockRepository } from "../repository/stock.repository.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { ArticleLocationInvalidError, ArticleNotFoundError, StockLocationNotFoundError, WarehouseNotFoundError } from "./stock.errors.js";
import { articleLocationInputProblem } from "./article-locations.js";
import { StockBatchNotFoundError } from "./batch.errors.js";
import type { BatchTraceLimits } from "./batch-trace.js";

// Re-exported so route handlers keep importing their error types from the
// service they call.
export {
  ArticleLocationInvalidError,
  ArticleNotFoundError,
  DuplicateStockCountRowError,
  FallbackLocationNotBlockableError,
  InactiveStockLocationError,
  InsufficientStockError,
  LocationUnderStockCountError,
  StockCountAlreadyOpenError,
  StockCountBackdateRefusedError,
  StockCountNotFoundError,
  StockCountNotOpenError,
  StockCountRowNotFoundError,
  StockLocationAlreadyBlockedError,
  ServiceArticleNotStockedError,
  StockLocationBlockedError,
  StockLocationNameReservedError,
  StockLocationNotBlockedError,
  StockLocationNotEmptyError,
  StockLocationNotFoundError,
  WarehouseNotFoundError,
} from "./stock.errors.js";

// audit: Spärra/Släpp spärr are logged (entityType stock_location, the
// place's id). Tests that never block may leave it out.
export function createStockService(repo: StockRepository, audit: AuditWriter = { log: async () => {} }) {
  // After commit, like the stock count's postSession — the audit row never
  // holds the place's lock.
  async function logBlock(
    action: "blocked" | "unblocked",
    result: {
      location: { id: string; name: string; warehouseName: string | null; blockedNote: string | null };
      articlesWithStock: number;
      defaultForArticles: number;
    },
    userId: string | null,
    note: string | null = result.location.blockedNote
  ) {
    await audit.log({
      entityType: "stock_location",
      entityId: result.location.id,
      action,
      detail: {
        name: result.location.name,
        warehouseName: result.location.warehouseName,
        note,
        articlesWithStock: result.articlesWithStock,
        defaultForArticles: result.defaultForArticles,
      },
      userId,
    });
  }

  return {
    async createWarehouse(input: CreateWarehouseInput) {
      return repo.createWarehouse(input);
    },

    // A place created blocked (a Karantän) logs "blocked" like Spärra.
    async createLocation(input: CreateStockLocationInput, userId: string | null = null) {
      const row = await repo.createLocation(input);
      if (row.blocked) {
        const location = (await repo.findLocationView(row.id))!;
        await logBlock("blocked", { location, articlesWithStock: 0, defaultForArticles: 0 }, userId);
      }
      return row;
    },

    // Spärra lagerplats / Släpp spärr — the transitions and the lock live in
    // the repository (one conditional UPDATE each).
    async blockLocation(id: string, note: string | null, userId: string | null = null) {
      const result = await repo.blockLocation(id, note);
      await logBlock("blocked", result, userId);
      return result;
    },

    async unblockLocation(id: string, userId: string | null = null) {
      const result = await repo.unblockLocation(id);
      // The note is gone with the spärr; the log keeps what it said.
      await logBlock("unblocked", result, userId, result.previousNote);
      return { location: result.location };
    },

    async listWarehouses() {
      return repo.listWarehouses();
    },

    async updateWarehouse(id: string, input: UpdateWarehouseInput) {
      const row = await repo.updateWarehouse(id, input);
      if (!row) throw new WarehouseNotFoundError(id);
      return row;
    },

    async updateLocation(id: string, input: UpdateStockLocationInput) {
      const row = await repo.updateLocation(id, input);
      if (!row) throw new StockLocationNotFoundError(id);
      return row;
    },

    // Etiketter (#4): lagerplats labels as a PDF, each `copies` times.
    // Unknown ids are left out; none known is a 404.
    async renderLocationLabels(input: LocationLabelsInput) {
      const found = await repo.labelLocations([...new Set(input.locationIds)]);
      if (found.length === 0) throw new StockLocationNotFoundError(input.locationIds[0]!);
      const labels: LabelInput[] = found.flatMap((l) =>
        Array.from({ length: input.copies }, () => ({
          kind: "location" as const,
          labelCode: formatLocationLabelCode(l.labelNumber),
          name: l.name,
          warehouseName: l.warehouseName,
        }))
      );
      return renderLabelsPdf(labels, input.format, input.start);
    },

    async listLocations(query?: ListStockLocationsQuery) {
      return repo.listLocations(query);
    },

    // Lagerplatsregistret — sök, filter och sidor, with each place's
    // article count and balance per unit.
    async listLocationRegister(query: ListStockLocationRegisterQuery) {
      return repo.listLocationRegister(query);
    },

    async recordTransaction(input: CreateStockTransactionInput, userId?: string) {
      return repo.createTransaction(input, userId);
    },

    // Lagerflytt — guards and both transaction legs live in the repository
    // transaction; see stock.repository.transferStock.
    async transferStock(input: CreateStockTransferInput, createdBy: string) {
      return repo.transferStock(input, createdBy);
    },

    async getStockSummary() {
      return { articlesInStock: await repo.countArticlesInStock() };
    },

    async getBalances(query: ListStockBalancesQuery) {
      return repo.getBalances(query);
    },

    // Narrow reader for cross-module use (sales pick list).
    async balancesForArticles(articleIds: string[]) {
      return repo.balancesForArticles(articleIds);
    },

    async listTransactions(query: ListStockTransactionsQuery) {
      return repo.listTransactions(query);
    },

    // Batch (#8): the pick list's cells (plocklistan per batch).
    // Also GET /stock/batch-balances — the batch choices of Utleverans,
    // Förbruka, flytt and justering.
    async pickBatchCellsForArticles(articleIds: string[], opts: { locationId?: string } = {}) {
      return repo.pickBatchCellsForArticles(articleIds, opts);
    },

    // Spårbarhet (#8): GET /stock/batches and …/:id/trace. Readable whatever
    // the setting says — reading harms nothing, and the batches of an article
    // that is no longer batchstyrd are still in the log.
    async listBatches(query: ListStockBatchesQuery) {
      return repo.listBatches(query);
    },

    async traceBatch(batchId: string, limits?: BatchTraceLimits) {
      const trace = await repo.traceBatch(batchId, limits);
      if (!trace) throw new StockBatchNotFoundError(batchId);
      return trace;
    },

    // Batch (#8): the article card's Saldo per batch.
    async getArticleBatchBalances(articleId: string) {
      const view = await repo.articleBatchBalances(articleId);
      if (!view) throw new ArticleNotFoundError(articleId);
      return view;
    },

    // Flera lagerplatser per artikel (0186) — GET/PUT /articles/:id/locations.
    async getArticleLocations(articleId: string) {
      const view = await repo.articleLocations(articleId);
      if (!view) throw new ArticleNotFoundError(articleId);
      return view;
    },

    // Replaces the huvudplats and the alternative places as one set. The
    // request's own rules first; the places are judged under the locks in
    // the repository (article-locations.ts). No audit: article changes are
    // not logged.
    async setArticleLocations(articleId: string, input: ArticleLocationsInput) {
      const problem = articleLocationInputProblem(input);
      if (problem) throw new ArticleLocationInvalidError(problem);
      return repo.replaceArticleLocations(articleId, input);
    },
  };
}

export type StockService = ReturnType<typeof createStockService>;

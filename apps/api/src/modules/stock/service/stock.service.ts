import type {
  CreateStockLocationInput,
  CreateStockTransactionInput,
  CreateStockTransferInput,
  CreateWarehouseInput,
  ListQuery,
  ListStockTransactionsQuery,
  ListStockBalancesQuery,
  ListStockLocationsQuery,
} from "@navet/shared";
import type {
  UpdateStockLocationInput,
  UpdateWarehouseInput,
} from "@navet/shared";
import type { StockRepository } from "../repository/stock.repository.js";
import { StockLocationNotFoundError, WarehouseNotFoundError } from "./stock.errors.js";

// Re-exported so route handlers keep importing their error types from the
// service they call.
export {
  ArticleNotFoundError,
  DuplicateStockCountRowError,
  InactiveStockLocationError,
  InsufficientStockError,
  LocationUnderStockCountError,
  StockCountAlreadyOpenError,
  StockCountNotFoundError,
  StockCountNotOpenError,
  StockCountRowNotFoundError,
  StockLocationNotEmptyError,
  StockLocationNotFoundError,
  WarehouseNotFoundError,
} from "./stock.errors.js";

export function createStockService(repo: StockRepository) {
  return {
    async createWarehouse(input: CreateWarehouseInput) {
      return repo.createWarehouse(input);
    },

    async createLocation(input: CreateStockLocationInput) {
      return repo.createLocation(input);
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

    async listLocations(query?: ListStockLocationsQuery) {
      return repo.listLocations(query);
    },

    async recordTransaction(input: CreateStockTransactionInput, userId?: string) {
      return repo.createTransaction(input, userId);
    },

    // Lagerflytt — guards and both transaction legs live in the repository
    // transaction; see stock.repository.transferStock.
    async transferStock(input: CreateStockTransferInput, createdBy: string) {
      return repo.transferStock(input, createdBy);
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
  };
}

export type StockService = ReturnType<typeof createStockService>;

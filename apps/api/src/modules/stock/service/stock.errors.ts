// Domain errors live in their own module so the repository can throw them
// without importing the service (which imports the repository's types).

export class WarehouseNotFoundError extends Error {
  constructor(id: string) {
    super(`Warehouse ${id} not found`);
    this.name = "WarehouseNotFoundError";
  }
}

export class StockLocationNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock location ${id} not found`);
    this.name = "StockLocationNotFoundError";
  }
}

// Module-local copy, same as costing's — the stock module does not depend on
// the article module.
export class ArticleNotFoundError extends Error {
  constructor(id: string) {
    super(`Article ${id} not found`);
    this.name = "ArticleNotFoundError";
  }
}

// Emptied locations are deactivated, so stock must never be moved into one.
export class InactiveStockLocationError extends Error {
  constructor(name: string) {
    super(`Lagerplatsen ${name} är inaktiv och kan inte ta emot saldo`);
    this.name = "InactiveStockLocationError";
  }
}

// A location holding a balance must stay active, otherwise the stock would be
// invisible in every picker. Emptying it deactivates it automatically.
export class StockLocationNotEmptyError extends Error {
  constructor(name: string) {
    super(
      `Lagerplatsen ${name} har saldo kvar och kan inte inaktiveras — flytta eller nolla saldot först`
    );
    this.name = "StockLocationNotEmptyError";
  }
}

// Negative balances are allowed in general (a delivery may outrun a receipt),
// but a transfer can only move goods that are physically on the source location.
export class InsufficientStockError extends Error {
  constructor(
    readonly articleNumber: string,
    readonly available: string,
    readonly requested: number
  ) {
    super(
      `Otillräckligt saldo för ${articleNumber}: ${available} tillgängligt, ${requested} begärt`
    );
    this.name = "InsufficientStockError";
  }
}

// --- Inventering (D2) ---

// A blocking stock-count session freezes its whole location: no stock may
// move on it until the count is posted or cancelled.
export class LocationUnderStockCountError extends Error {
  constructor(locationName: string, countNumber: string) {
    super(
      `Lagerplatsen ${locationName} är under inventering (${countNumber}) — registrera eller avbryt inventeringen först`
    );
    this.name = "LocationUnderStockCountError";
  }
}

export class StockCountNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock count session ${id} not found`);
    this.name = "StockCountNotFoundError";
  }
}

// Row edits, add/delete and post/cancel are only allowed while the session
// is open — the state machine lives in the repository transaction.
export class StockCountNotOpenError extends Error {
  constructor(countNumber: string, status: string) {
    super(`Inventeringen ${countNumber} är ${status === "posted" ? "registrerad" : "avbruten"} och kan inte ändras`);
    this.name = "StockCountNotOpenError";
  }
}

export class StockCountAlreadyOpenError extends Error {
  constructor(locationName: string) {
    super(`Lagerplatsen ${locationName} har redan en pågående inventering`);
    this.name = "StockCountAlreadyOpenError";
  }
}

export class StockCountRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock count row ${id} not found`);
    this.name = "StockCountRowNotFoundError";
  }
}

export class DuplicateStockCountRowError extends Error {
  constructor(articleNumber: string) {
    super(`Artikeln ${articleNumber} finns redan i inventeringen`);
    this.name = "DuplicateStockCountRowError";
  }
}

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

// #26: Registrera per underlagets datum asked for explicitly, but the count
// may not be backdated (a closed year, a locked period, or movements on its
// articles after the freeze). The reason is the server's own Swedish text.
export class StockCountBackdateRefusedError extends Error {
  constructor(countNumber: string, countDate: string, reasonText: string) {
    super(`Inventeringen ${countNumber} kan inte bokföras per ${countDate}: ${reasonText} Registrera den per i dag i stället.`);
    this.name = "StockCountBackdateRefusedError";
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

// --- Spärrade lagerplatser (migration 0185) ---

export class StockLocationAlreadyBlockedError extends Error {
  constructor(name: string) {
    super(`Lagerplatsen ${name} är redan spärrad`);
    this.name = "StockLocationAlreadyBlockedError";
  }
}

// Släpp spärr on an open place, or a note edited on one (PATCH blockedNote).
export class StockLocationNotBlockedError extends Error {
  constructor(name: string) {
    super(`Lagerplatsen ${name} är inte spärrad`);
    this.name = "StockLocationNotBlockedError";
  }
}

// The remainder of an Automatiskt draw lands on "***" (withRemainder), so a
// blocked "***" would put minus on a place the usable balance leaves out.
// Also a blocked place renamed to "***" (stock_locations_fallback_not_blocked).
export class FallbackLocationNotBlockableError extends Error {
  constructor() {
    super("Reservplatsen *** kan inte spärras — resten av ett uttag med Automatiskt hamnar där");
    this.name = "FallbackLocationNotBlockableError";
  }
}

// An outflow from a blocked place chosen by hand (utleverans, the order
// card's Leverera, Förbruka) — the goods are in quarantine; Automatiskt
// skips the place instead. `label` is "Huvudlager — K1". Swedish: the web
// shows the message as is.
export class StockLocationBlockedError extends Error {
  constructor(readonly label: string) {
    super(`Lagerplatsen ${label} är spärrad — uttag görs inte därifrån. Välj en annan lagerplats eller Automatiskt.`);
    this.name = "StockLocationBlockedError";
  }
}

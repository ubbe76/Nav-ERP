// Batch (#8) — the domain errors every batch-aware stock writer can throw
// (inleverans, TO-rapport, justering, saldoimport, the article card). A leaf
// without DB imports: the pure allocation rule throws BatchInsufficientError.
// app.ts maps them ONCE for every route (batchErrorStatus), like
// StockLocationNotFoundError — the writers live in four modules.

// A CHOSEN named batch never goes negative (beslut 11): only Okänd can, as
// the remainder of an Automatiskt draw.
export class BatchInsufficientError extends Error {
  constructor(
    readonly batchNumber: string,
    readonly available: number,
    readonly requested: number
  ) {
    super(`Batch ${batchNumber} räcker inte: ${available} tillgängligt, ${requested} begärt`);
    this.name = "BatchInsufficientError";
  }
}

// A chosen batch id that does not exist or belongs to another article.
export class StockBatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock batch ${id} not found`);
    this.name = "StockBatchNotFoundError";
  }
}

// A batch sent for an article that is not batchstyrd — refused rather than
// silently dropped, so an integration notices.
export class BatchNotTrackedError extends Error {
  constructor(articleNumber: string) {
    super(`Artikeln ${articleNumber} är inte batchstyrd`);
    this.name = "BatchNotTrackedError";
  }
}

// "Okänd" is what a row without a batch is called.
export class BatchNumberReservedError extends Error {
  constructor(batchNumber: string) {
    super(`Batchnumret ${batchNumber} är reserverat — välj ett annat`);
    this.name = "BatchNumberReservedError";
  }
}

// Batchstyrd asked for while the system setting "Använd batch- och
// serienummer" is off.
export class BatchTrackingDisabledError extends Error {
  constructor() {
    super("Batch- och serienummer används inte — slå på inställningen under System först");
    this.name = "BatchTrackingDisabledError";
  }
}

// The setting can only be switched off while no article is batchstyrd.
export class BatchTrackingInUseError extends Error {
  constructor(readonly articleCount: number) {
    super(`${articleCount} artiklar är batchstyrda — stäng av Batchstyrd på dem innan inställningen stängs av`);
    this.name = "BatchTrackingInUseError";
  }
}

// A Tjänst is never stocked and a phantom never stands in stock.
export class ArticleNotBatchTrackableError extends Error {
  constructor() {
    super("Tjänster och fantomartiklar kan inte vara batchstyrda");
    this.name = "ArticleNotBatchTrackableError";
  }
}

// --- Serienummer (etapp 2, migration 0215) ---

// The number exists on the article as the OTHER sort: one number is either a
// batch or a serial number (the unique index covers both).
export class BatchKindMismatchError extends Error {
  constructor(
    readonly batchNumber: string,
    readonly existingKind: "batch" | "serial"
  ) {
    super(
      existingKind === "batch"
        ? `${batchNumber} finns redan som batch på artikeln och kan inte användas som serienummer`
        : `${batchNumber} finns redan som serienummer på artikeln och kan inte användas som batch`
    );
    this.name = "BatchKindMismatchError";
  }
}

// A serienummerstyrd article moves in whole styck.
export class SerialQuantityNotIntegerError extends Error {
  constructor(
    readonly articleNumber: string,
    readonly quantity: number
  ) {
    super(`Artikeln ${articleNumber} är serienummerstyrd — antalet måste vara ett helt antal styck i grundenheten (${quantity})`);
    this.name = "SerialQuantityNotIntegerError";
  }
}

// An inflow of a serienummerstyrd article (numbers created vid inleverans)
// without its numbers (beslut 5).
export class SerialNumbersRequiredError extends Error {
  constructor(readonly articleNumber: string) {
    super(`Artikeln ${articleNumber} är serienummerstyrd — ange ett serienummer per styck`);
    this.name = "SerialNumbersRequiredError";
  }
}

// Serial numbers sent for an article that takes none (not serienummerstyrd,
// or its numbers are created vid utleverans) — refused, never dropped.
export class ArticleNotSerialTrackedError extends Error {
  constructor(readonly articleNumber: string) {
    super(`Artikeln ${articleNumber} tar inga serienummer vid inleverans`);
    this.name = "ArticleNotSerialTrackedError";
  }
}

// The numbers are not as many as the styck, or one number is given twice.
export class SerialCountMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly given: number,
    readonly duplicate: string | null = null
  ) {
    super(
      duplicate !== null
        ? `Serienummer ${duplicate} förekommer flera gånger`
        : `Antalet serienummer (${given}) stämmer inte med antalet styck (${expected})`
    );
    this.name = "SerialCountMismatchError";
  }
}

// More numbers in one movement than the system takes at a time.
export class SerialNumbersTooManyError extends Error {
  constructor(
    readonly count: number,
    readonly max: number
  ) {
    super(`Högst ${max} serienummer kan bokas åt gången (${count}) — dela upp rörelsen`);
    this.name = "SerialNumbersTooManyError";
  }
}

// An inflow of a number that already stands in stock.
export class SerialAlreadyInStockError extends Error {
  constructor(
    readonly serialNumber: string,
    readonly locationName: string | null
  ) {
    super(`Serienummer ${serialNumber} finns redan i lager${locationName ? ` (${locationName})` : ""}`);
    this.name = "SerialAlreadyInStockError";
  }
}

// A series whose next number no longer fits the column (varchar 50).
export class SerialNumberTooLongError extends Error {
  constructor(
    readonly seriesKey: string,
    readonly number: string,
    readonly width: number
  ) {
    super(`Serienummerserien ger ${number}, som är längre än ${width} tecken — ändra serien under System → Nummerserier`);
    this.name = "SerialNumberTooLongError";
  }
}

// The article's Serienummerserie is not a serial number series.
export class SerialSeriesInvalidError extends Error {
  constructor(readonly seriesKey: string) {
    super(`Nummerserien ${seriesKey} är ingen serienummerserie`);
    this.name = "SerialSeriesInvalidError";
  }
}

// The database guard (trigger stock_transactions_serial_unit, SQLSTATE
// NV002): a serial number's balance would be something else than 0 or 1.
// Never reached when the writers follow the rule — the application answers
// first with one of the errors above.
export const SERIAL_BALANCE_VIOLATED = {
  code: "serial-balance-violated",
  message: "Ett serienummer kan bara finnas i ett exemplar i lager — rörelsen bokades inte",
} as const;
export function isSerialBalanceViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  return code === "NV002" || (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "NV002");
}

// An inflow names an existing batch with ANOTHER utgångsdatum than the batch
// has — never silently overwritten; corrected with PATCH /stock/batches/:id.
export class BatchExpiryMismatchError extends Error {
  constructor(
    readonly batchNumber: string,
    readonly expiresOn: string,
    readonly requested: string
  ) {
    super(`Batch ${batchNumber} har redan utgångsdatum ${expiresOn} — ${requested} skiljer sig. Rätta batchens datum under Lager → Spårbarhet eller ange samma datum`);
    this.name = "BatchExpiryMismatchError";
  }
}

// PATCH /stock/batches/:id: the new number is another batch of the article.
export class DuplicateBatchNumberError extends Error {
  constructor(readonly batchNumber: string) {
    super(`Batchnumret ${batchNumber} finns redan på artikeln`);
    this.name = "DuplicateBatchNumberError";
  }
}

// The HTTP status of a batch error, null for anything else.
export function batchErrorStatus(err: unknown): 400 | 404 | 409 | null {
  if (err instanceof StockBatchNotFoundError) return 404;
  if (err instanceof BatchInsufficientError || err instanceof BatchTrackingDisabledError || err instanceof BatchTrackingInUseError) return 409;
  if (err instanceof BatchExpiryMismatchError || err instanceof DuplicateBatchNumberError) return 409;
  if (err instanceof BatchKindMismatchError || err instanceof SerialAlreadyInStockError || err instanceof SerialNumberTooLongError) return 409;
  if (
    err instanceof SerialQuantityNotIntegerError ||
    err instanceof SerialNumbersRequiredError ||
    err instanceof ArticleNotSerialTrackedError ||
    err instanceof SerialCountMismatchError ||
    err instanceof SerialNumbersTooManyError ||
    err instanceof SerialSeriesInvalidError
  ) {
    return 400;
  }
  if (err instanceof BatchNotTrackedError || err instanceof BatchNumberReservedError || err instanceof ArticleNotBatchTrackableError) return 400;
  return null;
}

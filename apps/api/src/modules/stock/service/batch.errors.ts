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

// Etapp 2: Spårning = Serienummer (and Serienummer skapas = Vid utleverans)
// exists in the data from 0214 but cannot be chosen until the serienummer
// step is built.
export class SerialTrackingNotAvailableError extends Error {
  constructor() {
    super("Serienummer går inte att välja ännu — välj Ingen eller Batch");
    this.name = "SerialTrackingNotAvailableError";
  }
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
  if (err instanceof SerialTrackingNotAvailableError) return 400;
  if (err instanceof BatchNotTrackedError || err instanceof BatchNumberReservedError || err instanceof ArticleNotBatchTrackableError) return 400;
  return null;
}

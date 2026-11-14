// Anläggningsregistrets fel (codes derived by errorBody; HTTP mapping in
// fixed-asset.routes.ts). Split out of fixed-asset.service.ts, which
// re-exports them so every importer stays as it was.

export class FixedAssetCategoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset category ${id} not found`);
    this.name = "FixedAssetCategoryNotFoundError";
  }
}

export class DuplicateFixedAssetCategoryNameError extends Error {
  constructor(name: string) {
    super(`A fixed asset category named "${name}" already exists`);
    this.name = "DuplicateFixedAssetCategoryNameError";
  }
}

export class FixedAssetCategoryInUseError extends Error {
  constructor(id: string) {
    super(`Fixed asset category ${id} still has assets`);
    this.name = "FixedAssetCategoryInUseError";
  }
}

export class FixedAssetCategoryAccountsNotDistinctError extends Error {
  constructor() {
    super("The asset, accumulated depreciation and expense accounts must be three different accounts");
    this.name = "FixedAssetCategoryAccountsNotDistinctError";
  }
}

export type CategoryAccountRole = "asset" | "accumulated" | "expense" | "gain" | "loss";

// An account that is the asset or ack account of a group (this one or
// another) used in a different role — the per-account reconciliation would
// net the two groups' bookings (assertAccountRolesAcrossCategories).
export class FixedAssetCategoryAccountRoleConflictError extends Error {
  constructor(
    readonly accountNumber: string,
    readonly role: CategoryAccountRole,
    readonly categoryName: string,
    readonly otherRole: CategoryAccountRole
  ) {
    super(`Account ${accountNumber} is the ${otherRole} account of group ${categoryName} and cannot be the ${role} account here`);
    this.name = "FixedAssetCategoryAccountRoleConflictError";
  }
}

// The asset, accumulated-depreciation and expense accounts are what the
// group's depreciation (and its opening amounts) sit on in the ledger;
// pointing the group elsewhere after the fact would make the register's
// reconciliation read the wrong accounts. Gain/loss accounts, name and
// useful life stay editable.
export class FixedAssetCategoryAccountsLockedError extends Error {
  constructor(public field: string) {
    super(`${field} cannot be changed once the group has booked depreciation or opening depreciation`);
    this.name = "FixedAssetCategoryAccountsLockedError";
  }
}

export class FixedAssetBasAccountMissingError extends Error {
  constructor(public accountNumber: string) {
    super(`BAS account ${accountNumber} is missing or inactive — run Förifyll BAS-urval in the chart of accounts first`);
    this.name = "FixedAssetBasAccountMissingError";
  }
}

export class FixedAssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset ${id} not found`);
    this.name = "FixedAssetNotFoundError";
  }
}

export class SupplierInvoiceNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier invoice ${id} not found`);
    this.name = "SupplierInvoiceNotFoundError";
  }
}

// acquisitionDate/acquisitionCost/depreciationStartMonth/categoryId define
// what has already been booked — changing them would make booked rows and
// verifications wrong after the fact.
export class FixedAssetFieldLockedError extends Error {
  constructor(public field: string) {
    super(`${field} cannot be changed once a depreciation has been booked`);
    this.name = "FixedAssetFieldLockedError";
  }
}

export class FixedAssetNotActiveError extends Error {
  constructor(assetNumber: string) {
    super(`Fixed asset ${assetNumber} is disposed`);
    this.name = "FixedAssetNotActiveError";
  }
}

export class FixedAssetHasDepreciationError extends Error {
  constructor(assetNumber: string) {
    super(`Fixed asset ${assetNumber} has booked depreciations and cannot be deleted`);
    this.name = "FixedAssetHasDepreciationError";
  }
}

// Prospective useful-life/start edits must leave at least one month after the
// last booked one while a base remains — otherwise missingMonths() would
// return [] forever and the asset could never finish depreciating.
export class FixedAssetLifeTooShortError extends Error {
  constructor(public lastBookedMonth: string) {
    super(`The plan would end on or before ${lastBookedMonth}, the last booked month, while depreciable value remains`);
    this.name = "FixedAssetLifeTooShortError";
  }
}

export class InvalidFixedAssetValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFixedAssetValuesError";
  }
}

// Ingående avskrivning that contradicts the plan (see assertOpeningDepreciation).
export class InvalidOpeningDepreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpeningDepreciationError";
  }
}

// Avskrivningar förbokas inte: the month must have ended (Stockholm time).
export class DepreciationMonthInFutureError extends Error {
  constructor(month: string) {
    super(`Depreciation cannot be booked for ${month}: the month has not ended`);
    this.name = "DepreciationMonthInFutureError";
  }
}

export class NothingToDepreciateError extends Error {
  constructor(month: string) {
    super(`No depreciation is missing through ${month}`);
    this.name = "NothingToDepreciateError";
  }
}

export class DepreciationRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} not found`);
    this.name = "DepreciationRunNotFoundError";
  }
}

export class DepreciationRunNotLatestError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} is not the latest — undo later runs first`);
    this.name = "DepreciationRunNotLatestError";
  }
}

export class DisposalRunNotUndoableError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} belongs to a disposal and cannot be undone`);
    this.name = "DisposalRunNotUndoableError";
  }
}

// An ordinary run whose rows belong to a since-disposed asset: the disposal
// verification took that asset's accumulated depreciation off the books, so
// superseding the rows would leave the ack-konto debit uncleared and the
// card, the plan and the ledger disagreeing forever. A disposal with
// nothing to catch up leaves no run row of its own, so the latest-run and
// disposal-run checks cannot see this case.
export class RunPrecedesDisposalError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} has rows for a disposed asset and cannot be undone`);
    this.name = "RunPrecedesDisposalError";
  }
}

export class InvalidDisposalDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDisposalDateError";
  }
}

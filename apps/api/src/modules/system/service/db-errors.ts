// Postgres unique-constraint (23505) detection, shared by every service that
// catches a DB write to map a constraint violation onto a domain-specific
// duplicate error. Drizzle wraps the postgres-js error, so the 23505 code
// sits on the error itself OR on its `cause` depending on the driver path —
// hence the two-level check. Guarded (null/non-object check before touching
// `code`/`cause`) so a thrown non-Error value never crashes the catch block.
//
// Lives in system/service: this module is the repo's established home for
// cross-module leaf helpers with no dependency on any repository or service
// (see number-series.ts's getNextOrderNumber, posting-settings.ts's
// readPostingSettings, ocr.ts's computeOcrNumber/validateOcrNumber) — there
// is no src/lib, so leaves that many modules need live here instead.
//
// Optional constraintName (bankfiler): only that index counts — same
// `constraint_name` lookup as isForeignKeyViolation below.
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  const causeObj = typeof cause === "object" && cause !== null ? (cause as { code?: string; constraint_name?: string }) : undefined;
  if (code !== "23505" && causeObj?.code !== "23505") return false;
  if (constraintName === undefined) return true;
  const directConstraint = (err as { constraint_name?: string }).constraint_name;
  return directConstraint === constraintName || causeObj?.constraint_name === constraintName;
}

// Postgres foreign-key-violation (23503) detection — same two-level
// code/cause check as isUniqueViolation above, for services that catch a
// blocked DELETE (an onDelete: "restrict" FK) to map it onto a
// domain-specific "still referenced" error (e.g. E3's
// RowHasManufacturingOrdersError on a sales order row).
//
// Optional constraintName: a single DELETE can be guarded by more than one
// restrict FK from different tables (e.g. sales_order_rows is referenced by
// manufacturing_orders, delivery_rows AND invoice_rows) — without checking
// which constraint actually fired, a catch that only expects one of them
// would silently mislabel a violation from a different table as the wrong
// domain error. postgres.js exposes the constraint name Postgres reports
// (`constraint_name`) on the same object/cause pair as `code`.
export function isForeignKeyViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  const causeObj =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: string; constraint_name?: string })
      : undefined;
  const isFk = code === "23503" || causeObj?.code === "23503";
  if (!isFk) return false;
  if (constraintName === undefined) return true;
  const directConstraint = (err as { constraint_name?: string }).constraint_name;
  return directConstraint === constraintName || causeObj?.constraint_name === constraintName;
}

// Postgres check-constraint violation (23514) — same two-level code/cause
// check and optional constraint name as above, for a service whose pre-check
// ran on a read that a concurrent write made stale (the CHECK is the
// guarantee; the catch only turns the 500 into the domain error the pre-check
// would have given).
export function isCheckViolation(err: unknown, constraintName?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  const causeObj =
    typeof cause === "object" && cause !== null ? (cause as { code?: string; constraint_name?: string }) : undefined;
  if (code !== "23514" && causeObj?.code !== "23514") return false;
  if (constraintName === undefined) return true;
  const directConstraint = (err as { constraint_name?: string }).constraint_name;
  return directConstraint === constraintName || causeObj?.constraint_name === constraintName;
}

// The bookkeeping lock triggers (migration 0095) refuse any change to booked
// räkenskapsinformation with SQLSTATE NV001 — same two-level code/cause
// check as above. The application never attempts such a write, so this only
// fires on a bug; the global error handler maps it to 409 rather than 500.
export function isBookkeepingLockViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  return (
    code === "NV001" ||
    (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "NV001")
  );
}

// Årsbokslut (migration 0105): the two closed-year triggers raise the same
// NV001 but mean "reopen the year", not "booked records are immutable" —
// told apart on their message, which both start with the closed year.
export function isClosedFiscalYearViolation(err: unknown): boolean {
  if (!isBookkeepingLockViolation(err)) return false;
  const { message, cause } = err as { message?: unknown; cause?: unknown };
  const causeMessage = typeof cause === "object" && cause !== null ? (cause as { message?: unknown }).message : undefined;
  return [message, causeMessage].some((text) => typeof text === "string" && /Räkenskapsåret är stängt|stängt räkenskapsår/.test(text));
}

// GDPR (#2, migration 0170): the guard triggers refuse any change to an
// anonymized employee and any new time, absence, ATF or schedule row for one
// with SQLSTATE NV002. The services check first where a user can get there;
// the global error handler maps a write that slipped past to 409.
export function isEmployeeAnonymizedViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  return (
    code === "NV002" ||
    (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "NV002")
  );
}

// Postgres serialization failure (40001) — a repeatable-read transaction
// locking or changing a row another transaction changed or deleted after
// its snapshot. Same two-level code/cause check as above.
export function isSerializationFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: string; cause?: unknown };
  return code === "40001" || (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "40001");
}

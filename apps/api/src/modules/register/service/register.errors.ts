// Domain errors of the base-data registers (grunddata). Kept in their own
// leaf module so the repository can throw RegisterEntryInUseError from the
// delete transaction's FK-violation catch without importing the service
// (which imports the repository — a runtime cycle otherwise).

export class RegisterEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Register entry ${id} not found`);
    this.name = "RegisterEntryNotFoundError";
  }
}

export class DuplicateRegisterEntryError extends Error {
  constructor(field: "code" | "name", value: string) {
    super(field === "code" ? `An entry with code ${value} already exists` : `An entry named ${value} already exists`);
    this.name = "DuplicateRegisterEntryError";
  }
}

// What still points at a register entry — one line per referencing column,
// only those with count > 0. `label`/`labelOne` are the Swedish plural and
// singular the UI prints ("3 kunder" / "1 kund"); `table` is the SQL table
// name for programmatic use.
// `blocksReplacement` (the dimension registers) marks a reference the
// delete cannot move — booked verification rows, locked documents — so the
// web offers deactivation instead of a replacement.
export type RegisterUsage = {
  total: number;
  references: { table: string; label: string; labelOne: string; count: number; blocksReplacement?: boolean }[];
};

// Deleting a referenced entry without naming a replacement — or the race
// where a row got linked between the reassignment and the DELETE (the FK
// restrict is the real guard; this is the friendly 409 in front of it).
export class RegisterEntryInUseError extends Error {
  constructor(
    code: string,
    public readonly usage: RegisterUsage
  ) {
    super(`Register entry ${code} is still referenced by ${usage.total} row(s) — pass a replacement to move them`);
    this.name = "RegisterEntryInUseError";
  }
}

// The replacement must be another entry of the SAME register: not the entry
// itself, and not an id from a different register (or none at all).
// A register may add its own rules (Avvikelseorsaker: active, and applying to
// what moves — `inactive`/`not-applicable` carry a Swedish message).
export class InvalidReplacementError extends Error {
  constructor(
    readonly reason: "same" | "unknown" | "inactive" | "not-applicable",
    message?: string
  ) {
    super(
      message ??
        (reason === "same"
          ? "The replacement cannot be the entry being deleted"
          : "The replacement must be an existing entry of the same register")
    );
    this.name = "InvalidReplacementError";
  }
}

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
export type RegisterUsage = {
  total: number;
  references: { table: string; label: string; labelOne: string; count: number }[];
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
export class InvalidReplacementError extends Error {
  constructor(reason: "same" | "unknown") {
    super(
      reason === "same"
        ? "The replacement cannot be the entry being deleted"
        : "The replacement must be an existing entry of the same register"
    );
    this.name = "InvalidReplacementError";
  }
}

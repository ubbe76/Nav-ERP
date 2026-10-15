import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAccountSchema, updateAccountSchema, type ListAccountsQuery } from "@navet/shared";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import {
  createEconomyService,
  AccountNotFoundError,
  DuplicateAccountNumberError,
} from "../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";

// audit is unused by every account CRUD method in this task (Task 4's fiscal
// years/verifications are the first real writer) — a no-op stub is enough,
// same as payroll-registers.test.ts wiring its unused collaborators.
const service = createEconomyService(createEconomyRepository(db), { log: async () => {} });

// listAccountsQuerySchema's includeInactive is required (not optional) on the
// inferred type — it always resolves to a boolean via the transform, even
// when the query param is absent — so direct (non-HTTP) calls need it spelled
// out; this helper keeps the call sites terse.
function listQuery(overrides: Partial<ListAccountsQuery> = {}): ListAccountsQuery {
  return { limit: 50, offset: 0, includeInactive: false, ...overrides };
}

const TRUNCATE = sql`TRUNCATE accounts CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("economy service — accounts", () => {
  it("gives a new account its BAS momsruta when vatBox is omitted, null for unknown numbers", async () => {
    const bas = await service.createAccount({ number: "2610", name: "Utgående moms 25 %" });
    const unknown = await service.createAccount({ number: "3010", name: "Försäljning övrigt" });
    expect(bas.vatBox).toBe("10");
    expect(unknown.vatBox).toBeNull();
  });

  it("keeps an explicit vatBox on create, including null and 'none'", async () => {
    const explicit = await service.createAccount({ number: "3010", name: "Försäljning övrigt", vatBox: "05" });
    const cleared = await service.createAccount({ number: "2610", name: "Utgående moms 25 %", vatBox: null });
    const none = await service.createAccount({ number: "3011", name: "Vidarefakturerat", vatBox: "none" });
    expect(explicit.vatBox).toBe("05");
    expect(cleared.vatBox).toBeNull();
    expect(none.vatBox).toBe("none");
  });

  it("a PATCH can set and clear vatBox without touching the BAS default", async () => {
    const created = await service.createAccount({ number: "2610", name: "Utgående moms 25 %" });
    expect((await service.updateAccount(created.id, { vatBox: null })).vatBox).toBeNull();
    expect((await service.updateAccount(created.id, { vatBox: "48" })).vatBox).toBe("48");
  });

  it("seedBasAccounts writes the BAS momsrutor", async () => {
    await service.seedBasAccounts();
    const list = await service.listAccounts(listQuery({ search: "26", limit: 50 }));
    const byNumber = new Map(list.rows.map((row) => [row.number, row.vatBox]));
    expect(byNumber.get("2610")).toBe("10");
    expect(byNumber.get("2650")).toBe("none");
  });

  it("creates and lists an account", async () => {
    const created = await service.createAccount({ number: "1930", name: "Företagskonto/checkkonto" });
    expect(created.number).toBe("1930");
    expect(created.active).toBe(true);

    const { rows, total } = await service.listAccounts(listQuery());
    expect(total).toBe(1);
    expect(rows[0]?.number).toBe("1930");
  });

  it("searches by number or name and paginates", async () => {
    await service.createAccount({ number: "1930", name: "Företagskonto/checkkonto" });
    await service.createAccount({ number: "2440", name: "Leverantörsskulder" });
    await service.createAccount({ number: "2441", name: "Leverantörsskulder EU" });

    const byNumber = await service.listAccounts(listQuery({ search: "1930" }));
    expect(byNumber.rows.map((r) => r.number)).toEqual(["1930"]);

    const byName = await service.listAccounts(listQuery({ search: "leverant" }));
    expect(byName.total).toBe(2);

    const page1 = await service.listAccounts(listQuery({ limit: 2, offset: 0 }));
    const page2 = await service.listAccounts(listQuery({ limit: 2, offset: 2 }));
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
  });

  it("hides inactive accounts unless includeInactive is set", async () => {
    const created = await service.createAccount({ number: "1930", name: "Företagskonto/checkkonto" });
    await service.updateAccount(created.id, { active: false });

    const activeOnly = await service.listAccounts(listQuery());
    expect(activeOnly).toEqual({ rows: [], total: 0 });

    const withInactive = await service.listAccounts(listQuery({ includeInactive: true }));
    expect(withInactive.total).toBe(1);
  });

  it("rejects account numbers that aren't exactly 4 digits or contain letters", () => {
    expect(createAccountSchema.safeParse({ number: "193", name: "X" }).success).toBe(false);
    expect(createAccountSchema.safeParse({ number: "19A0", name: "X" }).success).toBe(false);
    expect(createAccountSchema.safeParse({ number: "1930", name: "X" }).success).toBe(true);
  });

  it("rejects a duplicate account number", async () => {
    await service.createAccount({ number: "1930", name: "Företagskonto/checkkonto" });
    await expect(service.createAccount({ number: "1930", name: "Annat namn" })).rejects.toThrow(
      DuplicateAccountNumberError
    );
  });

  it("updates name and/or active — number is immutable and not part of the update schema", async () => {
    const created = await service.createAccount({ number: "1930", name: "Företagskonto/checkkonto" });

    // number isn't part of the update schema — even if a caller tries to
    // sneak it in, zod strips it before it ever reaches the service/repo.
    const parsed = updateAccountSchema.parse({ number: "9999", name: "Nytt namn", active: false } as unknown);
    expect((parsed as Record<string, unknown>).number).toBeUndefined();

    const updated = await service.updateAccount(created.id, parsed);
    expect(updated.number).toBe("1930");
    expect(updated.name).toBe("Nytt namn");
    expect(updated.active).toBe(false);
  });

  it("throws AccountNotFoundError when updating a non-existent account", async () => {
    await expect(
      service.updateAccount("00000000-0000-0000-0000-000000000000", { name: "X" })
    ).rejects.toThrow(AccountNotFoundError);
  });

  it("seeds the full BAS chart of accounts from empty", async () => {
    const result = await service.seedBasAccounts();
    expect(result).toEqual({ created: BAS_STANDARD_ACCOUNTS.length, skipped: 0 });

    const { total } = await service.listAccounts(listQuery({ limit: 1 }));
    expect(total).toBe(BAS_STANDARD_ACCOUNTS.length);
  });

  it("re-running the seed is a no-op, and a renamed 1930 survives it (one batch insert, not per-row upserts)", async () => {
    await service.seedBasAccounts();
    const account1930 = (await service.listAccounts(listQuery({ search: "1930", limit: 1 }))).rows[0]!;
    await service.updateAccount(account1930.id, { name: "Mitt eget namn" });

    // If the seed were N round-trip upserts instead of one batch insert with
    // onConflictDoNothing, this pre-renamed row would either collide or get
    // reset — either way this assertion is what catches it.
    const second = await service.seedBasAccounts();
    expect(second).toEqual({ created: 0, skipped: BAS_STANDARD_ACCOUNTS.length });

    const stillRenamed = (await service.listAccounts(listQuery({ search: "1930", limit: 1 }))).rows[0]!;
    expect(stillRenamed.name).toBe("Mitt eget namn");
  });
});

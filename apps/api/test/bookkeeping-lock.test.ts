import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { isBookkeepingLockViolation } from "../src/modules/system/service/db-errors.js";

// Databasspärren (migration 0095): the database itself refuses changes to
// booked räkenskapsinformation — whoever writes. These tests go straight to
// SQL on purpose: the services already refuse every one of these writes, so
// only a direct write proves the triggers do.
const service = createEconomyService(createEconomyRepository(db), { log: async () => {} });
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE invoice_documents, invoices, customers, supplier_invoice_files, supplier_invoices, suppliers, verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();

async function setup() {
  const user = await authRepo.create({
    email: `lock-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Bokförare",
    role: "admin",
  });
  await service.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await service.createSeries({ code: "A", name: "Manuella" });
  const bank = await service.createAccount({ number: "1930", name: "Bank" });
  const revenue = await service.createAccount({ number: "3001", name: "Försäljning" });
  const draft = await service.createVerification(
    {
      seriesId: series.id,
      date: `${YEAR}-03-15`,
      description: "Kontantförsäljning",
      rows: [
        { accountId: bank.id, debit: 500, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 500 },
      ],
    },
    user.id
  );
  return { user, series, bank, revenue, draft };
}

async function expectLocked(write: Promise<unknown>) {
  const err = await write.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "the write should have been refused").not.toBeNull();
  expect(isBookkeepingLockViolation(err)).toBe(true);
}

describe("bookkeeping lock — verifications", () => {
  it("lets a draft be edited, its rows changed and the draft deleted", async () => {
    const { draft, bank } = await setup();
    await db.execute(sql`UPDATE verifications SET description = 'Ändrad' WHERE id = ${draft.id}`);
    await db.execute(sql`UPDATE verification_rows SET description = 'rad' WHERE verification_id = ${draft.id}`);
    await db.execute(
      sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit) VALUES (${draft.id}, ${bank.id}, 1, 0)`
    );
    await db.execute(sql`DELETE FROM verifications WHERE id = ${draft.id}`); // rows cascade
  });

  it("refuses to change, re-open or delete a booked verification", async () => {
    const { draft, user } = await setup();
    await service.book(draft.id, user.id);

    await expectLocked(db.execute(sql`UPDATE verifications SET description = 'Ändrad' WHERE id = ${draft.id}`));
    await expectLocked(db.execute(sql`UPDATE verifications SET date = ${`${YEAR}-04-01`} WHERE id = ${draft.id}`));
    await expectLocked(db.execute(sql`UPDATE verifications SET status = 'draft' WHERE id = ${draft.id}`));
    await expectLocked(db.execute(sql`DELETE FROM verifications WHERE id = ${draft.id}`));
  });

  it("refuses to add, change, move or delete rows on a booked verification", async () => {
    const { draft, user, bank, series, revenue } = await setup();
    await service.book(draft.id, user.id);
    const other = await service.createVerification(
      { seriesId: series.id, date: `${YEAR}-03-16`, description: "Utkast", rows: [{ accountId: revenue.id, debit: 1, credit: 0 }] },
      user.id
    );

    await expectLocked(
      db.execute(
        sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit) VALUES (${draft.id}, ${bank.id}, 1, 0)`
      )
    );
    await expectLocked(db.execute(sql`UPDATE verification_rows SET debit = 600 WHERE verification_id = ${draft.id}`));
    await expectLocked(db.execute(sql`DELETE FROM verification_rows WHERE verification_id = ${draft.id}`));
    // Moving a row OUT of the booked verification, or INTO it from a draft.
    await expectLocked(
      db.execute(sql`UPDATE verification_rows SET verification_id = ${other.id} WHERE verification_id = ${draft.id}`)
    );
    await expectLocked(
      db.execute(sql`UPDATE verification_rows SET verification_id = ${draft.id} WHERE verification_id = ${other.id}`)
    );
  });

  it("lets the booking transaction itself insert a booked verification and then its rows (automatkonteringen)", async () => {
    const { series, bank, revenue, user } = await setup();
    const fy = (await db.execute(sql`SELECT id FROM fiscal_years LIMIT 1`)) as unknown as { id: string }[];
    const id = await db.transaction(async (tx) => {
      const [v] = (await tx.execute(
        sql`INSERT INTO verifications (series_id, fiscal_year_id, verification_number, date, description, status, created_by, booked_by, booked_at)
            VALUES (${series.id}, ${fy[0]!.id}, 99, ${`${YEAR}-05-01`}, 'Automat', 'booked', ${user.id}, ${user.id}, now()) RETURNING id`
      )) as unknown as { id: string }[];
      await tx.execute(
        sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit) VALUES (${v!.id}, ${bank.id}, 100, 0), (${v!.id}, ${revenue.id}, 0, 100)`
      );
      return v!.id;
    });
    // …but once that transaction has committed, the verification is locked.
    await expectLocked(
      db.execute(sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit) VALUES (${id}, ${bank.id}, 1, 0)`)
    );
  });

  it("won't let booked_at be re-stamped to unlock rows in a later transaction", async () => {
    const { draft, user, bank } = await setup();
    await service.book(draft.id, user.id);

    // A later transaction can't re-stamp booked_at to its own now() to make
    // the rows look "booked in this transaction".
    await expectLocked(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE verifications SET booked_at = now() WHERE id = ${draft.id}`);
        await tx.execute(
          sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit) VALUES (${draft.id}, ${bank.id}, 1, 0)`
        );
      })
    );
  });

  it("allows only the user FK being nulled on a booked verification (a deleted login)", async () => {
    const { draft, user } = await setup();
    await service.book(draft.id, user.id);
    await db.execute(sql`UPDATE verifications SET created_by = NULL, booked_by = NULL WHERE id = ${draft.id}`);
    const other = await authRepo.create({ email: `x-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Annan", role: "admin" });
    await expectLocked(db.execute(sql`UPDATE verifications SET booked_by = ${other.id} WHERE id = ${draft.id}`));
  });
});

describe("bookkeeping lock — underlag and archived documents", () => {
  it("refuses to delete a booked verification's underlag, allows it on a draft", async () => {
    const { draft, user } = await setup();
    const insertFile = () =>
      db.execute(
        sql`INSERT INTO verification_files (verification_id, filename, content_type, size_bytes, sha256, data)
            VALUES (${draft.id}, 'kvitto.pdf', 'application/pdf', 3, 'abc', '\\x010203') RETURNING id`
      ) as unknown as Promise<{ id: string }[]>;
    const [onDraft] = await insertFile();
    await db.execute(sql`DELETE FROM verification_files WHERE id = ${onDraft!.id}`);

    const [kept] = await insertFile();
    await service.book(draft.id, user.id);
    await expectLocked(db.execute(sql`DELETE FROM verification_files WHERE id = ${kept!.id}`));
    await expectLocked(db.execute(sql`UPDATE verification_files SET filename = 'annan.pdf' WHERE id = ${kept!.id}`));
  });

  it("refuses to delete an attested supplier invoice's underlag", async () => {
    const [supplier] = (await db.execute(
      sql`INSERT INTO suppliers (name, supplier_number) VALUES ('Lev AB', ${`L-${Date.now()}`}) RETURNING id`
    )) as unknown as { id: string }[];
    const [invoice] = (await db.execute(
      sql`INSERT INTO supplier_invoices (registration_number, invoice_number, supplier_id, invoice_date)
          VALUES (${`LF-T${Date.now()}`}, 'F-1', ${supplier!.id}, ${`${YEAR}-03-01`}) RETURNING id`
    )) as unknown as { id: string }[];
    const [file] = (await db.execute(
      sql`INSERT INTO supplier_invoice_files (supplier_invoice_id, filename, content_type, size_bytes, sha256, data)
          VALUES (${invoice!.id}, 'f.pdf', 'application/pdf', 1, 'abc', '\\x01') RETURNING id`
    )) as unknown as { id: string }[];

    await db.execute(sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${invoice!.id}`);
    await expectLocked(db.execute(sql`DELETE FROM supplier_invoice_files WHERE id = ${file!.id}`));
  });

  it("never lets an archived invoice document be changed or deleted", async () => {
    const [customer] = (await db.execute(
      sql`INSERT INTO customers (name, customer_number, active) VALUES ('Kund AB', ${`K-${Date.now()}`}, true) RETURNING id`
    )) as unknown as { id: string }[];
    const [invoice] = (await db.execute(
      sql`INSERT INTO invoices (customer_id) VALUES (${customer!.id}) RETURNING id`
    )) as unknown as { id: string }[];
    const [document] = (await db.execute(
      sql`INSERT INTO invoice_documents (invoice_id, kind, filename, size_bytes, sha256, data)
          VALUES (${invoice!.id}, 'invoice', 'FA-1.pdf', 1, 'abc', '\\x01') RETURNING id`
    )) as unknown as { id: string }[];

    await expectLocked(db.execute(sql`UPDATE invoice_documents SET filename = 'x.pdf' WHERE id = ${document!.id}`));
    await expectLocked(db.execute(sql`DELETE FROM invoice_documents WHERE id = ${document!.id}`));
  });
});

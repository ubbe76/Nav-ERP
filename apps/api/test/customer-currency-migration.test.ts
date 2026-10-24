import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, type Tx } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { receivablesTotalAsOf } from "../src/modules/sales/repository/open-amounts.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// Migration 0145 (Valuta steg 3): the backfill block is re-run here against
// SEK invoices and payments whose new columns are blanked out, inside a
// transaction that is always rolled back — the reskontra's SEK sum must come
// out exactly as before the feature.

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const migrationFile = readdirSync(MIGRATIONS).find((file) => file.endsWith("_valuta_sales.sql"))!;
const migrationText = readFileSync(join(MIGRATIONS, migrationFile), "utf8");

function block(name: string): string[] {
  const start = migrationText.indexOf(`-- ${name}:start`);
  const end = migrationText.indexOf(`-- ${name}:end`);
  if (start < 0 || end < start) throw new Error(`block ${name} not found in ${migrationFile}`);
  return migrationText
    .slice(start, end)
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("--")));
}

class Rollback extends Error {}
async function inRolledBackTx(body: (tx: Tx) => Promise<void>) {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

const poster = createVerificationPoster({ read: readPostingSettings });
const stub = { async sendMail() {}, async render() { return Buffer.alloc(0); }, async renderPaymentReminder() { return Buffer.alloc(0); } };
const invoiceService = createInvoiceService(createInvoiceRepository(db), stub, stub, poster);
const paymentService = createPaymentService(createPaymentRepository(db), poster);
const TODAY = new Date().toLocaleDateString("sv-SE");

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_documents, invoice_reminders, invoice_rows, invoices, customers, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("0145 — the Valuta backfill", () => {
  it("stamps rate 1 and gross_amount_sek, copies the payments' SEK amounts — receivablesTotalAsOf is unchanged", async () => {
    const user = await createAuthRepository(db).create({ email: `mig-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "M", role: "admin" });
    const [customer] = await db.insert(customers).values({ name: "Kund AB", customerNumber: `MIG-${crypto.randomUUID()}`, active: true }).returning();
    const issue = async (unitPrice: number) => {
      const draft = await invoiceService.create({ customerId: customer!.id, rows: [{ description: "X", quantity: 1, unitPrice, vatRate: 25 }] }, user.id);
      return (await invoiceService.issue(draft!.id, user.id))!;
    };
    const a = await issue(1000);
    const b = await issue(400);
    const credit = (await invoiceService.issue((await invoiceService.createCredit(b.id, {}, user.id))!.id, user.id))!;
    await invoiceService.create({ customerId: customer!.id, rows: [{ description: "Utkast", quantity: 1, unitPrice: 99 }] }, user.id);
    const c = await issue(800);
    // a: 1 247 of 1 250 closes it with 3 kr written off; c: 400 of 1 000.
    await paymentService.create(
      { customerId: customer!.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1247, rows: [{ invoiceId: a.id, appliedAmount: 1247 }] },
      user.id
    );
    await paymentService.create(
      { customerId: customer!.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 400, rows: [{ invoiceId: c.id, appliedAmount: 400 }] },
      user.id
    );
    await paymentService.create(
      {
        customerId: customer!.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { invoiceId: b.id, appliedAmount: 500 },
          { invoiceId: credit.id, appliedAmount: -500 },
        ],
      },
      user.id
    );
    const before = await receivablesTotalAsOf(db, TODAY);
    expect(before).toBe(600);

    await inRolledBackTx(async (tx) => {
      // The state before 0145: no rate, no stamp, no SEK side on the payments.
      await tx.execute(sql`ALTER TABLE customer_payments DROP CONSTRAINT customer_payments_sek_amounts`);
      await tx.execute(sql`UPDATE invoices SET exchange_rate = NULL, gross_amount_sek = NULL`);
      await tx.execute(sql`UPDATE customer_payments SET amount_sek = 0`);
      await tx.execute(sql`UPDATE customer_payment_rows SET applied_amount_sek = 0, write_off_amount_sek = 0`);
      expect(await receivablesTotalAsOf(tx, TODAY)).not.toBe(before);

      for (const statement of block("valuta-sales-backfill")) await tx.execute(sql.raw(statement));

      expect(await receivablesTotalAsOf(tx, TODAY)).toBe(before);
      const stamped = [
        ...(await tx.execute(sql`SELECT status, type, exchange_rate::text AS rate, gross_amount_sek::text AS sek FROM invoices ORDER BY created_at`)),
      ] as { status: string; type: string; rate: string; sek: string | null }[];
      expect(stamped.map((r) => [r.status, r.type, r.rate, r.sek])).toEqual([
        ["paid", "invoice", "1.000000", "1250.00"],
        ["paid", "invoice", "1.000000", "500.00"],
        ["paid", "credit", "1.000000", "500.00"],
        ["draft", "invoice", "1.000000", null],
        ["issued", "invoice", "1.000000", "1000.00"],
      ]);
      const payments = [...(await tx.execute(sql`SELECT amount::text AS amount, amount_sek::text AS sek FROM customer_payments ORDER BY created_at`))] as {
        amount: string;
        sek: string;
      }[];
      expect(payments.every((p) => p.amount === p.sek)).toBe(true);
      const rows = [...(await tx.execute(sql`SELECT count(*)::int AS n FROM customer_payment_rows WHERE applied_amount_sek <> applied_amount OR write_off_amount_sek <> write_off_amount`))] as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    });
  });
});

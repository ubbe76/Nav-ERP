import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { accounts, db, systemSettings, vatCodes, type Tx } from "@navet/db";
import { VAT_CODES, VAT_CODE_CATALOG } from "@navet/shared";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";

// Migration 0142 (Momskoder): its marked blocks are re-run here against
// fixtures. Blocks that change data the rest of the suite relies on run
// inside a transaction that is always rolled back; the seed block, which
// can only be exercised on an empty vat_codes, truncates it and re-seeds
// (the block is idempotent) so the following files find the catalog rows.

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const migrationFile = readdirSync(MIGRATIONS).find((file) => file.endsWith("_vat_codes.sql"))!;
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

async function run(executor: typeof db | Tx, name: string) {
  for (const statement of block(name)) await executor.execute(sql.raw(statement));
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

const LEGACY_KEYS = [
  "posting_revenue_25",
  "posting_revenue_12",
  "posting_revenue_6",
  "posting_revenue_0",
  "posting_vat_out_25",
  "posting_vat_out_12",
  "posting_vat_out_6",
  "posting_vat_in",
];

async function reseedDefaults() {
  await db.delete(systemSettings).where(inArray(systemSettings.key, LEGACY_KEYS));
  await db.execute(sql`TRUNCATE vat_codes CASCADE`);
  await run(db, "vat-codes-seed");
}

afterAll(async () => {
  await reseedDefaults();
  await db.execute(sql`TRUNCATE accounts CASCADE`);
});

describe("0142 — vat_codes seed", () => {
  it("copies the eight posting settings onto MP25/MP12/MP6/MF and removes the keys", async () => {
    await db.execute(sql`TRUNCATE vat_codes CASCADE`);
    await db.delete(systemSettings).where(inArray(systemSettings.key, LEGACY_KEYS));
    await db.insert(systemSettings).values([
      { key: "posting_revenue_25", value: "3010" },
      { key: "posting_revenue_0", value: "" },
      { key: "posting_vat_out_12", value: "2621" },
      { key: "posting_vat_in", value: "2641" },
    ]);

    await run(db, "vat-codes-seed");

    const rows = await db.select().from(vatCodes);
    const byCode = new Map(rows.map((row) => [row.code, row] as const));
    expect(byCode.get("MP25")).toMatchObject({ revenueAccount: "3010", outputVatAccount: "2610", inputVatAccount: "2641" });
    expect(byCode.get("MP12")).toMatchObject({ revenueAccount: "3002", outputVatAccount: "2621", inputVatAccount: "2641" });
    expect(byCode.get("MP6")).toMatchObject({ revenueAccount: "3003", outputVatAccount: "2630", inputVatAccount: "2641" });
    // A blanked setting falls back to the BAS default like decodePostingSettings did.
    expect(byCode.get("MF")).toMatchObject({ revenueAccount: "3004", outputVatAccount: null, inputVatAccount: null });
    expect(await db.select().from(systemSettings).where(inArray(systemSettings.key, LEGACY_KEYS))).toEqual([]);
  });

  it("seeds exactly the catalog — codes, names, invoice texts and default accounts — when no settings exist", async () => {
    await reseedDefaults();
    const rows = await db.select().from(vatCodes).orderBy(asc(vatCodes.code));
    expect(rows.map((row) => row.code).sort()).toEqual([...VAT_CODES].sort());
    for (const entry of VAT_CODE_CATALOG) {
      const row = rows.find((candidate) => candidate.code === entry.code)!;
      expect({ code: row.code, name: row.name, invoiceText: row.invoiceText, active: row.active }).toEqual({
        code: entry.code,
        name: entry.label,
        invoiceText: entry.invoiceText,
        active: true,
      });
      expect({
        code: row.code,
        revenue: row.revenueAccount,
        outputVat: row.outputVatAccount,
        inputVat: row.inputVatAccount,
        cost: row.costAccount,
        base: row.baseAccount,
        baseCounter: row.baseCounterAccount,
      }).toEqual({
        code: entry.code,
        revenue: entry.slots.revenue?.account ?? null,
        outputVat: entry.slots.outputVat?.account ?? null,
        inputVat: entry.slots.inputVat?.account ?? null,
        cost: entry.slots.cost?.account ?? null,
        base: entry.slots.base?.account ?? null,
        baseCounter: entry.slots.baseCounter?.account ?? null,
      });
    }
  });
});

describe("0142 — accounts", () => {
  const catalogNumbers = [...new Set(VAT_CODE_CATALOG.flatMap((entry) => Object.values(entry.slots).map((slot) => slot.account)))];

  it("adds nothing to an empty chart of accounts", async () => {
    await db.execute(sql`TRUNCATE accounts CASCADE`);
    await run(db, "vat-codes-accounts");
    expect(await db.select().from(accounts)).toEqual([]);
  });

  it("adds the missing catalog accounts with the seed's names and boxes, keeps an own box and renames only the old 4531", async () => {
    await db.execute(sql`TRUNCATE accounts CASCADE`);
    await db.insert(accounts).values([
      { number: "1510", name: "Kundfordringar" },
      { number: "2614", name: "Utgående moms omvänd 25 % (egen)", vatBox: "05" },
      { number: "2645", name: "Beräknad ingående moms" },
      { number: "4531", name: "Inköp tjänster från annat EU-land 25 %" },
      { number: "4515", name: "Inköp från EU (egen benämning)" },
    ]);

    await run(db, "vat-codes-accounts");

    const rows = new Map((await db.select().from(accounts)).map((row) => [row.number, row] as const));
    // An own box survives; an unclassified account gets the catalog's.
    expect(rows.get("2614")).toMatchObject({ name: "Utgående moms omvänd 25 % (egen)", vatBox: "05" });
    expect(rows.get("2645")).toMatchObject({ name: "Beräknad ingående moms", vatBox: "48" });
    expect(rows.get("4515")).toMatchObject({ name: "Inköp från EU (egen benämning)", vatBox: "20" });
    expect(rows.get("4531")).toMatchObject({ name: "Inköp av tjänster från ett land utanför EU, 25 % moms", vatBox: "22" });
    expect(rows.get("1510")!.vatBox).toBeNull();

    // Every account added is exactly the seed's (BAS_STANDARD_ACCOUNTS).
    const seed = new Map(BAS_STANDARD_ACCOUNTS.map((account) => [account.number, account] as const));
    for (const number of catalogNumbers.filter((n) => !["2614", "2645", "4515", "4531"].includes(n))) {
      const added = rows.get(number);
      if (!["2610", "2620", "2630", "2640", "3001", "3002", "3003", "3004"].includes(number)) {
        expect({ number, name: added?.name, vatBox: added?.vatBox }).toEqual({
          number,
          name: seed.get(number)!.name,
          vatBox: seed.get(number)!.vatBox,
        });
      }
    }
  });

  it("leaves a 4531 with another name alone", async () => {
    await db.execute(sql`TRUNCATE accounts CASCADE`);
    await db.insert(accounts).values({ number: "4531", name: "Tjänster utland", vatBox: "22" });
    await run(db, "vat-codes-accounts");
    const [row] = await db.select().from(accounts).where(eq(accounts.number, "4531"));
    expect(row!.name).toBe("Tjänster utland");
  });

  it("the seed's boxes are the catalog slots' boxes", () => {
    const seed = new Map(BAS_STANDARD_ACCOUNTS.map((account) => [account.number, account] as const));
    for (const entry of VAT_CODE_CATALOG) {
      for (const slot of Object.values(entry.slots)) {
        expect({ code: entry.code, account: slot.account, box: seed.get(slot.account)?.vatBox }).toEqual({
          code: entry.code,
          account: slot.account,
          box: slot.box,
        });
      }
    }
  });
});

describe("0142 — backfills", () => {
  it("turns posting rules per rate into rules per domestic code, the catch-all staying Alla momskoder", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`ALTER TABLE posting_rules ADD COLUMN vat_rate numeric(5, 2)`);
      const [account] = await tx.execute<{ id: string }>(sql`INSERT INTO accounts (number, name) VALUES ('3010', 'X') RETURNING id`);
      const ruleIds: Record<string, string> = {};
      for (const [code, rate, groupCode] of [["g25", 25, "901"], ["g12", 12, "902"], ["g6", 6, "903"], ["g0", 0, "904"], ["gnull", null, "905"]] as const) {
        const [group] = await tx.execute<{ id: string }>(sql`INSERT INTO article_groups (code, name) VALUES (${groupCode}, ${code}) RETURNING id`);
        const [rule] = await tx.execute<{ id: string }>(
          sql`INSERT INTO posting_rules (article_group_id, vat_rate, revenue_account_id) VALUES (${group!.id}, ${rate}, ${account!.id}) RETURNING id`
        );
        ruleIds[code] = rule!.id;
      }

      for (const statement of block("vat-codes-rules-backfill")) await tx.execute(sql.raw(statement));

      const rows = await tx.execute<{ id: string; code: string | null }>(
        sql`SELECT r.id, c.code FROM posting_rules r LEFT JOIN vat_codes c ON c.id = r.vat_code_id`
      );
      const codeOf = (id: string) => [...rows].find((row) => row.id === id)!.code;
      expect([codeOf(ruleIds.g25!), codeOf(ruleIds.g12!), codeOf(ruleIds.g6!), codeOf(ruleIds.g0!), codeOf(ruleIds.gnull!)]).toEqual([
        "MP25",
        "MP12",
        "MP6",
        "MF",
        null,
      ]);
    });
  });

  it("gives every invoice row the domestic code of its rate (an odd rate gets MP25 and keeps its rate)", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`ALTER TABLE invoice_rows ALTER COLUMN vat_code_id DROP NOT NULL`);
      const [customer] = await tx.execute<{ id: string }>(
        sql`INSERT INTO customers (customer_number, name) VALUES ('MIG-1', 'Migreringskund') RETURNING id`
      );
      const [invoice] = await tx.execute<{ id: string }>(sql`INSERT INTO invoices (customer_id) VALUES (${customer!.id}) RETURNING id`);
      for (const rate of ["25", "12", "6", "0", "8"]) {
        await tx.execute(sql`INSERT INTO invoice_rows (invoice_id, description, quantity, unit_price, vat_rate, line_amount, vat_amount)
          VALUES (${invoice!.id}, ${rate}, 1, 100, ${rate}, 100, 0)`);
      }

      for (const statement of block("vat-codes-invoice-rows-backfill")) await tx.execute(sql.raw(statement));

      const rows = await tx.execute<{ description: string; code: string; vat_rate: string }>(
        sql`SELECT r.description, c.code, r.vat_rate FROM invoice_rows r JOIN vat_codes c ON c.id = r.vat_code_id WHERE r.invoice_id = ${invoice!.id}`
      );
      expect(Object.fromEntries([...rows].map((row) => [row.description, row.code]))).toEqual({
        "25": "MP25",
        "12": "MP12",
        "6": "MP6",
        "0": "MF",
        "8": "MP25",
      });
      expect(Number([...rows].find((row) => row.description === "8")!.vat_rate)).toBe(8);
    });
  });

  it("gives supplier invoices MP25 (MF for an attested one without VAT) and a draft's deviating row its rate's code", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`ALTER TABLE supplier_invoices ALTER COLUMN vat_code_id DROP NOT NULL`);
      const [supplier] = await tx.execute<{ id: string }>(
        sql`INSERT INTO suppliers (supplier_number, name) VALUES ('MIG-1', 'Migreringsleverantör') RETURNING id`
      );
      const invoice = async (number: string, status: string, vat: number) => {
        const [row] = await tx.execute<{ id: string }>(sql`INSERT INTO supplier_invoices
          (registration_number, invoice_number, supplier_id, invoice_date, status, net_amount, vat_amount, gross_amount)
          VALUES (${`LF-MIG-${number}`}, ${number}, ${supplier!.id}, '2030-01-15', ${status}::supplier_invoice_status, 1000, ${vat}, ${1000 + vat}) RETURNING id`);
        return row!.id;
      };
      const draftZero = await invoice("1", "draft", 0);
      const approvedZero = await invoice("2", "approved", 0);
      const approvedVat = await invoice("3", "approved", 250);
      const approvedRows = await invoice("4", "approved", 250);
      for (const [id, rate] of [
        [draftZero, "12"],
        [draftZero, "25"],
        [draftZero, null],
        [approvedRows, "12"],
      ] as const) {
        await tx.execute(sql`INSERT INTO supplier_invoice_rows (supplier_invoice_id, description, unit_price, line_amount, vat_rate)
          VALUES (${id}, ${rate ?? "none"}, 100, 100, ${rate})`);
      }

      for (const statement of block("vat-codes-supplier-invoices-backfill")) await tx.execute(sql.raw(statement));

      const headers = await tx.execute<{ id: string; code: string }>(
        sql`SELECT i.id, c.code FROM supplier_invoices i JOIN vat_codes c ON c.id = i.vat_code_id WHERE i.supplier_id = ${supplier!.id}`
      );
      const headerCode = (id: string) => [...headers].find((row) => row.id === id)!.code;
      expect([headerCode(draftZero), headerCode(approvedZero), headerCode(approvedVat), headerCode(approvedRows)]).toEqual([
        "MP25",
        "MF",
        "MP25",
        "MP25",
      ]);
      const rows = await tx.execute<{ invoice: string; description: string; code: string | null }>(sql`
        SELECT r.supplier_invoice_id AS invoice, r.description, c.code
        FROM supplier_invoice_rows r LEFT JOIN vat_codes c ON c.id = r.vat_code_id
        WHERE r.supplier_invoice_id IN (${draftZero}, ${approvedRows})`);
      const rowCode = (invoiceId: string, description: string) =>
        [...rows].find((row) => row.invoice === invoiceId && row.description === description)!.code;
      // Draft: 12 % deviates from the MP25 header, 25 % equals it, no rate stays null.
      expect([rowCode(draftZero, "12"), rowCode(draftZero, "25"), rowCode(draftZero, "none")]).toEqual(["MP12", null, null]);
      // Attested invoices are already posted — their rows are left alone.
      expect(rowCode(approvedRows, "12")).toBeNull();
    });
  });
});

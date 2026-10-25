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
// Dröjsmålsränta (0151) seeds UTM into the same table — re-run with the
// 0142 seed so the catalog is whole again for the files that follow.
const lateInterestFile = readdirSync(MIGRATIONS).find((file) => file.endsWith("_drojsmalsranta.sql"))!;
const lateInterestText = readFileSync(join(MIGRATIONS, lateInterestFile), "utf8");

function block(name: string, text = migrationText, file = migrationFile): string[] {
  const start = text.indexOf(`-- ${name}:start`);
  const end = text.indexOf(`-- ${name}:end`);
  if (start < 0 || end < start) throw new Error(`block ${name} not found in ${file}`);
  return text
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
  for (const statement of block("utm-seed", lateInterestText, lateInterestFile)) await db.execute(sql.raw(statement));
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
  // UTM (0151) came later: its 3990 is added by that migration, not 0142.
  const catalogNumbers = [
    ...new Set(VAT_CODE_CATALOG.filter((entry) => entry.code !== "UTM").flatMap((entry) => Object.values(entry.slots).map((slot) => slot.account))),
  ];

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
      // 0102's forced values — 'none' for 26xx, '05' for 3000–3799 — are not
      // an own choice: the catalog's box replaces them.
      { number: "2624", name: "Utgående moms omvänd 12 %", vatBox: "none" },
      { number: "3231", name: "Försäljning byggtjänster", vatBox: "05" },
      // An own box that is not the forced value for the number stays.
      { number: "2615", name: "Utgående moms import 25 % (egen)", vatBox: "10" },
      { number: "3308", name: "Försäljning tjänster EU (egen)", vatBox: "42" },
    ]);

    await run(db, "vat-codes-accounts");

    const rows = new Map((await db.select().from(accounts)).map((row) => [row.number, row] as const));
    // An own box survives; an unclassified account gets the catalog's.
    expect(rows.get("2614")).toMatchObject({ name: "Utgående moms omvänd 25 % (egen)", vatBox: "05" });
    expect(rows.get("2645")).toMatchObject({ name: "Beräknad ingående moms", vatBox: "48" });
    expect(rows.get("4515")).toMatchObject({ name: "Inköp från EU (egen benämning)", vatBox: "20" });
    expect(rows.get("4531")).toMatchObject({ name: "Inköp av tjänster från ett land utanför EU, 25 % moms", vatBox: "22" });
    expect(rows.get("1510")!.vatBox).toBeNull();
    // 0102's forced value is replaced; an own value is not.
    expect(rows.get("2624")).toMatchObject({ name: "Utgående moms omvänd 12 %", vatBox: "31" });
    expect(rows.get("3231")).toMatchObject({ name: "Försäljning byggtjänster", vatBox: "41" });
    expect(rows.get("2615")!.vatBox).toBe("10");
    expect(rows.get("3308")!.vatBox).toBe("42");

    // Every account added is exactly the seed's (BAS_STANDARD_ACCOUNTS).
    const seed = new Map(BAS_STANDARD_ACCOUNTS.map((account) => [account.number, account] as const));
    for (const number of catalogNumbers.filter((n) => !["2614", "2645", "4515", "4531", "2624", "3231", "2615", "3308"].includes(n))) {
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

  it("keeps 0102's forced box on an account with booked verification rows (declared periods must not change)", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`TRUNCATE accounts CASCADE`);
      await tx.insert(accounts).values([
        { number: "1930", name: "Bank" },
        { number: "2634", name: "Utgående moms omvänd 6 %", vatBox: "none" },
        { number: "2625", name: "Utgående moms import 12 %", vatBox: "none" },
        { number: "3305", name: "Försäljning tjänster utanför EU", vatBox: "05" },
        { number: "3308", name: "Försäljning tjänster EU", vatBox: "05" },
      ]);
      const ids = Object.fromEntries((await tx.select().from(accounts)).map((row) => [row.number, row.id] as const));
      const [year] = await tx.execute<{ id: string }>(
        sql`INSERT INTO fiscal_years (label, start_date, end_date) VALUES ('MIG-0142', '2031-01-01', '2031-12-31') RETURNING id`
      );
      const [series] = await tx.execute<{ id: string }>(
        sql`INSERT INTO verification_series (code, name) VALUES ('MIG', 'Migreringstest') RETURNING id`
      );
      const verification = async (status: "draft" | "booked", rows: [string, number, number][]) => {
        const [ver] = await tx.execute<{ id: string }>(sql`INSERT INTO verifications (series_id, fiscal_year_id, date, description, status)
          VALUES (${series!.id}, ${year!.id}, '2031-03-15', 'Före 0142', ${status}::verification_status) RETURNING id`);
        for (const [number, debit, credit] of rows) {
          await tx.execute(sql`INSERT INTO verification_rows (verification_id, account_id, debit, credit)
            VALUES (${ver!.id}, ${ids[number]!}, ${debit}, ${credit})`);
        }
      };
      // Booked in this transaction (the lock exempts rows booked with it).
      await verification("booked", [
        ["1930", 1060, 0],
        ["3305", 0, 1000],
        ["2634", 0, 60],
      ]);
      // A draft is not bookkeeping — it does not hold the box back.
      await verification("draft", [
        ["1930", 112, 0],
        ["3308", 0, 100],
        ["2625", 0, 12],
      ]);

      for (const statement of block("vat-codes-accounts")) await tx.execute(sql.raw(statement));

      const boxes = Object.fromEntries((await tx.select().from(accounts)).map((row) => [row.number, row.vatBox] as const));
      expect({ "2634": boxes["2634"], "3305": boxes["3305"], "2625": boxes["2625"], "3308": boxes["3308"] }).toEqual({
        "2634": "none",
        "3305": "05",
        "2625": "61",
        "3308": "39",
      });
    });
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

describe("0142 — suppliers' country", () => {
  it("reads the country off the VAT number's prefix (EL ⇒ GR, XI ⇒ GB), else the IBAN's, else SE", async () => {
    await inRolledBackTx(async (tx) => {
      const cases: [string, string | null, string | null, string][] = [
        ["MIG-DE", "de 123 456 789", null, "DE"],
        ["MIG-EL", "EL123456789", "DE89370400440532013000", "GR"],
        ["MIG-XI", "XI123456789", null, "GB"],
        ["MIG-CH", "CHE-123.456.789 MWST", null, "CH"],
        ["MIG-NO", "NO 923 456 789 MVA", null, "NO"],
        ["MIG-SE", "SE556677889901", "DE89370400440532013000", "SE"],
        // Digits first: not a prefix — the IBAN decides.
        ["MIG-ORG", "556677-8899", "FI2112345600000785", "FI"],
        // Two letters that are no ISO code: the IBAN decides.
        ["MIG-ZZ", "ZZ123", "NL91ABNA0417164300", "NL"],
        ["MIG-IBAN", null, " dk50 0040 0440 1162 43 ", "DK"],
        ["MIG-NONE", null, null, "SE"],
        ["MIG-BAD", "QQ1", "XX12", "SE"],
      ];
      for (const [number, vatNumber, iban] of cases) {
        await tx.execute(sql`INSERT INTO suppliers (supplier_number, name, vat_number, iban, country)
          VALUES (${number}, ${number}, ${vatNumber}, ${iban}, 'SE')`);
      }

      for (const statement of block("vat-codes-supplier-country")) await tx.execute(sql.raw(statement));

      const rows = await tx.execute<{ supplier_number: string; country: string }>(
        sql`SELECT supplier_number, country FROM suppliers WHERE supplier_number LIKE 'MIG-%'`
      );
      expect(Object.fromEntries([...rows].map((row) => [row.supplier_number, row.country]))).toEqual(
        Object.fromEntries(cases.map(([number, , , country]) => [number, country]))
      );
    });
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

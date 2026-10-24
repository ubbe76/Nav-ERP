import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { BAS_STANDARD_ACCOUNTS, defaultVatBox } from "../src/modules/economy/service/bas-accounts.js";
import { VAT_CODE_CATALOG } from "@navet/shared";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";

// Every account a momskod points at, except the ones the 0102 rule already
// classified the same way (the domestic accounts and 3105/3108).
const PRE_0142 = new Set(["2610", "2620", "2630", "2640", "3001", "3002", "3003", "3004", "3105", "3108"]);
const MOMSKOD_ACCOUNTS = [
  ...new Set(VAT_CODE_CATALOG.flatMap((entry) => Object.values(entry.slots).map((slot) => slot.account))),
].filter((number) => !PRE_0142.has(number));

// The 0102 migration's backfill must reproduce the OLD bucketMovements
// classification exactly — otherwise the VAT report changes on deploy. The
// SQL is read from the migration file itself (between the marker comments)
// and re-run against fixtures, then compared to a port of the old if-chain.

const repo = createEconomyRepository(db);
const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const migrationFile = readdirSync(MIGRATIONS).find((file) => file.endsWith("_account_vat_box.sql"));
const backfillSql = (() => {
  if (!migrationFile) return "";
  const text = readFileSync(join(MIGRATIONS, migrationFile), "utf8");
  const start = text.indexOf("-- vat-box-backfill:start");
  const end = text.indexOf("-- vat-box-backfill:end");
  return start >= 0 && end > start ? text.slice(start, end) : "";
})();

// The 0102 rule read the per-rate settings that migration 0142 moved onto
// the momskoder; their old defaults are spelled out here for the port.
const LEGACY_DEFAULTS = {
  ...DEFAULT_POSTING_SETTINGS,
  postingVatOut25: "2610",
  postingVatOut12: "2620",
  postingVatOut6: "2630",
  postingVatIn: "2640",
  postingRevenue0: "3004",
};
type Settings = { [K in keyof typeof LEGACY_DEFAULTS]: string };

// Port of the pre-migration bucketMovements chain: which box an account's
// movements landed in (null = not counted anywhere).
function legacyBox(number: string, s: Settings): string | null {
  if (number === s.postingVatOut25) return "10";
  if (number === s.postingVatOut12) return "11";
  if (number === s.postingVatOut6) return "12";
  if (number === s.postingVatIn) return "48";
  if (number === s.postingRevenue0) return "42";
  if (number === "3108") return "35";
  if (number === "3105") return "36";
  if (number === s.postingReminderFeeAccount || number === s.postingPaymentWriteOff) return null;
  if (number >= "3000" && number <= "3799") return "05";
  return null;
}

const SETTING_KEYS: Partial<Record<keyof Settings, string>> = {
  postingVatOut25: "posting_vat_out_25",
  postingRevenue0: "posting_revenue_0",
  postingReminderFeeAccount: "posting_reminder_fee_account",
};

async function reset() {
  await db.execute(sql`TRUNCATE accounts CASCADE`);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'posting_%'`);
}

async function seedFixtures() {
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  for (const [number, name] of [
    ["3010", "Försäljning övrigt"],
    ["3911", "Hyresintäkter"],
    ["2611", "Utgående moms 25 % (egen)"],
    ["3800", "Aktiverat arbete"],
  ] as const) {
    await db.execute(sql`INSERT INTO accounts (number, name) VALUES (${number}, ${name})`);
  }
  await db.execute(sql`UPDATE accounts SET vat_box = NULL`);
}

async function boxesByNumber() {
  const rows = await db.execute<{ number: string; vat_box: string | null }>(
    sql`SELECT number, vat_box FROM accounts ORDER BY number`
  );
  return new Map([...rows].map((row) => [row.number, row.vat_box]));
}

beforeEach(reset);
afterAll(reset);

describe("0102 vat_box backfill", () => {
  it("finds the backfill block in the migration file", () => {
    expect(migrationFile).toBeDefined();
    expect(backfillSql).toContain("UPDATE accounts SET vat_box");
  });

  const variants: { label: string; settings: Settings }[] = [
    { label: "default settings", settings: { ...LEGACY_DEFAULTS } },
    {
      label: "customized settings",
      settings: {
        ...LEGACY_DEFAULTS,
        postingVatOut25: "2611",
        postingRevenue0: "3010",
        postingReminderFeeAccount: "3590",
      },
    },
  ];

  for (const { label, settings } of variants) {
    it(`reproduces the old report classification (${label})`, async () => {
      await seedFixtures();
      for (const [field, key] of Object.entries(SETTING_KEYS)) {
        const value = settings[field as keyof Settings];
        if (value !== LEGACY_DEFAULTS[field as keyof Settings]) {
          await db.execute(sql`INSERT INTO system_settings (key, value) VALUES (${key}, ${value})`);
        }
      }

      await db.execute(sql.raw(backfillSql));

      for (const [number, box] of await boxesByNumber()) {
        const counted = box === "none" ? null : box;
        expect({ number, box: counted }).toEqual({ number, box: legacyBox(number, settings) });
        if (number.startsWith("3") || number.startsWith("26")) {
          expect({ number, classified: box !== null }).toEqual({ number, classified: true });
        }
      }
    });
  }

  it("the BAS defaults equal the backfill under default settings (accounts that predate the momskoder)", async () => {
    await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
    const seeded = await boxesByNumber();
    await db.execute(sql`UPDATE accounts SET vat_box = NULL`);
    await db.execute(sql.raw(backfillSql));
    const backfilled = await boxesByNumber();
    // The accounts the momskod catalog brought in (0142) carry their slot's
    // box, which the old interval rule never knew about.
    for (const number of MOMSKOD_ACCOUNTS) {
      seeded.delete(number);
      backfilled.delete(number);
    }
    expect(backfilled).toEqual(seeded);
  });

  it("defaultVatBox returns the BAS default and null for unknown numbers", () => {
    expect(defaultVatBox("2610")).toBe("10");
    expect(defaultVatBox("3740")).toBe("none");
    expect(defaultVatBox("3010")).toBeNull();
    expect(defaultVatBox("1930")).toBeNull();
  });
});

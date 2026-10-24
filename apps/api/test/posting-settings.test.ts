import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, systemSettings } from "@navet/db";
import { POSTING_SETTINGS_KEYS, readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

// system_settings is shared base data across every test file (never
// truncated) — every test here restores the keys it touches, same idiom as
// system.service.test.ts's PAXML_KEYS/POSTING_ACCOUNT_KEYS cleanups.
beforeEach(async () => {
  await db.delete(systemSettings).where(inArray(systemSettings.key, POSTING_SETTINGS_KEYS));
});

afterAll(async () => {
  await db.delete(systemSettings).where(inArray(systemSettings.key, POSTING_SETTINGS_KEYS));
});

const systemService = createSystemService(createSystemRepository(db));

// The BAS-standard/kundreskontra defaults readPostingSettings falls back to
// when nothing is configured — mirrors system.service.test.ts's
// POSTING_ACCOUNT_KEYS expectations plus the 3 new accounts and 2 amounts.
const DEFAULTS = {
  postingAccountsReceivable: "1510",
  postingAccountsPayable: "2440",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  // Momsrapport (B5): redovisningskonto för moms — the settlement
  // verification's net lands here.
  postingVatSettlement: "2650",
  // Årsbokslut (steg 2): lager och lagerförändring.
  postingInventory: "1460",
  postingInventoryChange: "4990",
  // Valuta: kursvinst, kursförlust, bankkostnader.
  postingFxGain: "3960",
  postingFxLoss: "7960",
  postingBankFees: "6570",
  paymentTolerance: 5,
  reminderFee: 60,
};

describe("posting-settings leaf — readPostingSettings", () => {
  it("returns BAS-standard/kundreskontra defaults when no rows exist", async () => {
    const settings = await readPostingSettings(db);
    expect(settings).toEqual(DEFAULTS);
  });

  it("reflects overrides stored as system_settings key/value rows", async () => {
    await db.insert(systemSettings).values([
      { key: "posting_bank", value: "1940" },
      { key: "posting_reminder_fee_account", value: "3541" },
      { key: "posting_payment_writeoff", value: "3741" },
      { key: "posting_vat_settlement", value: "2651" },
      { key: "payment_tolerance", value: "12.5" },
      { key: "reminder_fee", value: "75" },
      { key: "posting_default_cost", value: "4099" },
    ]);

    const settings = await readPostingSettings(db);
    expect(settings.postingBank).toBe("1940");
    expect(settings.postingReminderFeeAccount).toBe("3541");
    expect(settings.postingPaymentWriteOff).toBe("3741");
    expect(settings.postingVatSettlement).toBe("2651");
    expect(settings.paymentTolerance).toBe(12.5);
    expect(settings.reminderFee).toBe(75);
    expect(settings.postingDefaultCost).toBe("4099");
  });

  it("falls back to the default for an absent, blank, or non-numeric amount, and a blanked account", async () => {
    await db.insert(systemSettings).values([
      { key: "posting_bank", value: "" },
      { key: "payment_tolerance", value: "" },
      { key: "reminder_fee", value: "not-a-number" },
      // posting_reminder_fee_account left absent entirely.
    ]);

    const settings = await readPostingSettings(db);
    expect(settings.postingBank).toBe("1930");
    expect(settings.paymentTolerance).toBe(5);
    expect(settings.reminderFee).toBe(60);
    expect(settings.postingReminderFeeAccount).toBe("3540");
  });

  it("is Db|Tx-composable — reads through the caller's own transaction", async () => {
    await db.insert(systemSettings).values({ key: "posting_bank", value: "1950" });

    const result = await db.transaction(async (tx) => readPostingSettings(tx));
    expect(result.postingBank).toBe("1950");
  });

  it("no longer carries the revenue and VAT accounts per rate (they belong to the momskoder)", async () => {
    const settings = (await readPostingSettings(db)) as unknown as Record<string, unknown>;
    for (const key of ["postingRevenue25", "postingVatOut25", "postingVatIn", "postingRevenue0"]) {
      expect(settings[key]).toBeUndefined();
    }
    const fromService = (await systemService.getSettings()) as unknown as Record<string, unknown>;
    expect(fromService.postingVatOut25).toBeUndefined();
  });

  it("agrees with systemService.getSettings()'s posting slice", async () => {
    await db.insert(systemSettings).values([
      { key: "posting_bank", value: "1960" },
      { key: "reminder_fee", value: "42" },
      { key: "posting_default_cost", value: "4099" },
    ]);

    const leafResult = await readPostingSettings(db);
    const serviceResult = await systemService.getSettings();

    for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
      expect(serviceResult[key]).toEqual(leafResult[key]);
    }
  });
});

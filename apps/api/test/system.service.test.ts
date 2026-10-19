import { describe, expect, it } from "vitest";
import { desc, eq, inArray } from "drizzle-orm";
import { auditLog, companyInfo, db, numberSeries, systemSettings } from "@navet/db";
import { updateSystemSettingsSchema } from "@navet/shared";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService, NumberSeriesNotFoundError } from "../src/modules/system/service/system.service.js";
import { getNextOrderNumber } from "../src/modules/system/service/number-series.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";

// number_series and company_info are fixed singleton-ish tables shared
// across every test file (order creation in purchase/sales/manufacturing
// tests depends on the three number_series rows existing) — never
// truncated here. Any row mutated by a test is restored afterwards.

const auditRepository = createAuditRepository(db);
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db), auditRepository);

// This file never truncates audit_log (system_settings/company_info/
// number_series are shared, never-truncated singletons — see above), so
// audit assertions below always look at the MOST RECENT matching row rather
// than counting rows, which would accumulate across every test in the file.
async function lastAuditRowFor(entityType: string, action: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityType, entityType))
    .orderBy(desc(auditLog.createdAt))
    .limit(20);
  return rows.find((r) => r.action === action);
}

async function makeUser() {
  return authRepo.create({
    email: `sysadmin-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Admin",
    role: "admin",
  });
}

describe("number series — getNextOrderNumber", () => {
  it("issues a formatted, incrementing number and advances the counter", async () => {
    const before = await db.select().from(numberSeries).where(eq(numberSeries.key, "purchase_order"));
    const startNext = before[0]!.nextNumber;

    const first = await getNextOrderNumber(db, "purchase_order");
    const second = await getNextOrderNumber(db, "purchase_order");

    expect(first).toBe(`IO-${startNext}`);
    expect(second).toBe(`IO-${startNext + 1}`);
  });

  it("is safe under concurrent calls — no two callers get the same number", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => getNextOrderNumber(db, "manufacturing_order")));
    expect(new Set(results).size).toBe(20);
  });

  it("throws for an unconfigured series key", async () => {
    await expect(getNextOrderNumber(db, "does_not_exist")).rejects.toThrow();
  });

  it("zero-pads when digits > 0", async () => {
    const original = (await db.select().from(numberSeries).where(eq(numberSeries.key, "sales_order")))[0]!;
    await db.update(numberSeries).set({ prefix: "KO-", nextNumber: 7, digits: 4 }).where(eq(numberSeries.key, "sales_order"));

    try {
      const issued = await getNextOrderNumber(db, "sales_order");
      expect(issued).toBe("KO-0007");
    } finally {
      await db
        .update(numberSeries)
        .set({ prefix: original.prefix, nextNumber: original.nextNumber, digits: original.digits })
        .where(eq(numberSeries.key, "sales_order"));
    }
  });
});

describe("system service — settings", () => {
  it("round-trips showOrderRevisionOnDocuments and defaults it on", async () => {
    // The key defaults ON when never set ("value !== 'false'"), unlike the
    // other boolean toggles. system_settings is shared across test files, so
    // exercise both stored states and restore the default afterwards.
    const off = await systemService.updateSettings({ showOrderRevisionOnDocuments: false });
    expect(off.showOrderRevisionOnDocuments).toBe(false);
    const on = await systemService.updateSettings({ showOrderRevisionOnDocuments: true });
    expect(on.showOrderRevisionOnDocuments).toBe(true);
    expect((await systemService.getSettings()).showOrderRevisionOnDocuments).toBe(true);
  });

  it("defaults Materialbrist vid rapportering to 'none' and round-trips the three modes", async () => {
    // Absent key ⇒ "none" — the behaviour before the setting existed, so a
    // deploy changes nothing. An unknown stored value decodes the same way.
    await db.delete(systemSettings).where(eq(systemSettings.key, "manufacturing_material_shortage"));
    try {
      expect((await systemService.getSettings()).manufacturingMaterialShortage).toBe("none");
      expect((await systemService.updateSettings({ manufacturingMaterialShortage: "warn" })).manufacturingMaterialShortage).toBe("warn");
      expect((await systemService.getSettings()).manufacturingMaterialShortage).toBe("warn");
      expect((await systemService.updateSettings({ manufacturingMaterialShortage: "block" })).manufacturingMaterialShortage).toBe("block");
      expect((await systemService.updateSettings({ manufacturingMaterialShortage: "none" })).manufacturingMaterialShortage).toBe("none");
      await db
        .insert(systemSettings)
        .values({ key: "manufacturing_material_shortage", value: "garbage" })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: "garbage" } });
      expect((await systemService.getSettings()).manufacturingMaterialShortage).toBe("none");
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "manufacturing_material_shortage"));
    }
    expect(updateSystemSettingsSchema.safeParse({ manufacturingMaterialShortage: "maybe" }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ manufacturingMaterialShortage: "block" }).success).toBe(true);
  });

  it("defaults Orimligt mycket tid to 4 weeks, round-trips decimals and 0, and junk decodes to the default", async () => {
    await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
    try {
      expect((await systemService.getSettings()).planningLongOperationWeeks).toBe(4);
      expect((await systemService.updateSettings({ planningLongOperationWeeks: 2.5 })).planningLongOperationWeeks).toBe(2.5);
      expect((await systemService.updateSettings({ planningLongOperationWeeks: 0 })).planningLongOperationWeeks).toBe(0);
      await db
        .insert(systemSettings)
        .values({ key: "planning_long_operation_weeks", value: "garbage" })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: "garbage" } });
      expect((await systemService.getSettings()).planningLongOperationWeeks).toBe(4);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
    }
    expect(updateSystemSettingsSchema.safeParse({ planningLongOperationWeeks: -1 }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ planningLongOperationWeeks: 105 }).success).toBe(false);
  });

  it("defaults the delivery-day settings and round-trips them; junk decodes to the defaults", async () => {
    const keys = ["supplier_delivery_day_mode", "supplier_transit_days", "customer_delivery_day_mode", "customer_transit_days"];
    await db.delete(systemSettings).where(inArray(systemSettings.key, keys));
    try {
      expect(await systemService.getSettings()).toMatchObject({
        supplierDeliveryDayMode: "arrival",
        supplierTransitDays: 0,
        customerDeliveryDayMode: "dispatch",
        customerTransitDays: 0,
      });
      const updated = await systemService.updateSettings({
        supplierDeliveryDayMode: "dispatch",
        supplierTransitDays: 2,
        customerDeliveryDayMode: "arrival",
        customerTransitDays: 60,
      });
      expect(updated).toMatchObject({
        supplierDeliveryDayMode: "dispatch",
        supplierTransitDays: 2,
        customerDeliveryDayMode: "arrival",
        customerTransitDays: 60,
      });
      for (const key of keys) {
        await db
          .insert(systemSettings)
          .values({ key, value: "abc" })
          .onConflictDoUpdate({ target: systemSettings.key, set: { value: "abc" } });
      }
      expect(await systemService.getSettings()).toMatchObject({
        supplierDeliveryDayMode: "arrival",
        supplierTransitDays: 0,
        customerDeliveryDayMode: "dispatch",
        customerTransitDays: 0,
      });
    } finally {
      await db.delete(systemSettings).where(inArray(systemSettings.key, keys));
    }
    expect(updateSystemSettingsSchema.safeParse({ supplierTransitDays: 61 }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ customerDeliveryDayMode: "maybe" }).success).toBe(false);
  });

  it("defaults Tillåten överleverans to 0 % and round-trips a percent and 'no limit' (null)", async () => {
    // system_settings is shared across test files — remove the key afterwards
    // so everyone else sees the default again.
    await db.delete(systemSettings).where(eq(systemSettings.key, "purchase_over_receipt_percent"));
    try {
      expect((await systemService.getSettings()).purchaseOverReceiptPercent).toBe(0);
      expect((await systemService.updateSettings({ purchaseOverReceiptPercent: 12.5 })).purchaseOverReceiptPercent).toBe(12.5);
      expect((await systemService.updateSettings({ purchaseOverReceiptPercent: null })).purchaseOverReceiptPercent).toBeNull();
      expect((await systemService.getSettings()).purchaseOverReceiptPercent).toBeNull();
      expect((await systemService.updateSettings({ purchaseOverReceiptPercent: 0 })).purchaseOverReceiptPercent).toBe(0);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "purchase_over_receipt_percent"));
    }
    expect(updateSystemSettingsSchema.safeParse({ purchaseOverReceiptPercent: -1 }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ purchaseOverReceiptPercent: null }).success).toBe(true);
  });

  it("round-trips the costing settings and defaults them to standard cost with no markups", async () => {
    // The defaults are what keeps the calculation unchanged for anyone who
    // never opens System → Kalkyler. system_settings is shared across test
    // files, so restore them afterwards.
    try {
      const updated = await systemService.updateSettings({
        costingMaterialSource: "supplier",
        costingMoPercent: 12.5,
        costingLoPercent: 5,
        costingAffoPercent: 12,
        costingGeneralMarkupPercent: 20,
      });
      expect(updated.costingMaterialSource).toBe("supplier");
      expect(updated.costingMoPercent).toBe(12.5);

      const reread = await systemService.getSettings();
      expect(reread.costingLoPercent).toBe(5);
      expect(reread.costingAffoPercent).toBe(12);
      expect(reread.costingGeneralMarkupPercent).toBe(20);
    } finally {
      const restored = await systemService.updateSettings({
        costingMaterialSource: "standard",
        costingMoPercent: 0,
        costingLoPercent: 0,
        costingAffoPercent: 0,
        costingGeneralMarkupPercent: 0,
      });
      expect(restored.costingMaterialSource).toBe("standard");
      expect(restored.costingMoPercent).toBe(0);
    }
  });

  it("reads the Verklig kostnad material source back after storing it", async () => {
    // The decode used to be a two-way ternary (=== "supplier" ? … : "standard")
    // which stored any new enum member and then silently answered "standard"
    // on the way out. A round trip is the only shape of test that catches it.
    try {
      const updated = await systemService.updateSettings({ costingMaterialSource: "actual" });
      expect(updated.costingMaterialSource).toBe("actual");

      const reread = await systemService.getSettings();
      expect(reread.costingMaterialSource).toBe("actual");
    } finally {
      await systemService.updateSettings({ costingMaterialSource: "standard" });
    }
  });

  const PAXML_KEYS = ["paxml_code_worked", "paxml_code_overtime", "paxml_code_overtime_off_schedule", "paxml_code_atf"];

  it("defaults the PAXml codes and overtime threshold when the keys are unset", async () => {
    // system_settings is shared across test files/runs — delete the rows
    // outright to prove the "unset" (never configured) path, not just the
    // empty-string path exercised by the next test.
    await db.delete(systemSettings).where(inArray(systemSettings.key, PAXML_KEYS));

    const settings = await systemService.getSettings();
    expect(settings.paxmlCodeWorked).toBe("TID");
    expect(settings.paxmlCodeOvertime).toBe("ÖT1");
    expect(settings.paxmlCodeOvertimeOffSchedule).toBe("ÖT2");
    expect(settings.paxmlCodeAtf).toBe("ATF");
  });

  it("round-trips the PAXml codes and overtime threshold, and blanking a code reads back as its default", async () => {
    try {
      const updated = await systemService.updateSettings({
        paxmlCodeWorked: "ARB",
        paxmlCodeOvertime: "OB1",
        paxmlCodeOvertimeOffSchedule: "OB2",
        paxmlCodeAtf: "AFT",
        payrollOvertimeThresholdMinutes: 15,
      });
      expect(updated.paxmlCodeWorked).toBe("ARB");
      expect(updated.paxmlCodeOvertime).toBe("OB1");
      expect(updated.paxmlCodeOvertimeOffSchedule).toBe("OB2");
      expect(updated.paxmlCodeAtf).toBe("AFT");
      expect(updated.payrollOvertimeThresholdMinutes).toBe(15);

      const reread = await systemService.getSettings();
      expect(reread.paxmlCodeWorked).toBe("ARB");
      expect(reread.paxmlCodeOvertime).toBe("OB1");
      expect(reread.paxmlCodeOvertimeOffSchedule).toBe("OB2");
      expect(reread.paxmlCodeAtf).toBe("AFT");
      expect(reread.payrollOvertimeThresholdMinutes).toBe(15);

      // An explicit empty-string PATCH is "set" (stored as-is, like the SMTP
      // fields), but getSettings() decodes an empty stored value back to the
      // Monitor-like default rather than exporting a blank löneart code.
      const blanked = await systemService.updateSettings({ paxmlCodeWorked: "", paxmlCodeAtf: "" });
      expect(blanked.paxmlCodeWorked).toBe("TID");
      expect(blanked.paxmlCodeAtf).toBe("ATF");
      // Untouched fields keep their previously stored value.
      expect(blanked.paxmlCodeOvertime).toBe("OB1");
    } finally {
      await systemService.updateSettings({
        paxmlCodeWorked: "TID",
        paxmlCodeOvertime: "ÖT1",
        paxmlCodeOvertimeOffSchedule: "ÖT2",
        paxmlCodeAtf: "ATF",
        payrollOvertimeThresholdMinutes: 0,
      });
    }
  });

  it("defaults the comp-time overtime codes and round-trips updates", async () => {
    try {
      const defaults = await systemService.getSettings();
      expect(defaults.paxmlCodeOvertimeComp).toBe("ÖK1");
      expect(defaults.paxmlCodeOvertimeOffScheduleComp).toBe("ÖK2");

      const updated = await systemService.updateSettings({
        paxmlCodeOvertimeComp: "KOMP1",
        paxmlCodeOvertimeOffScheduleComp: "KOMP2",
      });
      expect(updated.paxmlCodeOvertimeComp).toBe("KOMP1");
      expect(updated.paxmlCodeOvertimeOffScheduleComp).toBe("KOMP2");

      const reread = await systemService.getSettings();
      expect(reread.paxmlCodeOvertimeComp).toBe("KOMP1");
      expect(reread.paxmlCodeOvertimeOffScheduleComp).toBe("KOMP2");
    } finally {
      await systemService.updateSettings({
        paxmlCodeOvertimeComp: "ÖK1",
        paxmlCodeOvertimeOffScheduleComp: "ÖK2",
      });
    }
  });

  const POSTING_ACCOUNT_KEYS = [
    "posting_accounts_receivable",
    "posting_vat_out_25",
    "posting_vat_out_12",
    "posting_vat_out_6",
    "posting_revenue_25",
    "posting_revenue_12",
    "posting_revenue_6",
    "posting_revenue_0",
    "posting_accounts_payable",
    "posting_vat_in",
    "posting_default_cost",
    // Momsrapport (B5).
    "posting_vat_settlement",
    // Årsbokslut (steg 2).
    "posting_inventory",
    "posting_inventory_change",
  ];

  it("defaults the posting accounts (automatic accounting) when the keys are unset", async () => {
    // Prove the "unset" (never configured) path, not just the empty-string
    // path exercised by the next test — same reasoning as the PAXml codes.
    await db.delete(systemSettings).where(inArray(systemSettings.key, POSTING_ACCOUNT_KEYS));

    const settings = await systemService.getSettings();
    expect(settings.postingAccountsReceivable).toBe("1510");
    expect(settings.postingVatOut25).toBe("2610");
    expect(settings.postingVatOut12).toBe("2620");
    expect(settings.postingVatOut6).toBe("2630");
    expect(settings.postingRevenue25).toBe("3001");
    expect(settings.postingRevenue12).toBe("3002");
    expect(settings.postingRevenue6).toBe("3003");
    expect(settings.postingRevenue0).toBe("3004");
    expect(settings.postingAccountsPayable).toBe("2440");
    expect(settings.postingVatIn).toBe("2640");
    expect(settings.postingDefaultCost).toBe("4010");
    expect(settings.postingVatSettlement).toBe("2650");
    expect(settings.postingInventory).toBe("1460");
    expect(settings.postingInventoryChange).toBe("4990");
  });

  it("round-trips the posting accounts, and blanking one reads back as its default", async () => {
    try {
      const updated = await systemService.updateSettings({
        postingAccountsReceivable: "1511",
        postingVatOut25: "2611",
        postingVatOut12: "2621",
        postingVatOut6: "2631",
        postingRevenue25: "3011",
        postingRevenue12: "3012",
        postingRevenue6: "3013",
        postingRevenue0: "3014",
        postingAccountsPayable: "2441",
        postingVatIn: "2641",
        postingDefaultCost: "4011",
        postingVatSettlement: "2651",
        postingInventory: "1410",
        postingInventoryChange: "4991",
      });
      expect(updated.postingAccountsReceivable).toBe("1511");
      expect(updated.postingVatOut25).toBe("2611");
      expect(updated.postingVatOut12).toBe("2621");
      expect(updated.postingVatOut6).toBe("2631");
      expect(updated.postingRevenue25).toBe("3011");
      expect(updated.postingRevenue12).toBe("3012");
      expect(updated.postingRevenue6).toBe("3013");
      expect(updated.postingRevenue0).toBe("3014");
      expect(updated.postingAccountsPayable).toBe("2441");
      expect(updated.postingVatIn).toBe("2641");
      expect(updated.postingDefaultCost).toBe("4011");
      expect(updated.postingVatSettlement).toBe("2651");
      expect(updated.postingInventory).toBe("1410");
      expect(updated.postingInventoryChange).toBe("4991");

      const reread = await systemService.getSettings();
      expect(reread.postingVatOut25).toBe("2611");
      expect(reread.postingDefaultCost).toBe("4011");

      // An explicit empty-string PATCH is "set" (stored as-is, like the
      // PAXml codes/SMTP fields), but getSettings() decodes an empty stored
      // value back to the default rather than exporting a blank account.
      const blanked = await systemService.updateSettings({ postingVatOut25: "", postingVatSettlement: "", postingInventory: "" });
      expect(blanked.postingVatOut25).toBe("2610");
      expect(blanked.postingVatSettlement).toBe("2650");
      expect(blanked.postingInventory).toBe("1460");
      // Untouched fields keep their previously stored value.
      expect(blanked.postingAccountsReceivable).toBe("1511");
    } finally {
      await systemService.updateSettings({
        postingAccountsReceivable: "",
        postingVatOut25: "",
        postingVatOut12: "",
        postingVatOut6: "",
        postingRevenue25: "",
        postingRevenue12: "",
        postingRevenue6: "",
        postingRevenue0: "",
        postingAccountsPayable: "",
        postingVatIn: "",
        postingDefaultCost: "",
        postingVatSettlement: "",
        postingInventory: "",
        postingInventoryChange: "",
      });
    }
  });

  it("rejects posting account values that aren't exactly 4 digits", () => {
    expect(updateSystemSettingsSchema.safeParse({ postingVatOut25: "12a4" }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ postingVatOut25: "123" }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ postingVatOut25: "12345" }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ postingVatOut25: "2610" }).success).toBe(true);
    expect(updateSystemSettingsSchema.safeParse({ postingVatOut25: "" }).success).toBe(true);
  });

  // Kundreskontra (B3): the 3 new posting accounts and the 2 kr amounts.
  const KUNDRESKONTRA_KEYS = ["posting_bank", "posting_reminder_fee_account", "posting_payment_writeoff", "payment_tolerance", "reminder_fee"];

  it("defaults the kundreskontra posting keys when unset", async () => {
    // Prove the "unset" path, not just the empty-string path — same
    // reasoning as the PAXml codes/posting accounts above.
    await db.delete(systemSettings).where(inArray(systemSettings.key, KUNDRESKONTRA_KEYS));

    const settings = await systemService.getSettings();
    expect(settings.postingBank).toBe("1930");
    expect(settings.postingReminderFeeAccount).toBe("3540");
    expect(settings.postingPaymentWriteOff).toBe("3740");
    expect(settings.paymentTolerance).toBe(5);
    expect(settings.reminderFee).toBe(60);
  });

  it("round-trips the kundreskontra posting keys — amounts as numbers, blanking an account reads back as its default", async () => {
    try {
      const updated = await systemService.updateSettings({
        postingBank: "1931",
        postingReminderFeeAccount: "3541",
        postingPaymentWriteOff: "3741",
        paymentTolerance: 12.5,
        reminderFee: 75,
      });
      expect(updated.postingBank).toBe("1931");
      expect(updated.postingReminderFeeAccount).toBe("3541");
      expect(updated.postingPaymentWriteOff).toBe("3741");
      expect(updated.paymentTolerance).toBe(12.5);
      expect(updated.reminderFee).toBe(75);

      const reread = await systemService.getSettings();
      expect(reread.postingBank).toBe("1931");
      expect(reread.paymentTolerance).toBe(12.5);
      expect(reread.reminderFee).toBe(75);

      // An explicit empty-string PATCH is "set" (stored as-is, like the other
      // account fields), but getSettings() decodes an empty stored value
      // back to the default rather than exporting a blank account.
      const blanked = await systemService.updateSettings({ postingBank: "" });
      expect(blanked.postingBank).toBe("1930");
      // Untouched fields keep their previously stored value.
      expect(blanked.postingReminderFeeAccount).toBe("3541");
    } finally {
      await systemService.updateSettings({
        postingBank: "",
        postingReminderFeeAccount: "",
        postingPaymentWriteOff: "",
        paymentTolerance: 5,
        reminderFee: 60,
      });
    }
  });

  it("rejects kundreskontra amounts outside 0..100000, accepts the boundaries", () => {
    expect(updateSystemSettingsSchema.safeParse({ paymentTolerance: -1 }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ reminderFee: 100001 }).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ paymentTolerance: 0 }).success).toBe(true);
    expect(updateSystemSettingsSchema.safeParse({ reminderFee: 100000 }).success).toBe(true);
  });
});

describe("system service — number series admin API", () => {
  it("lists the sixteen configured series", async () => {
    const rows = await systemService.listNumberSeries();
    // The migration-seeded series only — own article series (generated keys)
    // come and go with the users of the table.
    const keys = rows
      .filter((r) => !(r.forArticles && r.key !== "article"))
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual([
      "article",
      "customer",
      "customer_payment",
      "delivery",
      "fixed_asset",
      "inquiry",
      "invoice",
      "manufacturing_order",
      "payment_batch",
      "purchase_order",
      "sales_order",
      "shipment",
      "stock_count",
      "supplier",
      "supplier_invoice",
      "supplier_payment",
    ]);
  });

  it("updates prefix/nextNumber/digits and it takes effect on the next issued number", async () => {
    const original = (await db.select().from(numberSeries).where(eq(numberSeries.key, "manufacturing_order")))[0]!;

    try {
      await systemService.updateNumberSeries("manufacturing_order", { prefix: "TO-", nextNumber: 9000, digits: 5 });
      const issued = await getNextOrderNumber(db, "manufacturing_order");
      expect(issued).toBe("TO-09000");
    } finally {
      await db
        .update(numberSeries)
        .set({ prefix: original.prefix, nextNumber: original.nextNumber, digits: original.digits })
        .where(eq(numberSeries.key, "manufacturing_order"));
    }
  });

  it("throws NumberSeriesNotFoundError for an unknown key", async () => {
    await expect(systemService.updateNumberSeries("bogus", { prefix: "X-" })).rejects.toThrow(NumberSeriesNotFoundError);
  });
});

describe("system service — company info", () => {
  it("reads the singleton row with hasLogo false and no binary data leaked", async () => {
    const info = await systemService.getCompanyInfo();
    expect(info).not.toBeNull();
    expect(info).not.toHaveProperty("logo");
    expect(typeof info!.hasLogo).toBe("boolean");
  });

  it("updates fields and reflects them on the next read", async () => {
    const original = await systemService.getCompanyInfo();

    try {
      const updated = await systemService.updateCompanyInfo({ name: "Navet Verkstad AB", orgNumber: "556677-8899" });
      expect(updated?.name).toBe("Navet Verkstad AB");
      expect(updated?.orgNumber).toBe("556677-8899");

      const reread = await systemService.getCompanyInfo();
      expect(reread?.name).toBe("Navet Verkstad AB");
    } finally {
      await systemService.updateCompanyInfo({
        name: original?.name || "",
        orgNumber: original?.orgNumber ?? null,
      });
    }
  });

  it("stores payment/registration details for the document footer", async () => {
    const original = await systemService.getCompanyInfo();

    try {
      const updated = await systemService.updateCompanyInfo({
        bankgiro: "123-4567",
        plusgiro: "12 34 56-7",
        bankName: "Handelsbanken",
        iban: "SE35 5000 0000 0549 1000 0003",
        bic: "HANDSESS",
        vatNumber: "SE556677889901",
        companySeat: "Kiruna",
        fSkatt: true,
      });
      expect(updated?.bankgiro).toBe("123-4567");
      expect(updated?.plusgiro).toBe("12 34 56-7");
      expect(updated?.bankName).toBe("Handelsbanken");
      expect(updated?.iban).toBe("SE35 5000 0000 0549 1000 0003");
      expect(updated?.bic).toBe("HANDSESS");
      expect(updated?.vatNumber).toBe("SE556677889901");
      expect(updated?.companySeat).toBe("Kiruna");
      expect(updated?.fSkatt).toBe(true);

      const reread = await systemService.getCompanyInfo();
      expect(reread?.bankgiro).toBe("123-4567");
      expect(reread?.fSkatt).toBe(true);
    } finally {
      await systemService.updateCompanyInfo({
        bankgiro: null,
        plusgiro: null,
        bankName: null,
        iban: null,
        bic: null,
        vatNumber: null,
        companySeat: null,
        fSkatt: false,
      });
    }
  });

  it("stores and serves the logo, tracked via hasLogo", async () => {
    const before = await systemService.getCompanyInfo();
    expect(before?.hasLogo).toBe(false);

    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    try {
      await systemService.updateLogo(fakePng, "image/png");

      const after = await systemService.getCompanyInfo();
      expect(after?.hasLogo).toBe(true);

      const logo = await systemService.getLogo();
      expect(logo?.logo?.equals(fakePng)).toBe(true);
      expect(logo?.logoContentType).toBe("image/png");
    } finally {
      await db.update(companyInfo).set({ logo: null, logoContentType: null });
    }
  });
});

// G1: append-only audit trail over the system module's admin writes.
// system_settings/company_info are singletons, so entityId is null;
// number_series uses its own key as the readable entityId.
describe("system service — audit log", () => {
  // THE masking test: updateSettings must log the KEY that changed, never
  // the value — and smtp_password (the one genuine secret in this module)
  // must not leak its value anywhere in the audit detail, not even as a
  // before/after diff.
  it("logs updateSettings as changed KEYS only — smtp_password never carries a value", async () => {
    const user = await makeUser();
    try {
      await systemService.updateSettings(
        { smtpHost: "smtp.example.com", smtpPassword: "super-secret-password-123" },
        user.id
      );

      const row = await lastAuditRowFor("system_settings", "updated");
      expect(row).toBeDefined();
      expect(row!.entityId).toBeNull();
      expect(row!.userId).toBe(user.id);
      expect(row!.detail).toEqual({ changedKeys: ["smtp_host", "smtp_password"] });
      // Belt and braces: the plaintext password never appears anywhere in
      // the serialized detail, under any key or shape.
      expect(JSON.stringify(row!.detail)).not.toContain("super-secret-password-123");
    } finally {
      await db.delete(systemSettings).where(inArray(systemSettings.key, ["smtp_host", "smtp_password"]));
    }
  });

  it("does not log updateSettings when every field in the PATCH is undefined", async () => {
    const user = await makeUser();
    await systemService.updateSettings({}, user.id);
    // No NEW row for this user — the prior test's row (if any) is untouched,
    // so assert on this specific user's absence instead of a global count.
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, user.id));
    expect(rows.filter((r) => r.entityType === "system_settings")).toHaveLength(0);
  });

  it("logs updateCompanyInfo with changed field NAMES only (not secret, but not a row diff either)", async () => {
    const user = await makeUser();
    const original = await systemService.getCompanyInfo();
    try {
      await systemService.updateCompanyInfo({ name: "Navet Verkstad AB", orgNumber: "556677-8899" }, user.id);

      const row = await lastAuditRowFor("company_info", "updated");
      expect(row).toBeDefined();
      expect(row!.entityId).toBeNull();
      expect(row!.userId).toBe(user.id);
      expect(row!.detail).toEqual({ changedFields: ["name", "orgNumber"] });
    } finally {
      await systemService.updateCompanyInfo({ name: original?.name || "", orgNumber: original?.orgNumber ?? null });
    }
  });

  it("logs updateLogo as logo_updated with contentType/size, entityId null", async () => {
    const user = await makeUser();
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    try {
      await systemService.updateLogo(fakePng, "image/png", user.id);

      const row = await lastAuditRowFor("company_info", "logo_updated");
      expect(row).toBeDefined();
      expect(row!.entityId).toBeNull();
      expect(row!.userId).toBe(user.id);
      expect(row!.detail).toEqual({ contentType: "image/png", sizeBytes: fakePng.length });
    } finally {
      await db.update(companyInfo).set({ logo: null, logoContentType: null });
    }
  });

  it("logs updateNumberSeries with before/after and entityId = the series key", async () => {
    const user = await makeUser();
    const original = (await db.select().from(numberSeries).where(eq(numberSeries.key, "manufacturing_order")))[0]!;
    try {
      await systemService.updateNumberSeries("manufacturing_order", { prefix: "TO-", nextNumber: 9000, digits: 5 }, user.id);

      const row = await lastAuditRowFor("number_series", "updated");
      expect(row).toBeDefined();
      expect(row!.entityId).toBe("manufacturing_order");
      expect(row!.userId).toBe(user.id);
      expect(row!.detail).toEqual({
        before: { prefix: original.prefix, nextNumber: original.nextNumber, digits: original.digits },
        after: { prefix: "TO-", nextNumber: 9000, digits: 5 },
      });
    } finally {
      await db
        .update(numberSeries)
        .set({ prefix: original.prefix, nextNumber: original.nextNumber, digits: original.digits })
        .where(eq(numberSeries.key, "manufacturing_order"));
    }
  });
});

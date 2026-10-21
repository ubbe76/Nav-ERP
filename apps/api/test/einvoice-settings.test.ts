import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { updateEinvoiceSettingsSchema, peppolIdFieldSchema, updateCustomerSchema } from "@navet/shared";
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import { companyProblems, createEinvoiceSettingsService, orgNumberDigits } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { EinvoiceNotConfiguredError } from "../src/modules/einvoice/service/einvoice.errors.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import { createFakeEinvoiceProvider } from "./helpers/fake-einvoice-provider.js";
import { testSystemService } from "./helpers/services.js";

const repo = createEinvoiceRepository(db);
const audit: { log: (e: unknown) => Promise<void>; entries: unknown[] } = {
  entries: [],
  async log(e) {
    this.entries.push(e);
  },
};
const fake = createFakeEinvoiceProvider();
const settings = createEinvoiceSettingsService({ repo, company: testSystemService, audit, providerFactory: fake.factory });

async function reset() {
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'einvoice_%'`);
  await testSystemService.updateCompanyInfo({
    name: "Nav Test AB",
    orgNumber: "5560000001",
    vatNumber: "SE556000000101",
    address: "Fabriksvägen 1",
    postalCode: "41107",
    city: "Göteborg",
    bankgiro: "123-4567",
  });
}

beforeEach(async () => {
  await reset();
  audit.entries.length = 0;
  fake.configs.length = 0;
  fake.calls.length = 0;
  fake.state.checkKeyError = null;
});
afterAll(reset);

describe("e-fakturainställningar", () => {
  it("has safe defaults and describes the company data it will send", async () => {
    const view = await settings.view();
    expect(view).toMatchObject({
      enabled: false,
      environment: "sandbox",
      apiKeySet: false,
      accountId: null,
      accountName: null,
      statusIntervalMinutes: 30,
      lastStatusRunAt: null,
    });
    expect(view.company).toMatchObject({ orgNumber: "5560000001", vatNumber: "SE556000000101", bankgiro: "123-4567", problems: [] });
  });

  it("keeps the api key write-only, '' keeps it, null deletes it, and the audit trail sees key names only", async () => {
    await settings.update({ apiKey: "test_very-secret", enabled: true, statusIntervalMinutes: 15, accountId: "nav" }, "u1");
    const view = await settings.view();
    expect(view).toMatchObject({ apiKeySet: true, enabled: true, statusIntervalMinutes: 15, accountId: "nav" });
    expect(JSON.stringify(view)).not.toContain("very-secret");
    expect(JSON.stringify(audit.entries)).not.toContain("very-secret");
    expect(audit.entries[0]).toMatchObject({
      entityType: "einvoice_settings",
      action: "updated",
      userId: "u1",
      detail: { keys: ["einvoice_account_id", "einvoice_api_key", "einvoice_enabled", "einvoice_status_interval_minutes"] },
    });

    await settings.update({ apiKey: "" }, null);
    expect((await settings.read()).apiKey).toBe("test_very-secret");
    await settings.update({ apiKey: null, accountId: null }, null);
    expect((await settings.read()).apiKey).toBeNull();
    expect((await settings.read()).accountId).toBeNull();
    // Nothing changed ⇒ nothing logged.
    audit.entries.length = 0;
    await settings.update({}, null);
    expect(audit.entries).toEqual([]);
  });

  it("validates the inputs at the zod layer", () => {
    expect(updateEinvoiceSettingsSchema.safeParse({ apiKey: "bad\nkey" }).success).toBe(false);
    expect(updateEinvoiceSettingsSchema.safeParse({ statusIntervalMinutes: 2 }).success).toBe(false);
    expect(updateEinvoiceSettingsSchema.safeParse({ statusIntervalMinutes: "45" }).data).toEqual({ statusIntervalMinutes: 45 });
    expect(updateEinvoiceSettingsSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(peppolIdFieldSchema.parse(" 0007:5560000000 ")).toBe("0007:5560000000");
    expect(peppolIdFieldSchema.parse("")).toBeNull();
    expect(peppolIdFieldSchema.parse(null)).toBeNull();
    expect(peppolIdFieldSchema.safeParse("5560000000").success).toBe(false);
    expect(peppolIdFieldSchema.safeParse("0007:55-60").success).toBe(false);
    expect(updateCustomerSchema.parse({ invoiceDelivery: "peppol", peppolId: "" })).toEqual({ invoiceDelivery: "peppol", peppolId: null });
    expect(updateCustomerSchema.safeParse({ invoiceDelivery: "fax" }).success).toBe(false);
  });

  it("builds the provider from the settings and refuses when off / without key / without account", async () => {
    await expect(settings.provider({ requireEnabled: true })).rejects.toMatchObject({ reason: "disabled" });
    await expect(settings.provider({ requireEnabled: false })).rejects.toMatchObject({ reason: "no-key" });
    await settings.update({ apiKey: "test_k", environment: "production" }, null);
    await settings.provider({ requireEnabled: false });
    expect(fake.configs.at(-1)).toEqual({ environment: "production", apiKey: "test_k", accountId: null });
    await expect(settings.provider({ requireEnabled: false, requireAccount: true })).rejects.toBeInstanceOf(EinvoiceNotConfiguredError);
    await settings.update({ enabled: true, accountId: "acc" }, null);
    await settings.provider({ requireEnabled: true, requireAccount: true });
    expect(fake.configs.at(-1)).toEqual({ environment: "production", apiKey: "test_k", accountId: "acc" });
  });

  it("Testa anslutning uses the typed key and environment, saves nothing, and answers with the account", async () => {
    await settings.update({ apiKey: "test_saved" }, null);
    const result = await settings.testConnection({ apiKey: "test_typed", environment: "production" });
    expect(result).toEqual({ accountId: "nav-test", accountName: "Nav Test AB", vatNumber: "SE556000000101", environment: "production" });
    expect(fake.configs.at(-1)).toMatchObject({ apiKey: "test_typed", environment: "production" });
    expect(await settings.read()).toMatchObject({ apiKey: "test_saved", environment: "sandbox", accountId: null });

    // Omitted key = the saved one.
    await settings.testConnection({});
    expect(fake.configs.at(-1)).toMatchObject({ apiKey: "test_saved", environment: "sandbox" });
    await settings.update({ apiKey: null }, null);
    await expect(settings.testConnection({})).rejects.toMatchObject({ reason: "no-key" });

    fake.state.checkKeyError = new EInvoiceProviderError("nekad", "unauthorized");
    await expect(settings.testConnection({ apiKey: "test_bad" })).rejects.toBeInstanceOf(EInvoiceProviderError);
  });

  it("lists what is missing in the company data", () => {
    expect(orgNumberDigits("556000-0000")).toBe("5560000000");
    expect(orgNumberDigits("16556000-0000")).toBe("5560000000");
    expect(orgNumberDigits("55600")).toBeNull();
    const problems = companyProblems({
      name: "",
      orgNumber: "123",
      vatNumber: null,
      address: null,
      postalCode: "41107",
      city: "Göteborg",
      phone: null,
      email: null,
      bankgiro: null,
      plusgiro: null,
      iban: null,
      bic: null,
      fSkatt: false,
    });
    expect(problems).toEqual([
      "Företagsnamn saknas",
      "Organisationsnummer saknas eller är inte tio siffror",
      "Momsregistreringsnummer saknas",
      "Adress, postnummer eller ort saknas",
      "Bankgiro, plusgiro eller IBAN saknas — fakturan skickas utan betalningsuppgifter",
    ]);
    expect(companyProblems(null)).toHaveLength(5);
  });
});

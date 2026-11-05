import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { updateEinvoiceSettingsSchema, peppolIdFieldSchema, updateCustomerSchema } from "@navet/shared";
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import {
  companyProblems,
  createEinvoiceSettingsService,
  EinvoiceWebhookPublicUrlError,
  orgNumberDigits,
} from "../src/modules/einvoice/service/einvoice-settings.service.js";
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
      autoSend: true,
      webhook: { active: false, environment: null, url: null, lastReceivedAt: null, environmentMismatch: false, proposedUrl: null },
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

  it("keeps the account name tied to the account id: written together, cleared when the id goes or changes without a name", async () => {
    await settings.update({ accountId: "100001", accountName: "Nav Test AB" }, "u1");
    expect(await settings.read()).toMatchObject({ accountId: "100001", accountName: "Nav Test AB" });
    // The same id again, without a name, keeps the name.
    await settings.update({ accountId: "100001", enabled: true }, "u1");
    expect(await settings.read()).toMatchObject({ accountId: "100001", accountName: "Nav Test AB" });
    // A new id without a name clears it — the name described the old account.
    await settings.update({ accountId: "100002" }, "u1");
    expect(await settings.read()).toMatchObject({ accountId: "100002", accountName: null });
    await settings.update({ accountId: "100002", accountName: "Annat AB" }, "u1");
    expect((await settings.read()).accountName).toBe("Annat AB");
    // Ta bort nyckel: null id ⇒ no name either, whatever was sent beside it.
    await settings.update({ apiKey: null, accountId: null, accountName: "kvar?" }, "u1");
    expect(await settings.read()).toMatchObject({ accountId: null, accountName: null });
    expect(updateEinvoiceSettingsSchema.safeParse({ accountName: null }).success).toBe(true);
    expect(JSON.stringify(audit.entries.at(-1))).toContain("einvoice_account_name");
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

describe("automatik och statusbesked (spec 2026-11-05)", () => {
  let publicBase: string | null = "https://nav.example.se";
  const withUrl = createEinvoiceSettingsService({ repo, company: testSystemService, audit, providerFactory: fake.factory, publicBaseUrl: async () => publicBase });

  beforeEach(() => {
    publicBase = "https://nav.example.se";
    fake.state.webhooks.clear();
    fake.state.createWebhookError = null;
    fake.state.deleteWebhookError = null;
  });

  it("Skicka automatiskt vid Utfärda is on unless switched off", async () => {
    expect((await settings.read()).autoSend).toBe(true);
    await settings.update({ autoSend: false }, "u1");
    expect((await settings.view()).autoSend).toBe(false);
    expect(audit.entries.at(-1)).toMatchObject({ detail: { keys: ["einvoice_auto_send"] } });
    await settings.update({ autoSend: true }, "u1");
    expect((await settings.read()).autoSend).toBe(true);
  });

  it("registers the hook at the public address, keeps the secret to itself and shows the rest", async () => {
    await withUrl.update({ apiKey: "test_key", accountId: "nav" }, "u1");
    expect((await withUrl.view()).webhook).toMatchObject({ active: false, proposedUrl: "https://nav.example.se/api/v1/einvoice/webhook" });
    const view = await withUrl.registerWebhook("u1");
    expect(view.webhook).toMatchObject({ active: true, environment: "sandbox", url: "https://nav.example.se/api/v1/einvoice/webhook", environmentMismatch: false });
    expect(JSON.stringify(view)).not.toContain("whsec_test_secret");
    expect([...fake.state.webhooks.values()]).toEqual([{ url: "https://nav.example.se/api/v1/einvoice/webhook", events: ["issued_invoice.state_change"] }]);
    const read = await withUrl.read();
    expect(read.webhook).toMatchObject({ secret: "whsec_test_secret", environment: "sandbox" });
    expect(audit.entries.at(-1)).toMatchObject({ action: "webhook_registered", detail: { environment: "sandbox" } });
    expect(JSON.stringify(audit.entries)).not.toContain("whsec_test_secret");

    // Registering again replaces the old hook at the access point.
    await withUrl.registerWebhook("u1");
    expect(fake.state.webhooks.size).toBe(1);
    expect(fake.calls.filter((c) => c.method === "deleteWebhook")).toHaveLength(1);

    // Another environment chosen afterwards: the page says so.
    await withUrl.update({ environment: "production" }, "u1");
    expect((await withUrl.view()).webhook).toMatchObject({ active: true, environmentMismatch: true });
  });

  it("refuses without a public https address, and passes on the access point's refusal", async () => {
    await withUrl.update({ apiKey: "test_key" }, "u1");
    publicBase = "http://nav.local";
    await expect(withUrl.registerWebhook("u1")).rejects.toBeInstanceOf(EinvoiceWebhookPublicUrlError);
    publicBase = "https://nav.example.se";
    fake.state.createWebhookError = new EInvoiceProviderError("B2Brouter godtog inte webhooken: url is not public", "validation");
    await expect(withUrl.registerWebhook("u1")).rejects.toThrow("B2Brouter godtog inte webhooken");
    expect((await withUrl.read()).webhook.id).toBeNull();
  });

  it("Stäng av removes the hook at the access point (already gone is fine) and forgets it", async () => {
    await withUrl.update({ apiKey: "test_key" }, "u1");
    await withUrl.registerWebhook("u1");
    const view = await withUrl.unregisterWebhook("u1");
    expect(view.webhook.active).toBe(false);
    expect(fake.state.webhooks.size).toBe(0);
    expect((await withUrl.read()).webhook).toEqual({ id: null, secret: null, environment: null, url: null, lastReceivedAt: null });
    // Gone at B2Brouter already: still forgotten here.
    await withUrl.registerWebhook("u1");
    fake.state.webhooks.clear();
    await withUrl.unregisterWebhook("u1");
    expect((await withUrl.read()).webhook.id).toBeNull();
    // Another failure keeps it, so the admin can try again.
    await withUrl.registerWebhook("u1");
    fake.state.deleteWebhookError = new EInvoiceProviderError("B2Brouter svarar inte, försök igen", "unavailable");
    await expect(withUrl.unregisterWebhook("u1")).rejects.toThrow("B2Brouter svarar inte");
    expect((await withUrl.read()).webhook.id).not.toBeNull();
  });
});


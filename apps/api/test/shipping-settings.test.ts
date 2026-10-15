import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, holidays } from "@navet/db";
import { updateFreightSettingsSchema } from "@navet/shared";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { FreightNotConfiguredError, InvalidFreightArticleError } from "../src/modules/shipping/service/shipping.errors.js";
import { createFakeFreightProvider } from "./helpers/fake-freight-provider.js";
import { enableFreight, makeArticle, resetShipping } from "./helpers/shipping-fixtures.js";

const repo = createShippingRepository(db);
const audit: { log: (e: unknown) => Promise<void>; entries: unknown[] } = {
  entries: [],
  async log(e) {
    this.entries.push(e);
  },
};
const fake = createFakeFreightProvider();
const configs: unknown[] = [];
// Monday 2030-01-07 10:00 Swedish time.
const settings = createFreightSettingsService({
  repo,
  audit,
  providerFactory: (config) => {
    configs.push(config);
    return fake.provider;
  },
  now: () => new Date("2030-01-07T09:00:00Z"),
});

beforeEach(async () => {
  await resetShipping();
  audit.entries.length = 0;
  configs.length = 0;
  fake.calls.length = 0;
});
afterAll(resetShipping);

describe("fraktinställningar", () => {
  it("has safe defaults", async () => {
    expect(await settings.view()).toEqual({
      enabled: false,
      environment: "sandbox",
      apiKeySet: false,
      senderContactName: "",
      senderPhone: "",
      senderEmail: "",
      markupPercent: 0,
      markupAmount: 0,
      freightArticleId: null,
      priceChangePercent: 5,
      trackingInterval: "hourly",
      lastTrackingRunAt: null,
    });
  });

  it("keeps the api key write-only and never puts it in the audit trail", async () => {
    await settings.update({ apiKey: "very-secret", markupPercent: 10 }, null);
    const view = await settings.view();
    expect(view.apiKeySet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("very-secret");
    expect(JSON.stringify(audit.entries)).not.toContain("very-secret");
    expect(audit.entries[0]).toMatchObject({ entityType: "freight_settings", action: "updated", detail: { keys: ["freight_api_key", "freight_markup_percent"] } });

    await settings.update({ apiKey: "" }, null);
    expect((await settings.read()).apiKey).toBe("very-secret");
    await settings.update({ apiKey: null }, null);
    expect((await settings.read()).apiKey).toBeNull();
  });

  it("rejects an api key with control characters before it can reach a header", () => {
    expect(updateFreightSettingsSchema.safeParse({ apiKey: "ok-key_123" }).success).toBe(true);
    expect(updateFreightSettingsSchema.safeParse({ apiKey: "bad\nkey" }).success).toBe(false);
    expect(updateFreightSettingsSchema.safeParse({ apiKey: "bad\u0000key" }).success).toBe(false);
    expect(updateFreightSettingsSchema.safeParse({ apiKey: "nyckel-å" }).success).toBe(false);
  });

  it("refuses an unknown freight article", async () => {
    await expect(settings.update({ freightArticleId: crypto.randomUUID() }, null)).rejects.toBeInstanceOf(InvalidFreightArticleError);
    const article = await makeArticle({ type: "service" });
    expect((await settings.update({ freightArticleId: article.id }, null)).freightArticleId).toBe(article.id);
  });

  it("replaces the pickup times as a whole set", async () => {
    await settings.replacePickupTimes({ pickupTimes: [{ weekday: 5, timeFrom: "09:00", timeTo: "12:00" }, { weekday: 1, timeFrom: "08:00", timeTo: "16:00" }] }, null);
    expect(await settings.listPickupTimes()).toEqual([
      { weekday: 1, timeFrom: "08:00", timeTo: "16:00" },
      { weekday: 5, timeFrom: "09:00", timeTo: "12:00" },
    ]);
    await settings.replacePickupTimes({ pickupTimes: [] }, null);
    expect(await settings.listPickupTimes()).toEqual([]);
  });

  it("skips a full-day holiday but not a short day when finding the next pickup", async () => {
    await enableFreight();
    expect((await settings.nextPickup())?.date).toBe("2030-01-07");
    await db.insert(holidays).values({ date: "2030-01-07", name: "Påhittad helgdag" });
    expect((await settings.nextPickup())?.date).toBe("2030-01-08");
  });

  it("requires enabled + key for the provider, only the key for a connection test", async () => {
    await expect(settings.provider({ requireEnabled: true })).rejects.toMatchObject({ reason: "disabled" });
    await expect(settings.testConnection()).rejects.toMatchObject({ reason: "no-key" });
    await settings.update({ apiKey: "k1", environment: "production" }, null);
    expect(await settings.testConnection()).toEqual({ team: "Testteam" });
    expect(configs).toEqual([{ environment: "production", apiKey: "k1" }]);
    await expect(settings.provider({ requireEnabled: true })).rejects.toBeInstanceOf(FreightNotConfiguredError);
  });

  it("tests the key typed in the form without saving it, else the saved key", async () => {
    const seen: { environment: string; apiKey: string }[] = [];
    const recording = createFreightSettingsService({
      repo,
      audit,
      providerFactory: (config) => {
        seen.push(config);
        return fake.provider;
      },
    });
    await recording.update({ apiKey: "saved-key", environment: "sandbox" }, null);
    await recording.testConnection({ apiKey: "typed-key", environment: "production" });
    expect(seen.at(-1)).toEqual({ environment: "production", apiKey: "typed-key" });
    await recording.testConnection({ environment: "production" });
    expect(seen.at(-1)).toEqual({ environment: "production", apiKey: "saved-key" });
    await recording.testConnection();
    expect(seen.at(-1)).toEqual({ environment: "sandbox", apiKey: "saved-key" });
    expect(await repo.readFreightSettings().then((r) => r.get("freight_api_key"))).toBe("saved-key");
  });

  it("fills the product register from a sample shipment and removes it again", async () => {
    await enableFreight();
    expect(await settings.fetchProducts(null)).toEqual({ created: 2, total: 2 });
    expect(await settings.fetchProducts(null)).toEqual({ created: 0, total: 2 });
    expect(fake.calls.filter((c) => c.method === "deleteShipment")).toHaveLength(2);
    expect((await settings.listProducts()).map((p) => p.productName)).toEqual(["DHL Paket", "UPS Express"]);
  });

  it("builds the sender from company info and the sender contact settings", async () => {
    await enableFreight({ freight_sender_contact_name: "Lagret", freight_sender_phone: "" });
    expect(await settings.sender()).toEqual({
      senderName: "Vi AB",
      senderAddressLine1: "Fabriksvägen 1",
      senderAddressLine2: null,
      senderPostalCode: "41107",
      senderCity: "Göteborg",
      senderCountry: "SE",
      senderContactName: "Lagret",
      senderPhone: "031-123456",
      senderEmail: "frakt@vi.example",
    });
  });
});

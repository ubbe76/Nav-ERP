import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPrices, customers, db } from "@navet/db";
import { fromSek, type OrderRowConfiguration } from "@navet/shared";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import {
  ExchangeRateUnavailableError,
  type ExchangeRateLookup,
  type ExchangeRateReader,
} from "../src/modules/system/service/exchange-rates.js";
import { makeVariantService } from "./helpers/configurator.js";
import { buildToOrder, buildVariants, configurator, resetConfiguredRows, salesService } from "./helpers/configured-rows.js";

// Valuta steg 3: the configurator's prices in the order's currency — a
// beställningsvara row and a variant row on an order in EUR, and evaluate
// with a currency (the customer's by default, at today's rate).

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

const TODAY = new Date().toLocaleDateString("sv-SE");
const stubRates = new Map<string, number>();
const lookups: string[] = [];
const rates: ExchangeRateReader = {
  async getRate(currency, date): Promise<ExchangeRateLookup> {
    lookups.push(`${currency} ${date}`);
    const rate = stubRates.get(currency);
    if (rate === undefined) throw new ExchangeRateUnavailableError(currency, date);
    return { currency, requestedDate: date, date, rate, source: "riksbank" };
  },
};
// The evaluate routes' service: the customer's currency and today's rate.
const evaluating = makeVariantService({
  prices: (q) => resolvePrice(db, q),
  rates,
  customerCurrency: async (id) => (await db.select({ currency: customers.currency }).from(customers).where(eq(customers.id, id)))[0]?.currency ?? null,
});

const eurCustomer = () => salesService.createCustomer({ name: "Euro Kund GmbH", active: true, currency: "EUR" } as never);
const SEL = { LOCK: "B", AVLOPP: true, BREDD: 1200 };
const cfgOf = (row: { configuration: unknown }) => row.configuration as OrderRowConfiguration;

beforeEach(() => {
  stubRates.clear();
  lookups.length = 0;
});

describe("beställningsvara i valuta", () => {
  it("the template's base and every addition are converted with the order's rate", async () => {
    const { article } = await buildToOrder();
    const customer = await eurCustomer();
    const { order } = await salesService.createQuote(
      { customerId: customer.id, exchangeRate: 10, rows: [{ articleId: article.id, quantity: 2, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    // 1 000 + 50 + 100 SEK at 10 SEK/EUR.
    expect(Number(row!.unitPrice)).toBe(115);
    expect(cfgOf(row!).price).toMatchObject({ base: 100, unitPrice: 115, source: "article" });
    expect(cfgOf(row!).price.additions.map((a) => a.amount)).toEqual([5, 10]);

    // A quantity change re-evaluates in the same currency.
    const { row: updated } = await salesService.updateRow(order.id, row!.id, { quantity: 3 });
    expect(Number(updated.unitPrice)).toBe(115);
    // Ändra konfiguration too.
    const { row: changed } = await salesService.setRowConfiguration(order.id, row!.id, { selection: { LOCK: "A", BREDD: 800 } });
    expect(Number(changed.unitPrice)).toBe(100);
  });

  it("the customer's särpris on the template is in the customer's currency — only the additions are converted", async () => {
    const { article } = await buildToOrder();
    const customer = await eurCustomer();
    await db.insert(customerPrices).values({ customerId: customer.id, articleId: article.id, fromQuantity: "1", unitPrice: "90" });
    const { order } = await salesService.createQuote(
      { customerId: customer.id, exchangeRate: 10, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    expect(Number(row!.unitPrice)).toBe(105);
    expect(cfgOf(row!).price).toMatchObject({ base: 90, source: "customer_article" });
  });

  it("a variant without agreements of its own takes the template's chain in the order's currency", async () => {
    const { template } = await buildVariants();
    const { article: variant } = await configurator.resolveVariant(template.id, { LOCK: "B", BREDD: 1200 }, null);
    const customer = await eurCustomer();
    const { rows } = await salesService.createQuote({ customerId: customer.id, exchangeRate: 10, rows: [{ articleId: variant.id, quantity: 1 }] } as never, null);
    expect(Number(rows[0]!.unitPrice)).toBe(105);
    // The same variant in SEK for the same customer: SEK prices.
    const sek = await salesService.createQuote({ customerId: customer.id, currency: "SEK", rows: [{ articleId: variant.id, quantity: 1 }] } as never, null);
    expect(Number(sek.rows[0]!.unitPrice)).toBe(1050);
  });
});

describe("evaluate i valuta", () => {
  it("defaults to the customer's currency at today's rate and says so", async () => {
    const { article } = await buildToOrder();
    const customer = await eurCustomer();
    stubRates.set("EUR", 11.131);
    const result = await evaluating.evaluatePublic(article.id, { selection: SEL, customerId: customer.id, quantity: 1 }, { client: false });
    expect(result).toMatchObject({ currency: "EUR", exchangeRate: 11.131, valid: true });
    expect(result.price.base).toBe(fromSek(1000, 11.131));
    expect(result.price.additions.map((a) => a.amount)).toEqual([fromSek(50, 11.131), fromSek(100, 11.131)]);
    expect(lookups).toEqual([`EUR ${TODAY}`]);
  });

  it("an explicit currency/rate wins; no customer means SEK; no rate is ExchangeRateUnavailableError", async () => {
    const { article } = await buildToOrder();
    const customer = await eurCustomer();
    const sek = await evaluating.evaluatePublic(article.id, { selection: SEL, customerId: customer.id, quantity: 1, currency: "SEK" }, { client: false });
    expect(sek).toMatchObject({ currency: "SEK", exchangeRate: 1, price: { base: 1000, unitPrice: 1150 } });
    const plain = await evaluating.evaluatePublic(article.id, { selection: SEL, quantity: 1 }, { client: false });
    expect(plain).toMatchObject({ currency: "SEK", price: { unitPrice: 1150 } });
    const typed = await evaluating.evaluatePublic(article.id, { selection: SEL, quantity: 1, currency: "EUR", exchangeRate: 10 }, { client: false });
    expect(typed).toMatchObject({ currency: "EUR", exchangeRate: 10, price: { unitPrice: 115 } });
    expect(lookups).toEqual([]);
    await expect(evaluating.evaluatePublic(article.id, { selection: SEL, customerId: customer.id, quantity: 1 }, { client: false })).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError
    );
  });

  it("derive prices the evaluation in the currency too; the costing stays SEK", async () => {
    const { article } = await buildToOrder();
    const derived = await evaluating.derive(article.id, { selection: SEL, quantity: 1, currency: "EUR", exchangeRate: 10 });
    expect(derived.evaluation).toMatchObject({ currency: "EUR", exchangeRate: 10, price: { unitPrice: 115 } });
  });
});

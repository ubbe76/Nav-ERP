import { randomUUID } from "node:crypto";
import type { StoredRates } from "@navet/db";
import { SALES_ORDER_EDITABLE_STATUSES, type ParcelInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { productKey, type ShippingRepository } from "../repository/shipping.repository.js";
import { BROKERS, type BrokerName } from "./freight-provider.js";
import type { FreightSettingsService } from "./freight-settings.service.js";
import { suggestParcels } from "./parcels.js";
import { pickupProblem, requestedPickupTime } from "./pickup.js";
import { customerPriceFor } from "./pricing.js";
import { buildProviderShipment } from "./provider-shipment.js";
import { resolveRecipient } from "./recipient.js";
import { missingForBooking } from "./shipment-validation.js";
import {
  FreightCurrencyError,
  FreightNotConfiguredError,
  FreightOrderNotFoundError,
  FreightOrderStatusError,
  FreightPickupDayError,
  FreightRateNotFoundError,
  FreightValidationError,
  FreightPriceMissingError,
} from "./shipping.errors.js";
import { toRatesView } from "./shipping.views.js";

// Frakt på offert och kundorder: Sendify's prices for what an order still has
// to ship, and the freight row the user picks. The broker shipment is only a
// price probe — created, priced and deleted again. Rows are picked by id from
// the answer stored on the order; a client never sends a price.

export interface SalesFreightWriter {
  setFreightRow(orderId: string, input: { articleId: string; unitPrice: number }, userId?: string | null): Promise<unknown>;
  listRows(orderId: string): Promise<unknown>;
}

// The sales module's edit whitelist — a quote that has given an order
// (ordered) is still a quote and gets its freight like one.
const EDITABLE: ReadonlySet<string> = new Set(SALES_ORDER_EDITABLE_STATUSES);

export function createFreightQuoteService<S extends SalesFreightWriter>(deps: {
  repo: ShippingRepository;
  settings: FreightSettingsService;
  sales: S;
  audit: AuditWriter;
  now?: () => Date;
}) {
  const { repo, settings, sales, audit } = deps;
  const now = deps.now ?? (() => new Date());

  // The order in an editable status plus the freight settings it was checked
  // against — read once, so a caller never re-reads them mid-call.
  async function editableOrder(orderId: string) {
    const freight = await settings.read();
    if (!freight.enabled) throw new FreightNotConfiguredError("disabled");
    const order = await repo.findOrderForFreight(orderId);
    if (!order) throw new FreightOrderNotFoundError(orderId);
    if (!EDITABLE.has(order.status)) throw new FreightOrderStatusError();
    return { order, freight };
  }

  return {
    async get(orderId: string) {
      const order = await repo.findOrderForFreight(orderId);
      if (!order) throw new FreightOrderNotFoundError(orderId);
      const freight = await settings.read();
      const product = order.freightProductId ? await repo.findFreightProduct(order.freightProductId) : null;
      return {
        freightProduct: product ? { id: product.id, carrierName: product.carrierName, productName: product.productName } : null,
        carrierPrice: order.freightCarrierPrice === null ? null : Number(order.freightCarrierPrice),
        rates: order.freightQuote ? toRatesView(order.freightQuote, freight) : null,
      };
    },

    async suggestParcels(orderId: string) {
      const { order, freight } = await editableOrder(orderId);
      // The freight row is never goods to pack, whatever type the configured
      // freight article has (a "purchased" one with dimensions would
      // otherwise become a parcel).
      const quantities = (await repo.orderRowQuantities(order.id)).filter((q) => q.articleId !== freight.freightArticleId);
      const { articles, packageTypes } = await repo.loadParcelInputs(quantities.map((q) => q.articleId));
      return suggestParcels(quantities, new Map(articles.map((a) => [a.id, a])), new Map(packageTypes.map((p) => [p.id, p])));
    },

    // "Kontrollera fraktpris": validate, probe the broker, store the answer on
    // the order. The probe is deleted whatever happens after it was created.
    async fetchRates(orderId: string, parcels: ParcelInput[]) {
      const { order } = await editableOrder(orderId);
      // The order's probe goes to Förvald förmedlare (else the first one on).
      const broker = await settings.brokerFor(null);
      if (!broker) throw new FreightNotConfiguredError("disabled");
      const provider = await settings.provider({ requireEnabled: true, broker });
      const recipient = resolveRecipient(
        await repo.recipientSource(order.customerId, order.deliveryAddressId, {
          customerOrderNumber: order.customerOrderNumber,
          customerReference: order.customerReference,
        })
      );
      const sender = await settings.sender();
      const missing = missingForBooking({ ...recipient, ...sender }, parcels);
      if (missing.length > 0) throw new FreightValidationError(missing);
      const slot = await settings.nextPickup();
      if (!slot) {
        throw new FreightPickupDayError(
          "Ingen upphämtningsdag de närmaste 14 dagarna — kontrollera upphämtningstiderna under System → Frakt"
        );
      }
      const today = settings.today();
      const problem = pickupProblem(slot, slot, today);
      if (problem) throw new FreightPickupDayError(problem);
      const time = requestedPickupTime(slot, today)!;

      const probe = buildProviderShipment(recipient, sender, parcels, {
        referenceId: order.orderNumber,
        senderReference: order.orderNumber,
        receiverReference: recipient.receiverReference,
      });
      const id = provider.remoteDrafts ? await provider.createShipment(probe) : null;
      let stored: StoredRates;
      try {
        const { rates, warnings } = await provider.getRates({ remoteId: id, shipment: probe, pickup: { date: slot.date, time } });
        // Stored WITHOUT the booking tokens: the probe is deleted below so
        // they are dead, and the sales module returns freight_quote raw on
        // every order read — a token must never leave the API.
        stored = {
          broker,
          fetchedAt: now().toISOString(),
          warnings,
          rates: rates.map(({ bookingToken: _token, ...r }) => ({ id: randomUUID(), ...r })),
        };
        await repo.upsertFreightProducts(provider.name, rates);
        await repo.saveOrderFreightQuote(order.id, stored);
      } finally {
        if (id) await provider.deleteShipment(id).catch(() => undefined);
      }
      return toRatesView(stored, await settings.read());
    },

    // "Lägg till frakt": the chosen rate becomes the order's freight row at
    // the customer price; the carrier's product and price are remembered for
    // the booking later.
    async addFreight(orderId: string, rateId: string, userId: string | null) {
      const { order, freight } = await editableOrder(orderId);
      if (!freight.freightArticleId) throw new FreightNotConfiguredError("no-article");
      const rate = order.freightQuote?.rates.find((r) => r.id === rateId);
      if (!rate) throw new FreightRateNotFoundError();
      if (rate.currency !== "SEK") throw new FreightCurrencyError();
      if (rate.price === null) throw new FreightPriceMissingError();
      // The broker the probe went to (Sendify on a probe from before 0221).
      const broker = (BROKERS as readonly string[]).includes(order.freightQuote?.broker ?? "")
        ? (order.freightQuote!.broker as BrokerName)
        : "sendify";
      const { ids } = await repo.upsertFreightProducts(broker, [rate]);
      const productId = ids.get(productKey(rate));
      // The upsert keys its ids by the same productKey, so a miss means the
      // two have drifted apart — fail loudly rather than silently skip the
      // product link.
      if (!productId) throw new Error(`upsertFreightProducts returned no id for ${productKey(rate)}`);
      const customerPrice = customerPriceFor(rate.price, freight.markupPercent, freight.markupAmount);
      // Two "Lägg till frakt" at once: setFreightRow finds-or-adds the
      // freight row under the order's lock, so the second call reprices the
      // first one's row instead of adding another.
      await sales.setFreightRow(order.id, { articleId: freight.freightArticleId, unitPrice: customerPrice }, userId);
      await repo.setOrderFreightProduct(order.id, productId, rate.price);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "freight_added",
        detail: { carrier: rate.carrierName, product: rate.productName, carrierPrice: rate.price, customerPrice },
        userId,
      });
      return sales.listRows(order.id) as ReturnType<S["listRows"]>;
    },
  };
}

export type FreightQuoteService = ReturnType<typeof createFreightQuoteService>;

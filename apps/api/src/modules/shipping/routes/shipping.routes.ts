import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  addOrderFreightSchema,
  addShipmentDeliverySchema,
  bookShipmentSchema,
  createShipmentSchema,
  listShipmentsQuerySchema,
  openDeliveriesQuerySchema,
  orderFreightRatesSchema,
  pickupTimesSchema,
  replaceParcelsSchema,
  saveSelectionSchema,
  testFreightConnectionSchema,
  updateFreightSettingsSchema,
  updateShipmentSchema,
} from "@navet/shared";
import { FreightAlreadyInvoicedError, FreightRowDeliveredError } from "../../sales/service/sales.errors.js";
import { InvalidStatusTransitionError, SalesOrderNotFoundError } from "../../sales/service/sales.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { FreightProviderError } from "../service/freight-provider.js";
import type { FreightQuoteService } from "../service/freight-quote.service.js";
import type { FreightSettingsService } from "../service/freight-settings.service.js";
import type { ShippingService } from "../service/shipping.service.js";
import type { TrackingService } from "../service/tracking.service.js";
import {
  DeliveryAlreadyShippedError,
  ShipmentDeliveryUndoneError,
  FreightBookingInProgressError,
  FreightBookingTakenOverError,
  FreightCancelInProgressError,
  FreightCancelRefusedError,
  FreightCurrencyError,
  FreightNoSelectionError,
  FreightNotConfiguredError,
  FreightOrderNotFoundError,
  FreightOrderStatusError,
  FreightPickupDayError,
  FreightPriceChangedError,
  FreightProductUnavailableError,
  FreightRateNotFoundError,
  FreightRatesExpiredError,
  FreightShipmentChangedError,
  FreightValidationError,
  InvalidFreightArticleError,
  InvalidShipmentStatusError,
  MixedCustomersError,
  ShipmentDeliveryNotFoundError,
  ShipmentFileNotFoundError,
  ShipmentNeedsDeliveryError,
  ShipmentNotFoundError,
  ShipmentOnDraftInvoiceError,
} from "../service/shipping.errors.js";

// The broker refused our data → 400; it refused our key → 409 (a settings
// problem, not a transport one); everything else (unavailable,
// booking-unknown, unexpected) → 502.
function providerErrorStatus(kind: FreightProviderError["kind"]): number {
  if (kind === "validation") return 400;
  if (kind === "unauthorized") return 409;
  return 502;
}

// One mapping for every shipping route — domain error → status + envelope
// (with the extra fields the web needs: fieldErrors, rates, prices).
export function mapShippingError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof FreightProviderError) {
    return reply
      .code(providerErrorStatus(err.kind))
      .send({ ...errorBody(err), kind: err.kind, fieldErrors: err.fieldErrors, requestId: err.requestId });
  }
  if (err instanceof FreightValidationError) return reply.code(400).send({ ...errorBody(err), fieldErrors: err.fieldErrors });
  if (err instanceof FreightRatesExpiredError || err instanceof FreightProductUnavailableError) {
    return reply.code(409).send({ ...errorBody(err), rates: err.rates });
  }
  if (err instanceof FreightPriceChangedError) {
    return reply.code(409).send({ ...errorBody(err), savedPrice: err.savedPrice, newPrice: err.newPrice, currency: err.currency });
  }
  if (
    err instanceof ShipmentNotFoundError ||
    err instanceof ShipmentDeliveryNotFoundError ||
    err instanceof ShipmentFileNotFoundError ||
    err instanceof FreightOrderNotFoundError ||
    err instanceof SalesOrderNotFoundError
  ) {
    return reply.code(404).send(errorBody(err));
  }
  if (
    err instanceof MixedCustomersError ||
    err instanceof ShipmentNeedsDeliveryError ||
    err instanceof FreightPickupDayError ||
    err instanceof FreightNoSelectionError ||
    err instanceof FreightCurrencyError ||
    err instanceof InvalidFreightArticleError
  ) {
    return reply.code(400).send(errorBody(err));
  }
  if (
    err instanceof InvalidShipmentStatusError ||
    err instanceof DeliveryAlreadyShippedError ||
    err instanceof ShipmentDeliveryUndoneError ||
    err instanceof FreightNotConfiguredError ||
    err instanceof FreightBookingInProgressError ||
    err instanceof FreightBookingTakenOverError ||
    err instanceof FreightRateNotFoundError ||
    err instanceof FreightShipmentChangedError ||
    err instanceof FreightCancelRefusedError ||
    // Frakt-uppföljning: another Avboka holds the cancel reservation.
    err instanceof FreightCancelInProgressError ||
    // Frakt etapp 2: Avboka with the freight on a draft invoice.
    err instanceof ShipmentOnDraftInvoiceError ||
    // Frakt på offert: the order's status/row rules, raised by the sales
    // service underneath addFreight.
    err instanceof FreightOrderStatusError ||
    err instanceof FreightRowDeliveredError ||
    err instanceof FreightAlreadyInvoicedError ||
    err instanceof InvalidStatusTransitionError
  ) {
    return reply.code(409).send(errorBody(err));
  }
  return null;
}

const ADMIN = { config: { access: ["admin"] as const } };

// A non-uuid in :id would otherwise surface as a Postgres error (500).
const idParams = z.object({ id: z.string().uuid() });
const idDeliveryParams = z.object({ id: z.string().uuid(), deliveryId: z.string().uuid() });
const idFileParams = z.object({ id: z.string().uuid(), fileId: z.string().uuid() });

// Frakt (Sendify). Registered under registerModule with read: office,
// write: forsaljning; the settings routes are admin-only overrides. The
// /sales-orders/:id/freight* routes are served from here (subresource from
// the owning module, like /articles/:id/suppliers from purchase).
export async function shippingRoutes(
  app: FastifyInstance,
  opts: { settings: FreightSettingsService; service: ShippingService; quotes: FreightQuoteService; tracking: TrackingService }
) {
  const { settings, service, quotes, tracking } = opts;

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      const sent = mapShippingError(reply, err);
      if (sent) return sent;
      throw err;
    }
  }

  app.get("/freight-settings/status", async () => settings.status());
  app.get("/freight-products", async () => settings.listProducts());

  app.get("/freight-settings", ADMIN, async () => settings.view());
  app.patch("/freight-settings", ADMIN, async (req, reply) => {
    const input = updateFreightSettingsSchema.parse(req.body);
    return run(reply, () => settings.update(input, req.user!.id));
  });
  app.get("/freight-settings/pickup-times", ADMIN, async () => settings.listPickupTimes());
  app.put("/freight-settings/pickup-times", ADMIN, async (req, reply) => {
    const input = pickupTimesSchema.parse(req.body);
    return run(reply, () => settings.replacePickupTimes(input, req.user!.id));
  });
  app.post("/freight-settings/test", ADMIN, async (req, reply) => run(reply, () => settings.testConnection(testFreightConnectionSchema.parse(req.body ?? {}))));
  app.post("/freight-settings/fetch-products", ADMIN, async (req, reply) =>
    run(reply, () => settings.fetchProducts(req.user!.id))
  );

  // --- Försändelser ---

  app.get("/shipments", async (req) => service.list(listShipmentsQuerySchema.parse(req.query)));

  app.get("/shipments/open-deliveries", async (req) => {
    const { customerId } = openDeliveriesQuerySchema.parse(req.query);
    return service.listOpenDeliveries(customerId);
  });

  app.get("/shipments/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.get(id));
  });

  app.post("/shipments", async (req, reply) => {
    const input = createShipmentSchema.parse(req.body);
    return run(reply, async () => reply.code(201).send(await service.create(input, req.user!.id)));
  });

  app.patch("/shipments/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = updateShipmentSchema.parse(req.body);
    return run(reply, () => service.update(id, input, req.user!.id));
  });

  app.put("/shipments/:id/parcels", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { parcels } = replaceParcelsSchema.parse(req.body);
    return run(reply, () => service.replaceParcels(id, parcels));
  });

  app.post("/shipments/:id/parcels/suggest", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.suggestParcels(id));
  });

  app.post("/shipments/:id/deliveries", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { deliveryId } = addShipmentDeliverySchema.parse(req.body);
    return run(reply, () => service.addDelivery(id, deliveryId, req.user!.id));
  });

  app.delete("/shipments/:id/deliveries/:deliveryId", async (req, reply) => {
    const { id, deliveryId } = idDeliveryParams.parse(req.params);
    return run(reply, () => service.removeDelivery(id, deliveryId, req.user!.id));
  });

  app.delete("/shipments/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, async () => {
      await service.remove(id, req.user!.id);
      return reply.code(204).send();
    });
  });

  // --- Priser, val, bokning ---

  app.post("/shipments/:id/rates", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.fetchRates(id));
  });

  app.post("/shipments/:id/selection", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { rateId } = saveSelectionSchema.parse(req.body);
    return run(reply, () => service.saveSelection(id, rateId));
  });

  app.post("/shipments/:id/book", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = bookShipmentSchema.parse(req.body);
    return run(reply, () => service.book(id, input, req.user!.id));
  });

  app.post("/shipments/:id/documents", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.fetchDocuments(id));
  });

  app.post("/shipments/:id/cancel", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.cancel(id, req.user!.id));
  });

  // "Uppdatera spårning" (etapp 2): fetch the broker's events now and answer
  // with the refreshed card.
  app.post("/shipments/:id/tracking", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, async () => {
      await tracking.trackShipment(id);
      return service.get(id);
    });
  });

  app.get("/shipments/:id/files/:fileId", async (req, reply) => {
    const { id, fileId } = idFileParams.parse(req.params);
    return run(reply, async () => {
      const file = await service.getFile(id, fileId);
      reply.header("Content-Type", file.contentType);
      reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
      return reply.send(file.data);
    });
  });

  // --- Frakt på offert och kundorder ---

  app.get("/sales-orders/:id/freight", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => quotes.get(id));
  });

  app.get("/sales-orders/:id/freight-parcels", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => quotes.suggestParcels(id));
  });

  // "Kontrollera fraktpris"
  app.post("/sales-orders/:id/freight-rates", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { parcels } = orderFreightRatesSchema.parse(req.body);
    return run(reply, () => quotes.fetchRates(id, parcels));
  });

  // "Lägg till frakt"
  app.post("/sales-orders/:id/freight", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { rateId } = addOrderFreightSchema.parse(req.body);
    return run(reply, () => quotes.addFreight(id, rateId, req.user!.id));
  });
}

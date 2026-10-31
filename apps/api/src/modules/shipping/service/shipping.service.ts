import { randomUUID } from "node:crypto";
import type { StoredRate, StoredRates, Tx } from "@navet/db";
import type { BookShipmentInput, CreateShipmentInput, ListShipmentsQuery, ParcelInput, UpdateShipmentInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  isActiveLinkViolation,
  productKey,
  type NewShipment,
  type ShipmentRow,
  type ShippingRepository,
} from "../repository/shipping.repository.js";
import { FreightProviderError, type FreightProvider, type ProviderShipment } from "./freight-provider.js";
import type { FreightSettings, FreightSettingsService, SenderParty } from "./freight-settings.service.js";
import { suggestParcels } from "./parcels.js";
import { pickupProblem, requestedPickupTime } from "./pickup.js";
import { customerPriceFor, priceChangeExceeds } from "./pricing.js";
import { buildProviderShipment } from "./provider-shipment.js";
import { resolveRecipient, senderReferenceFor } from "./recipient.js";
import { missingForBooking } from "./shipment-validation.js";
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
  FreightPickupDayError,
  FreightPriceChangedError,
  FreightProductUnavailableError,
  FreightRateNotFoundError,
  FreightRatesExpiredError,
  FreightShipmentChangedError,
  FreightValidationError,
  InvalidShipmentStatusError,
  MixedCustomersError,
  ShipmentDeliveryNotFoundError,
  ShipmentFileNotFoundError,
  ShipmentNeedsDeliveryError,
  ShipmentNotFoundError,
  ShipmentOnDraftInvoiceError,
} from "./shipping.errors.js";
import { toDetailView, toRatesView } from "./shipping.views.js";

// Försändelse — status flow draft → booked → delivered, cancelled from
// draft/booked. Every transition and every "only in draft" rule lives here.
// No transaction is ever held open over an HTTP call to the provider.

// A booking reservation older than this is treated as abandoned.
export const BOOKING_STALE_MS = 2 * 60 * 1000;
// Same for a cancel reservation (cancel_started_at) — the invoice side's
// assertShipmentsBillable hard-codes the same 2 minutes.
export const CANCEL_STALE_MS = 2 * 60 * 1000;

const STATUS_TEXT: Record<ShipmentRow["status"], string> = {
  draft: "ett utkast",
  booked: "bokad",
  delivered: "levererad",
  cancelled: "avbruten",
};

const RECIPIENT_KEYS = [
  "recipientName",
  "recipientAddressLine1",
  "recipientAddressLine2",
  "recipientPostalCode",
  "recipientCity",
  "recipientCountry",
  "recipientContactName",
  "recipientPhone",
  "recipientEmail",
  "recipientPrivatePerson",
  "receiverReference",
] as const;

// Any change to what is shipped makes earlier prices meaningless.
const STALE_RATES = { lastRates: null, ratesFetchedAt: null } satisfies Partial<NewShipment>;

// Document types we store, with the Swedish file name stem.
const DOCUMENTS: Record<string, string> = { label: "Etikett", waybill: "Fraktsedel" };

type ParcelRow = Awaited<ReturnType<ShippingRepository["listParcels"]>>[number];

function toProviderShipment(s: ShipmentRow, sender: SenderParty, parcels: ParcelRow[]): ProviderShipment {
  return buildProviderShipment(s, sender, parcels, {
    referenceId: s.shipmentNumber,
    senderReference: s.senderReference,
    receiverReference: s.receiverReference,
  });
}

export function createShippingService(deps: {
  repo: ShippingRepository;
  settings: FreightSettingsService;
  audit: AuditWriter;
  now?: () => Date;
}) {
  const { repo, settings, audit } = deps;
  const now = deps.now ?? (() => new Date());

  const bookingInProgress = (s: Pick<ShipmentRow, "bookingStartedAt">) =>
    s.bookingStartedAt !== null && now().getTime() - s.bookingStartedAt.getTime() < BOOKING_STALE_MS;

  function assertDraft(s: ShipmentRow) {
    if (s.status !== "draft") {
      throw new InvalidShipmentStatusError(`Försändelsen är ${STATUS_TEXT[s.status]} och kan inte ändras`);
    }
    if (bookingInProgress(s)) throw new FreightBookingInProgressError();
  }

  // Locks the row (FOR UPDATE — the booking claim waits for us) and checks
  // that it is an editable draft before running `fn`.
  async function withDraft<T>(id: string, fn: (tx: Tx, s: ShipmentRow) => Promise<T>): Promise<T> {
    return repo.transaction(async (tx) => {
      const s = await repo.lockShipment(tx, id);
      if (!s) throw new ShipmentNotFoundError(id);
      assertDraft(s);
      return fn(tx, s);
    });
  }

  async function assertNotShipped(deliveryIds: string[]) {
    const [live] = await repo.liveShipmentsForDeliveries(deliveryIds);
    if (live) throw new DeliveryAlreadyShippedError(live.deliveryNumber, live.shipmentNumber);
  }

  async function suggestFor(deliveryIds: string[]) {
    const quantities = await repo.deliveredQuantities(deliveryIds);
    const { articles, packageTypes } = await repo.loadParcelInputs(quantities.map((q) => q.articleId));
    return suggestParcels(
      quantities,
      new Map(articles.map((a) => [a.id, a])),
      new Map(packageTypes.map((p) => [p.id, p]))
    );
  }

  // After the set of följesedlar changed: fresh kolliförslag, the derived
  // avsändarreferens (unless typed by hand), stale rates dropped.
  async function refreshFromDeliveries(tx: Tx, s: ShipmentRow) {
    const links = (await repo.shipmentDeliveries(s.id, tx)).filter((l) => l.active);
    const { parcels, warnings } = await suggestFor(links.map((l) => l.deliveryId));
    await repo.replaceParcels(tx, s.id, parcels);
    await repo.updateShipment(tx, s.id, {
      ...STALE_RATES,
      ...(s.senderReferenceManual ? {} : { senderReference: senderReferenceFor(links.map((l) => l.deliveryNumber)) }),
    });
    return warnings;
  }

  async function get(id: string) {
    const s = await repo.findShipment(id);
    if (!s) throw new ShipmentNotFoundError(id);
    const [links, parcels, files, trackingEvents, invoice, customerName, product, freight, configuredPickup] = await Promise.all([
      repo.shipmentDeliveries(id),
      repo.listParcels(id),
      repo.listFiles(id),
      repo.listTrackingEvents(id),
      repo.invoiceForShipment(id),
      repo.customerName(s.customerId),
      s.freightProductId ? repo.findFreightProduct(s.freightProductId) : Promise.resolve(null),
      settings.read(),
      s.status === "draft" ? settings.pickupFor(s.pickupDate) : Promise.resolve(null),
    ]);
    return toDetailView(s, {
      customerName: customerName ?? "",
      product,
      links,
      parcels,
      files,
      trackingEvents,
      invoice,
      bookingInProgress: bookingInProgress(s),
      pickupWarning:
        s.status === "draft"
          ? pickupProblem({ date: s.pickupDate, timeFrom: s.pickupFrom, timeTo: s.pickupTo }, configuredPickup, settings.today())
          : null,
      markup: freight,
    });
  }

  const isExpired = (rate: StoredRate) => rate.expiresAt !== null && Date.parse(rate.expiresAt) <= now().getTime();

  // Validate, push the shipment to the broker (create once, then update),
  // fetch rates and store them. Caller has checked status/claim.
  async function fetchRatesFor(s: ShipmentRow, provider: FreightProvider): Promise<StoredRates> {
    const sender = await settings.sender();
    const parcels = await repo.listParcels(s.id);
    const missing = missingForBooking({ ...s, ...sender }, parcels.map((p) => ({ weightKg: Number(p.weightKg) })));
    if (missing.length > 0) throw new FreightValidationError(missing);
    const today = settings.today();
    const storedSlot = { date: s.pickupDate, timeFrom: s.pickupFrom, timeTo: s.pickupTo };
    const problem = pickupProblem(storedSlot, await settings.pickupFor(s.pickupDate), today);
    if (problem) throw new FreightPickupDayError(problem);
    const pickupTime = requestedPickupTime(storedSlot, today)!;

    const payload = toProviderShipment(s, sender, parcels);
    let providerId = s.providerShipmentId;
    // No lock is held over the broker calls, so the final write is optimistic:
    // it lands only if the draft still has the updated_at we read (saving the
    // broker id below does not bump it). Under book()'s claim edits are
    // blocked and the claim itself does not touch updated_at, so it passes.
    if (providerId) {
      await provider.updateShipment(providerId, payload);
    } else {
      providerId = await provider.createShipment(payload);
      // Saved at once: a later failure must not orphan the broker's copy.
      await repo.saveProviderShipmentId(s.id, providerId);
    }
    const { rates, warnings } = await provider.getRates(providerId, { date: s.pickupDate, time: pickupTime });
    const stored: StoredRates = {
      fetchedAt: now().toISOString(),
      warnings,
      rates: rates.map((r) => ({ id: randomUUID(), ...r })),
    };
    await repo.transaction(async (tx) => {
      await repo.upsertFreightProducts(provider.name, rates, tx);
      const written = await repo.storeRates(tx, s.id, s.updatedAt, { ...sender, providerShipmentId: providerId, lastRates: stored, ratesFetchedAt: now() });
      if (!written) throw new FreightShipmentChangedError();
    });
    return stored;
  }

  // Fetch the label/waybill the broker offered for the booking (label only
  // when it named nothing we know) and store them, replacing earlier copies.
  async function storeDocuments(id: string) {
    const s = await repo.findShipment(id);
    if (!s?.providerShipmentId) return;
    const provider = await settings.provider({ requireEnabled: false });
    const offered = s.documentTypes.filter((t) => t in DOCUMENTS);
    for (const type of offered.length > 0 ? offered.sort() : ["label"]) {
      const pdf = await provider.fetchDocument(s.providerShipmentId, type);
      await repo.saveFile(id, type, `${DOCUMENTS[type]}-${s.shipmentNumber}.pdf`, pdf);
    }
  }

  const priceFor = (price: number, freight: FreightSettings) =>
    String(customerPriceFor(price, freight.markupPercent, freight.markupAmount));

  return {
    get,

    async list(query: ListShipmentsQuery) {
      return repo.listShipments(query);
    },

    async listOpenDeliveries(customerId: string) {
      return repo.listOpenDeliveries(customerId);
    },

    async create(input: CreateShipmentInput, userId: string | null) {
      const freight = await settings.read();
      if (!freight.enabled) throw new FreightNotConfiguredError("disabled");
      const ids = [...new Set(input.deliveryIds)];
      const found = await repo.findDeliveries(ids);
      const ordered = ids.map((id) => {
        const d = found.find((f) => f.id === id);
        if (!d) throw new ShipmentDeliveryNotFoundError(id);
        return d;
      });
      if (new Set(ordered.map((d) => d.customerId)).size > 1) throw new MixedCustomersError();
      const undone = ordered.find((d) => !d.live);
      if (undone) throw new ShipmentDeliveryUndoneError(undone.deliveryNumber);
      await assertNotShipped(ids);

      const slot = await settings.nextPickup();
      if (!slot) {
        throw new FreightPickupDayError(
          "Ingen upphämtningsdag de närmaste 14 dagarna — kontrollera upphämtningstiderna under System → Frakt"
        );
      }
      const first = ordered[0]!;
      const recipient = resolveRecipient(
        await repo.recipientSource(first.customerId, first.deliveryAddressId, {
          customerOrderNumber: first.customerOrderNumber,
          customerReference: first.customerReference,
        })
      );
      const sender = await settings.sender();
      // Frakt på offert: the product chosen on the (first) order, and Sendify's
      // price then, become this shipment's selection — "Boka vald produkt"
      // works at once and its price check compares against what was quoted.
      const quotedOrder = await repo.findOrderForFreight(first.orderId);
      const quoted =
        quotedOrder?.freightProductId && quotedOrder.freightCarrierPrice !== null
          ? {
              freightProductId: quotedOrder.freightProductId,
              carrierPrice: quotedOrder.freightCarrierPrice,
              carrierCurrency: "SEK",
              customerPrice: priceFor(Number(quotedOrder.freightCarrierPrice), freight),
            }
          : // Förval: otherwise the customer's förvalda fraktprodukt — without a
            // price, so "Boka vald produkt" books it with no price check
            // against an old quote.
            first.customerDefaultFreightProductId
            ? { freightProductId: first.customerDefaultFreightProductId }
            : {};
      const { parcels, warnings } = await suggestFor(ids);
      const shipmentNumber = await repo.nextShipmentNumber();

      let id: string;
      try {
        id = await repo.insertShipment(
          {
            shipmentNumber,
            customerId: first.customerId,
            ...recipient,
            ...sender,
            ...quoted,
            senderReference: senderReferenceFor(ordered.map((d) => d.deliveryNumber)),
            pickupDate: slot.date,
            pickupFrom: slot.timeFrom,
            pickupTo: slot.timeTo,
            createdBy: userId,
          },
          ids,
          parcels
        );
      } catch (err) {
        // Lost a race against another create for the same följesedel.
        if (isActiveLinkViolation(err)) await assertNotShipped(ids);
        throw err;
      }
      await audit.log({
        entityType: "shipment",
        entityId: id,
        action: "created",
        detail: { shipmentNumber, deliveries: ordered.map((d) => d.deliveryNumber) },
        userId,
      });
      return { shipment: await get(id), warnings };
    },

    async update(id: string, input: UpdateShipmentInput, _userId: string | null) {
      const priceOnly = Object.keys(input).every((k) => k === "customerPrice");
      const freight = await settings.read();
      let slot: { date: string; timeFrom: string; timeTo: string } | null = null;
      if (input.pickupDate !== undefined) {
        if (input.pickupDate < settings.today().date) throw new FreightPickupDayError("Upphämtningsdatumet har passerat");
        slot = await settings.pickupFor(input.pickupDate);
        if (!slot) throw new FreightPickupDayError(`Ingen upphämtning ${input.pickupDate} — välj en annan dag`);
      }

      await repo.transaction(async (tx) => {
        const s = await repo.lockShipment(tx, id);
        if (!s) throw new ShipmentNotFoundError(id);
        if (priceOnly) {
          if (s.status === "cancelled") throw new InvalidShipmentStatusError("En avbruten försändelse kan inte ändras");
        } else {
          assertDraft(s);
        }

        const patch: Partial<NewShipment> = {};
        for (const key of RECIPIENT_KEYS) {
          if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
        }
        if (input.senderReference !== undefined) {
          if (input.senderReference === null) {
            const links = (await repo.shipmentDeliveries(id, tx)).filter((l) => l.active);
            patch.senderReference = senderReferenceFor(links.map((l) => l.deliveryNumber));
            patch.senderReferenceManual = false;
          } else {
            patch.senderReference = input.senderReference;
            patch.senderReferenceManual = true;
          }
        }
        if (slot) {
          patch.pickupDate = slot.date;
          patch.pickupFrom = slot.timeFrom;
          patch.pickupTo = slot.timeTo;
        }
        if (input.pickupFrom !== undefined) patch.pickupFrom = input.pickupFrom;
        if (input.pickupTo !== undefined) patch.pickupTo = input.pickupTo;
        const from = (patch.pickupFrom ?? s.pickupFrom).slice(0, 5);
        const to = (patch.pickupTo ?? s.pickupTo).slice(0, 5);
        if (from >= to) throw new FreightPickupDayError("Upphämtningens Från måste vara före Till");

        if (input.customerPrice !== undefined) {
          if (input.customerPrice === null) {
            patch.customerPriceManual = false;
            patch.customerPrice =
              s.carrierPrice !== null && s.carrierCurrency === "SEK"
                ? String(customerPriceFor(Number(s.carrierPrice), freight.markupPercent, freight.markupAmount))
                : null;
          } else {
            patch.customerPriceManual = true;
            patch.customerPrice = String(input.customerPrice);
          }
        }
        if (!priceOnly) Object.assign(patch, STALE_RATES);
        await repo.updateShipment(tx, id, patch);
      });
      return get(id);
    },

    async replaceParcels(id: string, parcels: ParcelInput[]) {
      await withDraft(id, async (tx) => {
        await repo.replaceParcels(tx, id, parcels);
        await repo.updateShipment(tx, id, STALE_RATES);
      });
      return get(id);
    },

    async suggestParcels(id: string) {
      const warnings = await withDraft(id, (tx, s) => refreshFromDeliveries(tx, s));
      return { shipment: await get(id), warnings };
    },

    async addDelivery(id: string, deliveryId: string, userId: string | null) {
      const [delivery] = await repo.findDeliveries([deliveryId]);
      if (!delivery) throw new ShipmentDeliveryNotFoundError(deliveryId);
      if (!delivery.live) throw new ShipmentDeliveryUndoneError(delivery.deliveryNumber);
      await assertNotShipped([deliveryId]);
      let warnings: string[];
      try {
        warnings = await withDraft(id, async (tx, s) => {
          if (s.customerId !== delivery.customerId) throw new MixedCustomersError();
          await repo.addDeliveryLink(tx, id, deliveryId);
          return refreshFromDeliveries(tx, s);
        });
      } catch (err) {
        if (isActiveLinkViolation(err)) await assertNotShipped([deliveryId]);
        throw err;
      }
      await audit.log({ entityType: "shipment", entityId: id, action: "delivery_added", detail: { delivery: delivery.deliveryNumber }, userId });
      return { shipment: await get(id), warnings };
    },

    async removeDelivery(id: string, deliveryId: string, userId: string | null) {
      const { warnings, deliveryNumber } = await withDraft(id, async (tx, s) => {
        const links = (await repo.shipmentDeliveries(id, tx)).filter((l) => l.active);
        const link = links.find((l) => l.deliveryId === deliveryId);
        if (!link) throw new ShipmentDeliveryNotFoundError(deliveryId);
        if (links.length === 1) throw new ShipmentNeedsDeliveryError();
        await repo.removeDeliveryLink(tx, id, deliveryId);
        return { warnings: await refreshFromDeliveries(tx, s), deliveryNumber: link.deliveryNumber };
      });
      await audit.log({ entityType: "shipment", entityId: id, action: "delivery_removed", detail: { delivery: deliveryNumber }, userId });
      return { shipment: await get(id), warnings };
    },

    // "Ta bort utkast": only drafts; the broker's copy is deleted best-effort.
    // The delete runs under withDraft's FOR UPDATE so a booking claim cannot
    // slip in between the status check and the delete and get orphaned.
    async remove(id: string, userId: string | null) {
      const s = await withDraft(id, async (tx, row) => {
        await repo.deleteShipment(tx, id);
        return row;
      });
      await audit.log({ entityType: "shipment", entityId: id, action: "deleted", detail: { shipmentNumber: s.shipmentNumber }, userId });
      if (s.providerShipmentId) {
        try {
          await (await settings.provider({ requireEnabled: false })).deleteShipment(s.providerShipmentId);
        } catch {
          // best effort — an orphaned draft at Sendify is harmless
        }
      }
    },

    async getFile(id: string, fileId: string) {
      const file = await repo.getFile(id, fileId);
      if (!file) throw new ShipmentFileNotFoundError(fileId);
      return { filename: file.filename, contentType: file.contentType, data: file.data };
    },

    // --- Priser, val, bokning ---

    async fetchRates(id: string) {
      const provider = await settings.provider({ requireEnabled: true });
      const s = await repo.findShipment(id);
      if (!s) throw new ShipmentNotFoundError(id);
      assertDraft(s);
      const stored = await fetchRatesFor(s, provider);
      return toRatesView(stored, await settings.read());
    },

    // "Spara val": choose a rate without booking. Stored rates only — the
    // client never supplies a price.
    async saveSelection(id: string, rateId: string) {
      const provider = await settings.provider({ requireEnabled: true });
      const freight = await settings.read();
      await withDraft(id, async (tx, s) => {
        const rate = s.lastRates?.rates.find((r) => r.id === rateId);
        if (!rate) throw new FreightRateNotFoundError();
        if (rate.currency !== "SEK") throw new FreightCurrencyError();
        const { ids } = await repo.upsertFreightProducts(provider.name, [rate], tx);
        await repo.updateShipment(tx, id, {
          freightProductId: ids.get(productKey(rate)) ?? null,
          carrierPrice: String(rate.price),
          carrierCurrency: rate.currency,
          ...(s.customerPriceManual ? {} : { customerPrice: priceFor(rate.price, freight) }),
        });
      });
      return get(id);
    },

    async book(id: string, input: BookShipmentInput, userId: string | null) {
      const provider = await settings.provider({ requireEnabled: true });
      const freight = await settings.read();
      const claimed = await repo.claimBooking(id);
      if (!claimed) {
        const s = await repo.findShipment(id);
        if (!s) throw new ShipmentNotFoundError(id);
        if (s.status !== "draft") throw new InvalidShipmentStatusError(`Försändelsen är ${STATUS_TEXT[s.status]} och kan inte bokas`);
        throw new FreightBookingInProgressError();
      }
      // The reservation's own timestamp — every later write is conditional on it.
      const claimedAt = claimed.bookingStartedAt!;

      let rate: StoredRate;
      let booked: { trackingNumber: string | null; documentTypes: string[] };
      try {
        if ("rateId" in input) {
          // Draft edits clear last_rates, so stored rates always describe the
          // shipment as it is now.
          const stored = claimed.lastRates?.rates.find((r) => r.id === input.rateId);
          if (!stored || isExpired(stored)) {
            throw new FreightRatesExpiredError(toRatesView(await fetchRatesFor(claimed, provider), freight));
          }
          rate = stored;
        } else {
          if (!claimed.freightProductId) throw new FreightNoSelectionError();
          const product = await repo.findFreightProduct(claimed.freightProductId);
          const fresh = await fetchRatesFor(claimed, provider);
          const match = product
            ? fresh.rates.find((r) => r.carrierCode === product.carrierCode && r.productName === product.productName)
            : undefined;
          if (!match) throw new FreightProductUnavailableError(toRatesView(fresh, freight));
          if (
            !input.confirmPriceChange &&
            claimed.carrierPrice !== null &&
            priceChangeExceeds(Number(claimed.carrierPrice), match.price, freight.priceChangePercent)
          ) {
            throw new FreightPriceChangedError(Number(claimed.carrierPrice), match.price, match.currency);
          }
          rate = match;
        }
        if (rate.currency !== "SEK") throw new FreightCurrencyError();
        // A shipment's rates always carry the token (only an order's price
        // probe is stored without one); a missing token cannot be booked.
        if (!rate.bookingToken) throw new FreightRateNotFoundError();
        booked = await provider.book(rate.bookingToken);
      } catch (err) {
        await repo.releaseBooking(id, claimedAt);
        throw err;
      }

      // Booked at the broker — from here on the reservation is cleared by
      // markBooked itself. The audit entry goes FIRST, and a DB failure after
      // this point is logged with everything needed to find the booking at
      // Sendify (the claim expires, the draft could otherwise be booked again
      // with no trace of the first transport). Never the API key.
      const trace = {
        shipmentNumber: claimed.shipmentNumber,
        providerShipmentId: claimed.providerShipmentId,
        trackingNumber: booked.trackingNumber,
        carrier: rate.carrierName,
        product: rate.productName,
        price: rate.price,
        currency: rate.currency,
      };
      try {
        await audit.log({ entityType: "shipment", entityId: id, action: "booked", detail: trace, userId });
        const { ids } = await repo.upsertFreightProducts(provider.name, [rate]);
        const marked = await repo.markBooked(id, claimedAt, {
          freightProductId: ids.get(productKey(rate)) ?? null,
          carrierPrice: String(rate.price),
          carrierCurrency: rate.currency,
          derivedCustomerPrice: priceFor(rate.price, freight),
          trackingNumber: booked.trackingNumber,
          documentTypes: booked.documentTypes,
          bookedAt: now(),
          bookedBy: userId,
        });
        if (!marked) {
          // Another booker took the (stale) reservation over meanwhile: the
          // transport Sendify booked for THIS attempt never became the
          // row's — the history says so next to the `booked` row above.
          await audit.log({ entityType: "shipment", entityId: id, action: "booking_taken_over", detail: trace, userId });
          throw new FreightBookingTakenOverError();
        }
      } catch (err) {
        console.error("Transport booked at the broker but the shipment could not be marked booked", {
          ...trace,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const warnings: string[] = [];
      try {
        await storeDocuments(id);
      } catch {
        warnings.push("Fraktsedel och etikett kunde inte hämtas — använd Hämta fraktsedel");
      }
      return { shipment: await get(id), warnings };
    },

    // "Hämta fraktsedel": documents again (after a failed fetch at booking).
    async fetchDocuments(id: string) {
      const s = await repo.findShipment(id);
      if (!s) throw new ShipmentNotFoundError(id);
      if (s.status !== "booked" && s.status !== "delivered") {
        throw new InvalidShipmentStatusError("Fraktsedel finns bara för bokade försändelser");
      }
      await storeDocuments(id);
      return get(id);
    },

    // Avbryt (draft) / Avboka (booked). A booked shipment is cancelled at the
    // broker FIRST; if the broker refuses, nothing changes here.
    async cancel(id: string, userId: string | null) {
      const s = await repo.findShipment(id);
      if (!s) throw new ShipmentNotFoundError(id);
      if (s.status === "draft") {
        await withDraft(id, (tx) => repo.cancelShipment(tx, id));
        if (s.providerShipmentId) {
          try {
            await (await settings.provider({ requireEnabled: false })).deleteShipment(s.providerShipmentId);
          } catch {
            // best effort — an orphaned draft at Sendify is harmless
          }
        }
      } else if (s.status === "booked") {
        // Reserve first: row lock, the draft-invoice rule and the claim in ONE
        // transaction, so an invoice cannot take the freight while Sendify
        // cancels (the invoice side re-checks under FOR SHARE). Issued/paid
        // invoices are left alone (the credit note is the remedy). The provider
        // is resolved BEFORE the claim (as book() does) so a missing key cannot
        // leave the claim set.
        const provider = await settings.provider({ requireEnabled: false });
        const claimedAt = await repo.transaction(async (tx) => {
          const row = await repo.lockShipment(tx, id);
          if (row?.status !== "booked") throw new InvalidShipmentStatusError("Försändelsen ändrades samtidigt — ladda om");
          if (row.cancelStartedAt && now().getTime() - row.cancelStartedAt.getTime() < CANCEL_STALE_MS) {
            throw new FreightCancelInProgressError();
          }
          const invoice = await repo.invoiceForShipment(id, tx);
          if (invoice?.status === "draft") throw new ShipmentOnDraftInvoiceError();
          return repo.claimCancel(tx, id);
        });
        try {
          await provider.cancel(s.providerShipmentId!);
        } catch (err) {
          await repo.releaseCancel(id, claimedAt);
          if (err instanceof FreightProviderError && err.kind === "validation") throw new FreightCancelRefusedError(err.message);
          throw err;
        }
        // Cancelled at the broker. A failure from here keeps the claim, which
        // blocks invoicing until it expires; a retry then succeeds (Task 2:
        // Sendify's cancel is idempotent).
        await repo.transaction(async (tx) => {
          const row = await repo.lockShipment(tx, id);
          if (row?.status !== "booked") throw new InvalidShipmentStatusError("Försändelsen ändrades samtidigt — ladda om");
          await repo.cancelShipment(tx, id);
        });
      } else {
        throw new InvalidShipmentStatusError(`Försändelsen är ${STATUS_TEXT[s.status]} och kan inte avbrytas`);
      }
      await audit.log({ entityType: "shipment", entityId: id, action: "cancelled", detail: { wasBooked: s.status === "booked" }, userId });
      return get(id);
    },

    // ShipmentReader for the sales module (order card + följesedel PDF): the
    // live (non-cancelled) shipment per delivery, if any.
    async shipmentsForDeliveries(deliveryIds: string[]) {
      const rows = await repo.liveShipmentsForDeliveries(deliveryIds);
      return new Map(
        rows.map((r) => [
          r.deliveryId,
          { shipmentId: r.shipmentId, shipmentNumber: r.shipmentNumber, status: r.status, carrierName: r.carrierName, trackingNumber: r.trackingNumber },
        ])
      );
    },
  };
}

export type ShippingService = ReturnType<typeof createShippingService>;

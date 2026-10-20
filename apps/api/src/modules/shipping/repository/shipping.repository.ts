import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import {
  articles,
  companyInfo,
  customerContacts,
  customerDeliveryAddresses,
  customers,
  deliveries,
  deliveryRows,
  freightProducts,
  holidays,
  invoiceRows,
  invoices,
  packageTypes,
  pickupTimes,
  salesOrderRows,
  salesOrders,
  shipmentDeliveries,
  shipmentFiles,
  shipmentParcels,
  shipmentTrackingEvents,
  shipments,
  systemSettings,
  type Db,
  type StoredRates,
  type Tx,
} from "@navet/db";
import { ilikePattern, type ListShipmentsQuery } from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import type { TrackingEvent } from "../service/freight-provider.js";
import type { ParcelArticle, ParcelDraft, ParcelPackageType } from "../service/parcels.js";
import type { RecipientSource } from "../service/recipient.js";
import { ShipmentDeliveryUndoneError } from "../service/shipping.errors.js";

export interface FreightProductKey {
  carrierCode: string;
  carrierName: string;
  productName: string;
}

export const productKey = (p: { carrierCode: string; productName: string }) => `${p.carrierCode}|${p.productName}`;

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

// Etapp 2 — what the latest tracking event sets on the shipment.
export interface TrackingPatch {
  trackingStatus: string | null;
  lastTrackingText: string | null;
  trackingException: boolean;
  trackingUrl: string | null; // null = keep the current url
  trackingCheckedAt: Date;
}

// One tracking run at a time across API processes (see claimTrackingLease);
// the stamp is what runTrackingIfDue reads back through the settings.
const TRACKING_LEASE_KEY = "freight_tracking_lease_until";
const TRACKING_RUN_KEY = "freight_last_tracking_run_at";

const ACTIVE_LINK_CONSTRAINT = "shipment_deliveries_active_delivery_unique";

// A följesedel with at least one row that is not undone (Ångra utleverans).
const hasLiveRows = sql`exists (select 1 from ${deliveryRows} where ${deliveryRows.deliveryId} = ${deliveries.id} and ${deliveryRows.undoneAt} is null)`;

// Inside the link insert's transaction: locks the följesedlar FOR SHARE —
// Ångra utleverans holds FOR UPDATE on the följesedel while it checks for a
// live shipment, so either the undo sees this link or this check sees the
// undo — and refuses one whose rows are all undone.
async function assertDeliveriesLive(tx: Tx, deliveryIds: string[]) {
  if (deliveryIds.length === 0) return;
  const locked = await tx
    .select({ id: deliveries.id, deliveryNumber: deliveries.deliveryNumber })
    .from(deliveries)
    .where(inArray(deliveries.id, deliveryIds))
    .orderBy(asc(deliveries.id))
    .for("share");
  const live = await tx
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(inArray(deliveries.id, deliveryIds), hasLiveRows));
  const liveIds = new Set(live.map((d) => d.id));
  const undone = locked.find((d) => !liveIds.has(d.id));
  if (undone) throw new ShipmentDeliveryUndoneError(undone.deliveryNumber);
}

// The partial unique index fired: the delivery is already in a live shipment.
export function isActiveLinkViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return (e.constraint_name ?? e.cause?.constraint_name) === ACTIVE_LINK_CONSTRAINT;
}

const n = (v: string | null) => (v === null ? null : Number(v));

async function insertParcels(executor: Db | Tx, shipmentId: string, parcels: ParcelDraft[]) {
  if (parcels.length === 0) return;
  await executor.insert(shipmentParcels).values(
    parcels.map((p, i) => ({
      shipmentId,
      position: i + 1,
      parcelKind: p.parcelKind,
      lengthCm: String(p.lengthCm),
      widthCm: String(p.widthCm),
      heightCm: String(p.heightCm),
      weightKg: String(p.weightKg),
      quantity: p.quantity,
      // Sendify always takes a PACKAGE as stackable — store what is sent.
      stackable: p.parcelKind === "package" ? true : p.stackable,
      loadingMeters: p.loadingMeters === null ? null : String(p.loadingMeters),
      description: p.description,
    }))
  );
}

// All DB access of the shipping module. Reads across sales/article/register
// tables directly (like planning's repository) — the shipping module owns no
// writes outside its own tables and the freight_* settings keys.
export function createShippingRepository(db: Db) {
  return {
    // --- Fraktinställningar (system_settings key–value, freight_* keys) ---

    async readFreightSettings(): Promise<Map<string, string>> {
      const rows = await db.select().from(systemSettings).where(like(systemSettings.key, "freight_%"));
      return new Map(rows.map((r) => [r.key, r.value]));
    },

    async setSetting(key: string, value: string) {
      await db
        .insert(systemSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },

    async deleteSetting(key: string) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    },

    async getCompanyInfo() {
      const [row] = await db
        .select({
          name: companyInfo.name,
          address: companyInfo.address,
          postalCode: companyInfo.postalCode,
          city: companyInfo.city,
          phone: companyInfo.phone,
          email: companyInfo.email,
        })
        .from(companyInfo)
        .limit(1);
      return row ?? null;
    },

    async articleExists(id: string) {
      const [row] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, id));
      return row !== undefined;
    },

    // --- Upphämtningstider ---

    async listPickupTimes() {
      return db.select().from(pickupTimes).orderBy(asc(pickupTimes.weekday));
    },

    async replacePickupTimes(rows: { weekday: number; timeFrom: string; timeTo: string }[]) {
      await db.transaction(async (tx) => {
        await tx.delete(pickupTimes);
        if (rows.length > 0) await tx.insert(pickupTimes).values(rows);
      });
    },

    // Heldagshelger (no day schedule) — a short day is a normal pickup day.
    async fullDayHolidays(from: string, to: string): Promise<Set<string>> {
      const rows = await db
        .select({ date: holidays.date })
        .from(holidays)
        .where(and(gte(holidays.date, from), lte(holidays.date, to), isNull(holidays.dayScheduleId)));
      return new Set(rows.map((r) => r.date));
    },

    // --- Transportörsprodukter ---

    async listFreightProducts() {
      return db
        .select()
        .from(freightProducts)
        .orderBy(asc(freightProducts.carrierName), asc(freightProducts.productName));
    },

    async findFreightProduct(id: string) {
      const [row] = await db.select().from(freightProducts).where(eq(freightProducts.id, id));
      return row ?? null;
    },

    // Insert-if-missing, then resolve every key to its id. `created` counts
    // genuinely new products (for "Hämta transportörsprodukter"). The
    // executor defaults to the repository's own db; pass a tx to run inside one.
    async upsertFreightProducts(
      provider: string,
      products: FreightProductKey[],
      executor: Db | Tx = db
    ): Promise<{ created: number; ids: Map<string, string> }> {
      const unique = [...new Map(products.map((p) => [productKey(p), p])).values()];
      if (unique.length === 0) return { created: 0, ids: new Map() };
      const inserted = await executor
        .insert(freightProducts)
        .values(unique.map((p) => ({ provider, carrierCode: p.carrierCode, carrierName: p.carrierName, productName: p.productName })))
        .onConflictDoNothing()
        .returning({ id: freightProducts.id });
      const rows = await executor
        .select()
        .from(freightProducts)
        .where(
          and(
            eq(freightProducts.provider, provider),
            or(...unique.map((p) => and(eq(freightProducts.carrierCode, p.carrierCode), eq(freightProducts.productName, p.productName))))
          )
        );
      return { created: inserted.length, ids: new Map(rows.map((r) => [productKey(r), r.id])) };
    },

    // --- Försändelser ---

    transaction<T>(fn: (tx: Tx) => Promise<T>) {
      return db.transaction(fn);
    },

    // Allocated outside the insert's transaction (same as every series): a
    // failed create burns the number, which is fine for a non-bookkeeping series.
    nextShipmentNumber() {
      return getNextOrderNumber(db, "shipment");
    },

    async findDeliveries(ids: string[]) {
      if (ids.length === 0) return [];
      return db
        .select({
          id: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          deliveredAt: deliveries.deliveredAt,
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          customerId: salesOrders.customerId,
          customerOrderNumber: salesOrders.customerOrderNumber,
          customerReference: salesOrders.customerReference,
          deliveryAddressId: salesOrders.deliveryAddressId,
          customerDefaultFreightProductId: customers.defaultFreightProductId,
          // Ångra utleverans: false once every row is undone.
          live: sql<boolean>`${hasLiveRows}`,
        })
        .from(deliveries)
        .innerJoin(salesOrders, eq(salesOrders.id, deliveries.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(inArray(deliveries.id, ids));
    },

    async liveShipmentsForDeliveries(ids: string[]) {
      if (ids.length === 0) return [];
      return db
        .select({
          deliveryId: shipmentDeliveries.deliveryId,
          deliveryNumber: deliveries.deliveryNumber,
          shipmentId: shipments.id,
          shipmentNumber: shipments.shipmentNumber,
          status: shipments.status,
          carrierName: freightProducts.carrierName,
          trackingNumber: shipments.trackingNumber,
        })
        .from(shipmentDeliveries)
        .innerJoin(shipments, eq(shipments.id, shipmentDeliveries.shipmentId))
        .innerJoin(deliveries, eq(deliveries.id, shipmentDeliveries.deliveryId))
        .leftJoin(freightProducts, eq(freightProducts.id, shipments.freightProductId))
        .where(and(eq(shipmentDeliveries.active, true), inArray(shipmentDeliveries.deliveryId, ids)));
    },

    async listOpenDeliveries(customerId: string) {
      return db
        .select({
          id: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          deliveredAt: deliveries.deliveredAt,
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
        })
        .from(deliveries)
        .innerJoin(salesOrders, eq(salesOrders.id, deliveries.salesOrderId))
        .where(
          and(
            eq(salesOrders.customerId, customerId),
            sql`not exists (select 1 from ${shipmentDeliveries} where ${shipmentDeliveries.deliveryId} = ${deliveries.id} and ${shipmentDeliveries.active})`,
            hasLiveRows
          )
        )
        .orderBy(desc(deliveries.deliveredAt))
        .limit(100);
    },

    // Delivered quantity per article over the given följesedlar (base unit).
    async deliveredQuantities(deliveryIds: string[]) {
      if (deliveryIds.length === 0) return [];
      const rows = await db
        .select({ articleId: salesOrderRows.articleId, quantity: sql<string>`sum(${deliveryRows.quantity})` })
        .from(deliveryRows)
        .innerJoin(salesOrderRows, eq(salesOrderRows.id, deliveryRows.salesOrderRowId))
        // Undone rows (Ångra utleverans) are back in stock, not in the parcel.
        .where(and(inArray(deliveryRows.deliveryId, deliveryIds), isNull(deliveryRows.undoneAt)))
        .groupBy(salesOrderRows.articleId);
      return rows.map((r) => ({ articleId: r.articleId, quantity: Number(r.quantity) }));
    },

    async loadParcelInputs(articleIds: string[]): Promise<{ articles: ParcelArticle[]; packageTypes: ParcelPackageType[] }> {
      if (articleIds.length === 0) return { articles: [], packageTypes: [] };
      const rows = await db
        .select({
          id: articles.id,
          name: articles.name,
          type: articles.type,
          weight: articles.weight,
          length: articles.length,
          width: articles.width,
          height: articles.height,
          parcelKind: articles.parcelKind,
          stackable: articles.stackable,
          loadingMeters: articles.loadingMeters,
          packageTypeId: articles.packageTypeId,
          quantityPerPackage: articles.quantityPerPackage,
        })
        .from(articles)
        .where(inArray(articles.id, articleIds));
      const typeIds = [...new Set(rows.map((r) => r.packageTypeId).filter((id): id is string => id !== null))];
      const types = typeIds.length > 0 ? await db.select().from(packageTypes).where(inArray(packageTypes.id, typeIds)) : [];
      return {
        articles: rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          weight: n(r.weight),
          lengthMm: n(r.length),
          widthMm: n(r.width),
          heightMm: n(r.height),
          parcelKind: r.parcelKind,
          stackable: r.stackable,
          loadingMeters: n(r.loadingMeters),
          packageTypeId: r.packageTypeId,
          quantityPerPackage: n(r.quantityPerPackage),
        })),
        packageTypes: types.map((t) => ({
          id: t.id,
          name: t.name,
          parcelKind: t.parcelKind,
          lengthMm: n(t.lengthMm),
          widthMm: n(t.widthMm),
          heightMm: n(t.heightMm),
          tareWeight: n(t.tareWeight),
          stackable: t.stackable,
          loadingMeters: n(t.loadingMeters),
        })),
      };
    },

    async recipientSource(
      customerId: string,
      deliveryAddressId: string | null,
      order: RecipientSource["order"]
    ): Promise<RecipientSource> {
      const addressColumns = {
        address: customerDeliveryAddresses.address,
        postalCode: customerDeliveryAddresses.postalCode,
        city: customerDeliveryAddresses.city,
        country: customerDeliveryAddresses.country,
      };
      const [[customer], orderAddress, [defaultAddress], [contact]] = await Promise.all([
        db
          .select({
            name: customers.name,
            address: customers.address,
            postalCode: customers.postalCode,
            city: customers.city,
            country: customers.country,
            phone: customers.phone,
            email: customers.email,
            privatePerson: customers.privatePerson,
          })
          .from(customers)
          .where(eq(customers.id, customerId)),
        deliveryAddressId
          ? db
              .select(addressColumns)
              .from(customerDeliveryAddresses)
              .where(and(eq(customerDeliveryAddresses.id, deliveryAddressId), eq(customerDeliveryAddresses.customerId, customerId)))
          : Promise.resolve([]),
        db
          .select(addressColumns)
          .from(customerDeliveryAddresses)
          .where(and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.isDefault, true))),
        db
          .select({ name: customerContacts.name, phone: customerContacts.phone, mobile: customerContacts.mobile, email: customerContacts.email })
          .from(customerContacts)
          .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true))),
      ]);
      return {
        customer: customer!,
        orderAddress: orderAddress[0] ?? null,
        defaultAddress: defaultAddress ?? null,
        primaryContact: contact ?? null,
        order,
      };
    },

    async insertShipment(values: NewShipment, deliveryIds: string[], parcels: ParcelDraft[]): Promise<string> {
      return db.transaction(async (tx) => {
        await assertDeliveriesLive(tx, deliveryIds);
        const [row] = await tx.insert(shipments).values(values).returning({ id: shipments.id });
        await tx.insert(shipmentDeliveries).values(deliveryIds.map((deliveryId) => ({ shipmentId: row!.id, deliveryId })));
        await insertParcels(tx, row!.id, parcels);
        return row!.id;
      });
    },

    async findShipment(id: string, executor: Db | Tx = db) {
      const [row] = await executor.select().from(shipments).where(eq(shipments.id, id));
      return row ?? null;
    },

    async lockShipment(tx: Tx, id: string) {
      const [row] = await tx.select().from(shipments).where(eq(shipments.id, id)).for("update");
      return row ?? null;
    },

    async shipmentDeliveries(id: string, executor: Db | Tx = db) {
      return executor
        .select({
          deliveryId: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          deliveredAt: deliveries.deliveredAt,
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          active: shipmentDeliveries.active,
        })
        .from(shipmentDeliveries)
        .innerJoin(deliveries, eq(deliveries.id, shipmentDeliveries.deliveryId))
        .innerJoin(salesOrders, eq(salesOrders.id, deliveries.salesOrderId))
        .where(eq(shipmentDeliveries.shipmentId, id))
        .orderBy(asc(deliveries.deliveryNumber));
    },

    // Frakt etapp 2: the invoice (if any) billing this shipment — at most one
    // row holds a shipment (invoice_rows_shipment_unique), and a cancelled
    // draft lets go of it, so a hit is always a live draft/issued/paid
    // invoice. Read straight off invoice_rows ⋈ invoices, the same kind of
    // cross-module read this repo already does against deliveries/sales_orders.
    // Takes the caller's tx so cancel() can read it under its FOR UPDATE.
    async invoiceForShipment(id: string, executor: Db | Tx = db) {
      const [row] = await executor
        .select({ invoiceId: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status })
        .from(invoiceRows)
        .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
        .where(and(eq(invoiceRows.shipmentId, id), ne(invoices.status, "cancelled")))
        .limit(1);
      // A cancelled draft has released its row (shipment_id nulled); filtered anyway so the type says so.
      return row ? { ...row, status: row.status as "draft" | "issued" | "paid" } : null;
    },

    async listParcels(id: string, executor: Db | Tx = db) {
      return executor.select().from(shipmentParcels).where(eq(shipmentParcels.shipmentId, id)).orderBy(asc(shipmentParcels.position));
    },

    // Never selects `data`.
    async listFiles(id: string) {
      return db
        .select({
          id: shipmentFiles.id,
          kind: shipmentFiles.kind,
          filename: shipmentFiles.filename,
          contentType: shipmentFiles.contentType,
          sizeBytes: shipmentFiles.sizeBytes,
          createdAt: shipmentFiles.createdAt,
        })
        .from(shipmentFiles)
        .where(eq(shipmentFiles.shipmentId, id))
        .orderBy(asc(shipmentFiles.kind));
    },

    async getFile(shipmentId: string, fileId: string) {
      const [row] = await db
        .select()
        .from(shipmentFiles)
        .where(and(eq(shipmentFiles.shipmentId, shipmentId), eq(shipmentFiles.id, fileId)));
      return row ?? null;
    },

    async customerName(id: string) {
      const [row] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, id));
      return row?.name ?? null;
    },

    async updateShipment(executor: Db | Tx, id: string, patch: Partial<NewShipment>) {
      await executor
        .update(shipments)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(shipments.id, id));
    },

    async replaceParcels(executor: Db | Tx, id: string, parcels: ParcelDraft[]) {
      await executor.delete(shipmentParcels).where(eq(shipmentParcels.shipmentId, id));
      await insertParcels(executor, id, parcels);
    },

    async addDeliveryLink(tx: Tx, shipmentId: string, deliveryId: string) {
      await assertDeliveriesLive(tx, [deliveryId]);
      await tx.insert(shipmentDeliveries).values({ shipmentId, deliveryId });
    },

    async removeDeliveryLink(executor: Db | Tx, shipmentId: string, deliveryId: string) {
      await executor
        .delete(shipmentDeliveries)
        .where(and(eq(shipmentDeliveries.shipmentId, shipmentId), eq(shipmentDeliveries.deliveryId, deliveryId)));
    },

    async deleteShipment(executor: Db | Tx, id: string) {
      await executor.delete(shipments).where(eq(shipments.id, id));
    },

    // --- Bokning ---

    // The broker's id is a technical field, not a draft edit: it deliberately
    // leaves updated_at alone so storeRates' guard still sees any edit made
    // while the broker copy was being created.
    async saveProviderShipmentId(id: string, providerShipmentId: string) {
      await db.update(shipments).set({ providerShipmentId }).where(eq(shipments.id, id));
    },

    // Optimistic write of a price answer: only onto the draft exactly as it
    // was read before the broker calls (updated_at unchanged — every draft
    // edit bumps it and clears last_rates). False = someone edited meanwhile;
    // the quote describes the old shipment and must not be stored. Compared
    // at millisecond precision: a row never written from JS still carries
    // Postgres' microsecond default, which a Date cannot hold.
    async storeRates(tx: Tx, id: string, asReadUpdatedAt: Date, patch: Partial<NewShipment>): Promise<boolean> {
      const rows = await tx
        .update(shipments)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(shipments.id, id),
            eq(shipments.status, "draft"),
            sql`date_trunc('milliseconds', ${shipments.updatedAt}) = ${asReadUpdatedAt.toISOString()}::timestamptz`
          )
        )
        .returning({ id: shipments.id });
      return rows.length === 1;
    },

    // Bokningsreservation: one atomic UPDATE, so two concurrent "Boka" can
    // never both reach the broker. A reservation older than 2 minutes counts
    // as abandoned (BOOKING_STALE_MS in the service). Blocks behind an edit's
    // FOR UPDATE lock, so an edit and a booking never interleave.
    async claimBooking(id: string) {
      const [row] = await db
        .update(shipments)
        .set({ bookingStartedAt: sql`now()` })
        .where(
          and(
            eq(shipments.id, id),
            eq(shipments.status, "draft"),
            or(isNull(shipments.bookingStartedAt), sql`${shipments.bookingStartedAt} < now() - interval '2 minutes'`)
          )
        )
        .returning();
      return row ?? null;
    },

    // Owner-checked like releaseTrackingLease: only the booking that took
    // THIS reservation clears it — a booker that stalled past BOOKING_STALE_MS
    // must not free the reservation a second booker has taken over. Compared
    // at millisecond precision (the Date we hold cannot carry microseconds).
    async releaseBooking(id: string, claimedAt: Date) {
      await db
        .update(shipments)
        .set({ bookingStartedAt: null })
        .where(and(eq(shipments.id, id), sql`date_trunc('milliseconds', ${shipments.bookingStartedAt}) = ${claimedAt.toISOString()}::timestamptz`));
    },

    // Avbokningsreservation — taken inside the caller's transaction, after
    // its FOR UPDATE and its invoice check, so an invoice row cannot slip in
    // between the check and the broker call. Returns the claim's own
    // timestamp for releaseCancel's owner check.
    async claimCancel(tx: Tx, id: string): Promise<Date> {
      const [row] = await tx
        .update(shipments)
        .set({ cancelStartedAt: sql`now()` })
        .where(eq(shipments.id, id))
        .returning({ cancelStartedAt: shipments.cancelStartedAt });
      return row!.cancelStartedAt!;
    },

    // Owner-checked like releaseBooking: only the cancellation that took
    // THIS reservation clears it (millisecond comparison, same reason).
    async releaseCancel(id: string, claimedAt: Date) {
      await db
        .update(shipments)
        .set({ cancelStartedAt: null })
        .where(and(eq(shipments.id, id), sql`date_trunc('milliseconds', ${shipments.cancelStartedAt}) = ${claimedAt.toISOString()}::timestamptz`));
    },

    // The customer price is decided in SQL from the row as it is NOW: a
    // manual price typed while the broker call was in flight (a price-only
    // PATCH is allowed under a reservation) must never be overwritten by the
    // derived one computed from the row we claimed. Owner-checked like
    // releaseBooking: false = the reservation is no longer ours (another
    // booking took it over), so the row must not be marked with our transport.
    async markBooked(
      id: string,
      claimedAt: Date,
      values: Pick<NewShipment, "freightProductId" | "carrierPrice" | "carrierCurrency" | "trackingNumber" | "documentTypes" | "bookedAt" | "bookedBy"> & {
        derivedCustomerPrice: string | null;
      }
    ): Promise<boolean> {
      const { derivedCustomerPrice, ...rest } = values;
      const rows = await db
        .update(shipments)
        .set({
          ...rest,
          customerPrice: sql`case when ${shipments.customerPriceManual} then ${shipments.customerPrice} else ${derivedCustomerPrice}::numeric end`,
          status: "booked",
          bookingStartedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shipments.id, id),
            eq(shipments.status, "draft"),
            sql`date_trunc('milliseconds', ${shipments.bookingStartedAt}) = ${claimedAt.toISOString()}::timestamptz`
          )
        )
        .returning({ id: shipments.id });
      return rows.length === 1;
    },

    // Avbruten: links go inactive (history kept) so the följesedlar can be booked again.
    async cancelShipment(tx: Tx, id: string) {
      await tx
        .update(shipments)
        .set({ status: "cancelled", cancelledAt: new Date(), bookingStartedAt: null, cancelStartedAt: null, updatedAt: new Date() })
        .where(eq(shipments.id, id));
      await tx.update(shipmentDeliveries).set({ active: false }).where(eq(shipmentDeliveries.shipmentId, id));
    },

    async saveFile(shipmentId: string, kind: string, filename: string, data: Buffer) {
      const values = { shipmentId, kind, filename, contentType: "application/pdf", sizeBytes: data.length, data };
      await db
        .insert(shipmentFiles)
        .values(values)
        .onConflictDoUpdate({
          target: [shipmentFiles.shipmentId, shipmentFiles.kind],
          set: { filename, contentType: values.contentType, sizeBytes: values.sizeBytes, data, createdAt: new Date() },
        });
    },

    async listShipments(q: ListShipmentsQuery) {
      const conditions = [];
      if (q.status) conditions.push(eq(shipments.status, q.status));
      if (q.customerId) conditions.push(eq(shipments.customerId, q.customerId));
      if (q.search) {
        const pattern = ilikePattern(q.search);
        conditions.push(
          or(
            ilike(shipments.shipmentNumber, pattern),
            ilike(customers.name, pattern),
            ilike(shipments.trackingNumber, pattern),
            sql`exists (select 1 from ${shipmentDeliveries} sd join ${deliveries} d on d.id = sd.delivery_id where sd.shipment_id = ${shipments.id} and d.delivery_number ilike ${pattern})`
          )!
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const deliveryNumbers = sql<string | null>`(select string_agg(d.delivery_number, ', ' order by d.delivery_number) from ${shipmentDeliveries} sd join ${deliveries} d on d.id = sd.delivery_id where sd.shipment_id = ${shipments.id})`;
      const [rows, totals] = await Promise.all([
        db
          .select({
            id: shipments.id,
            shipmentNumber: shipments.shipmentNumber,
            status: shipments.status,
            customerId: shipments.customerId,
            customerName: customers.name,
            deliveryNumbers,
            carrierName: freightProducts.carrierName,
            productName: freightProducts.productName,
            trackingNumber: shipments.trackingNumber,
            trackingText: shipments.lastTrackingText,
            trackingException: shipments.trackingException,
            deliveredAt: shipments.deliveredAt,
            pickupDate: shipments.pickupDate,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .innerJoin(customers, eq(customers.id, shipments.customerId))
          .leftJoin(freightProducts, eq(freightProducts.id, shipments.freightProductId))
          .where(where)
          .orderBy(desc(shipments.createdAt))
          .limit(q.limit)
          .offset(q.offset),
        db
          .select({ total: count() })
          .from(shipments)
          .innerJoin(customers, eq(customers.id, shipments.customerId))
          .where(where),
      ]);
      return { rows, total: Number(totals[0]?.total ?? 0) };
    },

    // --- Spårning (etapp 2) ---

    // Booked shipments the scheduler polls: a shipment never delivered is
    // not polled forever (bookedAfter = now − TRACKING_MAX_AGE_DAYS).
    async listTrackableShipments(bookedAfter: Date): Promise<string[]> {
      const rows = await db
        .select({ id: shipments.id })
        .from(shipments)
        .where(and(eq(shipments.status, "booked"), isNotNull(shipments.providerShipmentId), gt(shipments.bookedAt, bookedAfter)))
        .orderBy(asc(shipments.bookedAt));
      return rows.map((r) => r.id);
    },

    // One transaction: new events (duplicates ignored by the unique index),
    // the latest-event fields, and — when deliveredAt is given — booked →
    // delivered. The status move is conditional so a shipment cancelled
    // meanwhile stays cancelled (and the caller logs nothing).
    async applyTracking(id: string, events: TrackingEvent[], patch: TrackingPatch, deliveredAt: Date | null): Promise<{ delivered: boolean }> {
      return db.transaction(async (tx) => {
        if (events.length > 0) {
          await tx
            .insert(shipmentTrackingEvents)
            .values(
              events.map((e) => ({
                shipmentId: id,
                occurredAt: new Date(e.occurredAt),
                status: (e.status ?? "").slice(0, 50),
                description: e.description,
                location: e.location?.slice(0, 255) ?? null,
              }))
            )
            .onConflictDoNothing();
        }
        const { trackingUrl, trackingStatus, ...rest } = patch;
        await tx
          .update(shipments)
          // Same width as the event rows above (varchar(50)): an over-long
          // broker status must never make every later poll fail.
          .set({ ...rest, trackingStatus: trackingStatus?.slice(0, 50) ?? null, ...(trackingUrl ? { trackingUrl } : {}) })
          .where(eq(shipments.id, id));
        if (!deliveredAt) return { delivered: false };
        const moved = await tx
          .update(shipments)
          .set({ status: "delivered", deliveredAt, updatedAt: new Date() })
          .where(and(eq(shipments.id, id), eq(shipments.status, "booked")))
          .returning({ id: shipments.id });
        return { delivered: moved.length > 0 };
      });
    },

    // Newest first, as the card shows them.
    async listTrackingEvents(id: string) {
      return db
        .select({
          occurredAt: shipmentTrackingEvents.occurredAt,
          status: shipmentTrackingEvents.status,
          description: shipmentTrackingEvents.description,
          location: shipmentTrackingEvents.location,
        })
        .from(shipmentTrackingEvents)
        .where(eq(shipmentTrackingEvents.shipmentId, id))
        .orderBy(desc(shipmentTrackingEvents.occurredAt));
    },

    // One tracking run at a time across API processes: an atomic upsert that
    // only lands when there is no lease or it has expired. (A session-level
    // advisory lock would need a reserved connection, which @navet/db does
    // not expose.)
    // Returns the lease value it wrote (the holder's token for the release),
    // or null when another run holds a live lease.
    async claimTrackingLease(now: Date, ttlMs: number): Promise<string | null> {
      const until = new Date(now.getTime() + ttlMs).toISOString();
      const rows = await db.execute(sql`
        INSERT INTO system_settings (key, value) VALUES (${TRACKING_LEASE_KEY}, ${until})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        WHERE system_settings.value = '' OR system_settings.value::timestamptz <= ${now.toISOString()}::timestamptz
        RETURNING key`);
      return rows.length > 0 ? until : null;
    },

    // Only the run that wrote `until` releases: a run that stalled past its
    // lease and wakes up after another run took over must not free the live
    // lease underneath that run.
    async releaseTrackingLease(until: string) {
      await db
        .delete(systemSettings)
        .where(and(eq(systemSettings.key, TRACKING_LEASE_KEY), eq(systemSettings.value, until)));
    },

    async stampTrackingRun(at: Date) {
      await db
        .insert(systemSettings)
        .values({ key: TRACKING_RUN_KEY, value: at.toISOString() })
        .onConflictDoUpdate({ target: systemSettings.key, set: { value: at.toISOString() } });
    },

    // --- Frakt på offert ---

    async findOrderForFreight(orderId: string) {
      const [row] = await db
        .select({
          id: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          status: salesOrders.status,
          customerId: salesOrders.customerId,
          deliveryAddressId: salesOrders.deliveryAddressId,
          customerOrderNumber: salesOrders.customerOrderNumber,
          customerReference: salesOrders.customerReference,
          freightProductId: salesOrders.freightProductId,
          freightCarrierPrice: salesOrders.freightCarrierPrice,
          freightQuote: salesOrders.freightQuote,
        })
        .from(salesOrders)
        .where(eq(salesOrders.id, orderId));
      return row ?? null;
    },

    // What is still to be shipped: ordered − delivered per row (base unit).
    async orderRowQuantities(orderId: string) {
      const rows = await db
        .select({ articleId: salesOrderRows.articleId, ordered: salesOrderRows.quantityOrdered, delivered: salesOrderRows.quantityDelivered })
        .from(salesOrderRows)
        .where(eq(salesOrderRows.salesOrderId, orderId));
      return rows
        .map((r) => ({ articleId: r.articleId, quantity: Number(r.ordered) - Number(r.delivered) }))
        .filter((r) => r.quantity > 0);
    },

    // Deliberately no updated_at/revision bump on these two: the price answer
    // and the chosen product are not document content — the freight row
    // itself bumps the revision through sales' setFreightRow.
    async saveOrderFreightQuote(orderId: string, quote: StoredRates) {
      await db.update(salesOrders).set({ freightQuote: quote }).where(eq(salesOrders.id, orderId));
    },

    async setOrderFreightProduct(orderId: string, productId: string, carrierPrice: number) {
      await db
        .update(salesOrders)
        .set({ freightProductId: productId, freightCarrierPrice: String(carrierPrice) })
        .where(eq(salesOrders.id, orderId));
    },
  };
}

export type ShippingRepository = ReturnType<typeof createShippingRepository>;

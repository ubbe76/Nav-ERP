// Domain errors for C3 Kundpriser: the price-list register (price_lists /
// price_list_rows) and the price-resolution chain (Task 7). The rest of the
// sales module's error classes grew organically inside sales.service.ts, but
// this fresh area of the module gets to start with the separate-file
// convention already used by stock.errors.ts — repo and service both import
// from here without a service -> repository dependency.

export class PriceListNotFoundError extends Error {
  constructor(id: string) {
    super(`Price list ${id} not found`);
    this.name = "PriceListNotFoundError";
  }
}

// code and name are both unique columns on price_lists — a 23505 doesn't say
// which one collided, so the message names whichever value(s) the caller
// actually supplied (create always has both; update may have only one).
export class DuplicatePriceListError extends Error {
  constructor(code?: string, name?: string) {
    const parts = [code ? `code "${code}"` : null, name ? `name "${name}"` : null].filter(
      (p): p is string => p !== null
    );
    super(`A price list with ${parts.join(" or ")} already exists`);
    this.name = "DuplicatePriceListError";
  }
}

// A customer still points at this list (customers.price_list_id, FK
// onDelete: "restrict") — the FK is the race-proof guarantee, this is just
// the friendly 409 ahead of it (same shape as StockLocationNotEmptyError).
export class PriceListInUseError extends Error {
  constructor(code: string) {
    super(`Price list "${code}" is assigned to a customer and cannot be deleted`);
    this.name = "PriceListInUseError";
  }
}

// (price_list_id, article_id, from_quantity) is unique — article_id and
// price_list_id never change on an update, so a 23505 here always comes from
// the from_quantity the caller just set.
export class DuplicatePriceListRowError extends Error {
  constructor(fromQuantity: number) {
    super(`This price list already has a row for this article at from-quantity ${fromQuantity}`);
    this.name = "DuplicatePriceListRowError";
  }
}

export class PriceListRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Price list row ${id} not found`);
    this.name = "PriceListRowNotFoundError";
  }
}

// Thrown by the price-resolution chain (price-resolver.ts / Task 7's
// consumer) when no level yields a price at all. Defined here now, ahead of
// Task 7, so that module doesn't need to touch this file's boundary later.
export class PriceNotFoundError extends Error {
  constructor(articleNumber: string) {
    super(`No price found for article ${articleNumber}`);
    this.name = "PriceNotFoundError";
  }
}

// (customer_id, article_id, from_quantity) / (customer_id, article_group_id,
// from_quantity) are the two partial unique indexes on customer_prices — the
// target never changes on an update, so a 23505 here always comes from the
// from_quantity the caller just set (mirrors DuplicatePriceListRowError).
export class DuplicateCustomerPriceError extends Error {
  constructor(fromQuantity: number) {
    super(`This customer already has a price rule for this article/group at from-quantity ${fromQuantity}`);
    this.name = "DuplicateCustomerPriceError";
  }
}

export class DuplicateCustomerArticleNumberError extends Error {
  constructor() {
    super("This customer already has an article number for this article");
    this.name = "DuplicateCustomerArticleNumberError";
  }
}

export class CustomerArticleNumberNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer article number ${id} not found`);
    this.name = "CustomerArticleNumberNotFoundError";
  }
}

export class CustomerPriceNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer price ${id} not found`);
    this.name = "CustomerPriceNotFoundError";
  }
}

// E3 (KO→TO-koppling): manufacturing_orders.sales_order_row_id is FK
// onDelete: "restrict" — a row with a linked MO can't be deleted. The FK
// doesn't care about the MO's status (same "kopplingen är historik"
// reasoning as everywhere else the link is read), so a row whose only link
// is to a cancelled MO is blocked too. Mapped from the 23503 the repo's
// delete throws (same shape as PriceListInUseError, but caught rather than
// pre-checked since there's no cheap existence check worth the extra
// query).
export class RowHasManufacturingOrdersError extends Error {
  constructor() {
    super("Cannot delete a row that has linked manufacturing orders");
    this.name = "RowHasManufacturingOrdersError";
  }
}

// Frakt på offert: "Lägg till frakt" never reprices a freight row that has
// already gone out with a delivery — the user sees why instead of a silent
// mismatch between invoice and delivery.
export class FreightRowDeliveredError extends Error {
  constructor() {
    super("Fraktraden är redan levererad och kan inte ändras");
    this.name = "FreightRowDeliveredError";
  }
}

// Frakt etapp 2: the order's freight is already billed through a shipment
// row on an invoice (invoice_rows.shipment_id, via a live följesedel link) —
// "Lägg till frakt" would bill the same transport a second time through the
// order row. The mirror of listInvoiceableShipments' "order already carries
// the freight article" exclusion, so the rule holds in both directions.
export class FreightAlreadyInvoicedError extends Error {
  constructor(shipmentNumber: string) {
    super(`Frakten för ordern är redan fakturerad via försändelse ${shipmentNumber} — ingen fraktrad läggs till`);
    this.name = "FreightAlreadyInvoicedError";
  }
}

// Frakt etapp 2: a customer's förvalda fraktprodukt must name an existing
// freight product. It's a field value on the customer's own create/update,
// so a 400 (like an unknown priceListId), not a 404.
export class InvalidFreightProductError extends Error {
  constructor() {
    super("Fraktprodukten finns inte");
    this.name = "InvalidFreightProductError";
  }
}

// Frakt-uppföljning: re-checked under the shipment's row lock inside the
// invoice's own insert transaction — the shipment was cancelled, or its
// cancellation is at the broker right now.
export class ShipmentNotBillableError extends Error {
  constructor(shipmentNumber: string) {
    super(`${shipmentNumber} avbokas eller är avbokad och kan inte faktureras`);
    this.name = "ShipmentNotBillableError";
  }
}

// Konfigurator 4b (beställningsvara på orderraden): a template in mode
// to_order goes on a new row only WITH a configuration — the row has nothing
// to print or build otherwise. 409: the article is right, the row is incomplete.
export class ConfigurationRequiredError extends Error {
  constructor(public articleNumber: string) {
    super(`${articleNumber} är en beställningsvara — konfigurera den`);
    this.name = "ConfigurationRequiredError";
  }
}

// Konfigurator 4b: a configuration on anything that is not a to_order
// template is a malformed row (400), not a state conflict.
// 409: a quantity change on a beställningsvara row whose stored choices the
// template now resolves to another configuration — typically a group added
// later with a förval, whose price addition the row's choices don't show.
// The row is not repriced behind the choices' back: Ändra konfiguration.
export class RowConfigurationOutdatedError extends Error {
  constructor(public articleNumber: string) {
    super(`${articleNumber}: mallen har ändrats sedan raden konfigurerades — använd Ändra konfiguration`);
    this.name = "RowConfigurationOutdatedError";
  }
}

export class ConfigurationNotAllowedError extends Error {
  constructor(public articleNumber: string) {
    super(`${articleNumber} är inte en beställningsvara — konfiguration kan inte anges`);
    this.name = "ConfigurationNotAllowedError";
  }
}

// Ändra konfiguration (4b): the row has moved on — delivered, in a TO,
// invoiced — or the order's status forbids row edits. The reason is part of
// the message because the dialog shows it as is.
export class RowConfigurationLockedError extends Error {
  constructor(reason: string) {
    super(`Konfigurationen kan inte ändras: ${reason}`);
    this.name = "RowConfigurationLockedError";
  }
}

// Konfigurator 4c: the row's configuration changed between the TO's
// derivation and its insert (Ändra konfiguration got there first).
export class RowConfigurationChangedError extends Error {
  constructor() {
    super("Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration");
    this.name = "RowConfigurationChangedError";
  }
}

// The partial unique index sales_order_rows_order_article_unique fired: the
// article already sits on this order as an ordinary row. `variant` is the
// Ändra konfiguration case (the resolved variant is the duplicate); an
// ordinary duplicate row — or a configuration whose variant a plain row
// already has — gets the neutral wording.
export class RowVariantExistsError extends Error {
  constructor(public articleNumber: string, kind: "variant" | "article" = "article") {
    super(`${kind === "variant" ? "Varianten" : "Artikeln"} ${articleNumber} ligger redan som rad på ordern`);
    this.name = "RowVariantExistsError";
  }
}

// Momskoder (spec 4.2): Utfärda refuses an invoice whose rows carry a code
// that requires the buyer's momsregistreringsnummer (EU sales, omvänd
// betalningsskyldighet) when the invoice has none, or one in the wrong form.
// Thrown inside the issue transaction, so the FA number rolls back with it.
// The message is Swedish on purpose (it differs per reason and the web shows
// it as is); `reason` travels in the 409 body.
export type VatNumberRequiredReason = "missing" | "eu_format" | "ob_format";

export class VatNumberRequiredError extends Error {
  constructor(
    public readonly reason: VatNumberRequiredReason,
    public readonly vatCode: string,
    prefix: string | null = null
  ) {
    super(
      reason === "missing"
        ? "Kunden saknar momsregistreringsnummer — det krävs för EU-försäljning och omvänd betalningsskyldighet"
        : reason === "eu_format"
          ? prefix
            ? `Kundens momsregistreringsnummer ska vara ett momsnummer från ett annat EU-land än Sverige, med landskoden först (till exempel ${prefix}) — det krävs för EU-försäljning`
            : "EU-försäljning kräver ett momsregistreringsnummer från ett annat EU-land än Sverige, med landskoden först"
          : "Kundens momsregistreringsnummer ska ha formen SE + tio siffror + 01 för omvänd betalningsskyldighet"
    );
    this.name = "VatNumberRequiredError";
  }
}

// Valuta: the order's currency cannot change once it has rows — their prices
// stand in the old currency. 409 sales-order-currency-locked.
export class SalesOrderCurrencyLockedError extends Error {
  constructor(orderNumber: string) {
    super(`Valutan på ${orderNumber} kan inte ändras när ordern har rader — ta bort raderna först`);
    this.name = "SalesOrderCurrencyLockedError";
  }
}

// Valuta: a new row was priced in the order's currency as it was read, and
// the currency changed (header PATCH on an order without rows) before the
// row was written — re-read the order and add the row again. 409
// sales-order-currency-changed.
export class SalesOrderCurrencyChangedError extends Error {
  constructor(public orderNumber: string, public pricedIn: string, public currency: string) {
    super(`Valutan på ${orderNumber} ändrades till ${currency} medan raden prissattes i ${pricedIn} — lägg till raden igen`);
    this.name = "SalesOrderCurrencyChangedError";
  }
}

// Valuta: a rate other than 1 on a SEK order (or quote request). 400
// sales-order-exchange-rate.
export class SalesOrderExchangeRateError extends Error {
  constructor() {
    super("En order i SEK har alltid kursen 1");
    this.name = "SalesOrderExchangeRateError";
  }
}

// Valuta: a price list's currency cannot change while it has rows — their
// prices are in the old currency. 409 price-list-currency-locked.
export class PriceListCurrencyLockedError extends Error {
  constructor(code: string) {
    super(`Valutan på prislistan ${code} kan inte ändras när listan har rader`);
    this.name = "PriceListCurrencyLockedError";
  }
}

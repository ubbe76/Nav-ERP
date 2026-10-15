import type { RatesView } from "./shipping.views.js";

// Frakt domain errors. Messages are Swedish on purpose: they are shown
// verbatim in the UI (apiErrorMessage falls back to the message when the
// code has no dictionary entry), same as Sendify's own texts.

export class ShipmentNotFoundError extends Error {
  constructor(id: string) {
    super(`Försändelsen hittades inte (${id})`);
    this.name = "ShipmentNotFoundError";
  }
}

export class ShipmentDeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Följesedeln hittades inte (${id})`);
    this.name = "ShipmentDeliveryNotFoundError";
  }
}

export class ShipmentFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Filen hittades inte (${id})`);
    this.name = "ShipmentFileNotFoundError";
  }
}

export class InvalidShipmentStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidShipmentStatusError";
  }
}

export class DeliveryAlreadyShippedError extends Error {
  constructor(
    readonly deliveryNumber: string,
    readonly shipmentNumber: string
  ) {
    super(`Följesedel ${deliveryNumber} ligger redan i försändelse ${shipmentNumber}`);
    this.name = "DeliveryAlreadyShippedError";
  }
}

export class MixedCustomersError extends Error {
  constructor() {
    super("Följesedlarna i en försändelse måste gå till samma kund");
    this.name = "MixedCustomersError";
  }
}

export class ShipmentNeedsDeliveryError extends Error {
  constructor() {
    super("En försändelse måste ha minst en följesedel");
    this.name = "ShipmentNeedsDeliveryError";
  }
}

export class FreightNotConfiguredError extends Error {
  constructor(readonly reason: "disabled" | "no-key" | "no-article") {
    super(
      reason === "disabled"
        ? "Frakten är inte aktiverad — se System → Frakt"
        : reason === "no-key"
          ? "API-nyckel för Sendify saknas — se System → Frakt"
          : "Fraktartikel saknas — se System → Frakt"
    );
    this.name = "FreightNotConfiguredError";
  }
}

// Frakt på offert och kundorder.
export class FreightOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Kundordern hittades inte (${id})`);
    this.name = "FreightOrderNotFoundError";
  }
}

export class FreightOrderStatusError extends Error {
  constructor() {
    super("Frakt kan bara läggas på offert, bekräftad order eller order under tillverkning");
    this.name = "FreightOrderStatusError";
  }
}

export class FreightValidationError extends Error {
  constructor(readonly fieldErrors: string[]) {
    super("Uppgifter saknas för transportbokningen");
    this.name = "FreightValidationError";
  }
}

export class FreightPickupDayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreightPickupDayError";
  }
}

export class FreightBookingInProgressError extends Error {
  constructor() {
    super("Bokning pågår redan för försändelsen");
    this.name = "FreightBookingInProgressError";
  }
}

// The reservation went stale during the broker call and another booking took
// it over: Sendify booked THIS attempt's transport, but the row now belongs to
// the other attempt. book() logs the full trace before throwing this.
export class FreightBookingTakenOverError extends Error {
  constructor() {
    super("Bokningen tog för lång tid och försändelsen bokades om under tiden — kontrollera hos Sendify att transporten inte är dubbelbokad");
    this.name = "FreightBookingTakenOverError";
  }
}

export class FreightRatesExpiredError extends Error {
  constructor(readonly rates: RatesView) {
    super("Priset har gått ut — nya priser har hämtats");
    this.name = "FreightRatesExpiredError";
  }
}

// The draft was edited (and its rates cleared) while the broker was quoting —
// those prices describe the old shipment and are never stored.
export class FreightShipmentChangedError extends Error {
  constructor() {
    super("Försändelsen ändrades under prishämtningen — hämta priser igen");
    this.name = "FreightShipmentChangedError";
  }
}

export class FreightProductUnavailableError extends Error {
  constructor(readonly rates: RatesView) {
    super("Den sparade produkten finns inte bland de nya priserna — välj en annan");
    this.name = "FreightProductUnavailableError";
  }
}

export class FreightPriceChangedError extends Error {
  constructor(
    readonly savedPrice: number,
    readonly newPrice: number,
    readonly currency: string
  ) {
    super("Priset har ändrats sedan valet sparades");
    this.name = "FreightPriceChangedError";
  }
}

export class FreightNoSelectionError extends Error {
  constructor() {
    super("Ingen fraktprodukt är vald — hämta priser och välj en");
    this.name = "FreightNoSelectionError";
  }
}

export class FreightCurrencyError extends Error {
  constructor() {
    super("Bara priser i SEK kan väljas");
    this.name = "FreightCurrencyError";
  }
}

export class FreightRateNotFoundError extends Error {
  constructor() {
    super("Priset finns inte längre — hämta priser igen");
    this.name = "FreightRateNotFoundError";
  }
}

export class FreightCancelRefusedError extends Error {
  constructor(message: string) {
    super(`Sendify avbokade inte: ${message}`);
    this.name = "FreightCancelRefusedError";
  }
}

// Frakt-uppföljning: another Avboka holds the shipment's cancel reservation
// (cancel_started_at younger than CANCEL_STALE_MS) — its broker call is in
// flight, or it died after the broker cancelled and a retry has to wait.
export class FreightCancelInProgressError extends Error {
  constructor() {
    super("Avbokning pågår redan för försändelsen — vänta en stund och ladda om");
    this.name = "FreightCancelInProgressError";
  }
}

// Frakt etapp 2: Avboka while the freight sits on a DRAFT invoice would let
// the draft issue a freight for a transport that never happened — the row
// has to leave the draft first. An issued/paid invoice does not block: the
// credit note is the remedy there.
export class ShipmentOnDraftInvoiceError extends Error {
  constructor() {
    super("Frakten ligger på ett fakturautkast — ta bort fraktraden från utkastet innan du avbokar");
    this.name = "ShipmentOnDraftInvoiceError";
  }
}

export class InvalidFreightArticleError extends Error {
  constructor() {
    super("Fraktartikeln finns inte");
    this.name = "InvalidFreightArticleError";
  }
}

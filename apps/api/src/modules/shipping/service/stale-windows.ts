// How long a booking or cancellation reservation on a shipment is held
// before it counts as abandoned (booking_started_at, cancel_started_at). A
// leaf, so the invoice repository's assertShipmentsBillable reads the same
// window as the shipping service without importing the service.
export const BOOKING_STALE_MS = 2 * 60 * 1000;
export const CANCEL_STALE_MS = 2 * 60 * 1000;

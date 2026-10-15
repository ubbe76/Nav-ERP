import { describe, expect, it } from "vitest";
import { configuredDeliveryWarning } from "../../web/lib/configuredDelivery";

// Konfigurator 4c + delinleverans: delivering a configured KO row warns when
// it goes beyond what its linked TOs have RECEIVED into stock — an open TO's
// delinleverans counts as much as a done one's.
describe("configuredDeliveryWarning", () => {
  const row = (orders: { status: string; quantity: string; quantityReceived: string }[], delivered = 0) => ({
    configuration: { key: "K" },
    quantityDelivered: delivered,
    manufacturingOrders: orders,
  });

  it("does not warn for units an open TO has already received", () => {
    const r = row([{ status: "in_progress", quantity: "10", quantityReceived: "4" }]);
    expect(configuredDeliveryWarning(r, 4)).toBeNull();
    expect(configuredDeliveryWarning(r, 5)).toBe("KO-raden har bara 4 av 5 färdigrapporterade");
  });

  it("counts what a done TO received, not its order quantity", () => {
    const r = row([{ status: "done", quantity: "10", quantityReceived: "9" }], 2);
    expect(configuredDeliveryWarning(r, 7)).toBeNull();
    expect(configuredDeliveryWarning(r, 8)).toBe("KO-raden har bara 9 av 10 färdigrapporterade");
  });

  it("never warns for an unconfigured row or nothing to deliver", () => {
    expect(configuredDeliveryWarning({ ...row([]), configuration: null }, 5)).toBeNull();
    expect(configuredDeliveryWarning(row([]), 0)).toBeNull();
  });
});

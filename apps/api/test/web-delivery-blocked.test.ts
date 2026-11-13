import { describe, expect, it } from "vitest";
import { deliveryBlockedText } from "../../web/lib/deliveryBlocked";

// Utleverans opened with ?order=<id> for an order that is not Under
// tillverkning: the routine says why at once (the deliver endpoint would
// answer 409 invalid-status-transition at Rapportera).
describe("deliveryBlockedText", () => {
  const text = (status: Parameters<typeof deliveryBlockedText>[0]["status"]) =>
    deliveryBlockedText({ orderNumber: "KO-1003", status });

  it("lets an order Under tillverkning through", () => {
    expect(text("in_production")).toBeNull();
  });

  it("tells a Bekräftad order to start production first", () => {
    expect(text("confirmed")).toBe(
      "KO-1003 kan inte levereras ännu — ordern är Bekräftad. Starta tillverkningen på orderkortet först (Starta tillverkning eller Skapa TO), så blir den Under tillverkning."
    );
  });

  it("names quotes, lost quotes and avbrutna orders", () => {
    expect(text("quote")).toBe("KO-1003 är en offert och kan inte levereras. Skapa en kundorder ur offerten först.");
    expect(text("ordered")).toBe("KO-1003 är en offert som redan har blivit order — leverera kundordern som skapades ur den.");
    expect(text("lost")).toBe("KO-1003 är en förlorad offert och kan inte levereras.");
    expect(text("cancelled")).toBe("KO-1003 är avbruten och kan inte levereras.");
  });

  it("gives the status for the rest", () => {
    expect(text("delivered")).toBe(
      "KO-1003 kan inte levereras — ordern är Levererad. Bara ordrar i status Under tillverkning kan levereras."
    );
    expect(text("invoiced")).toBe(
      "KO-1003 kan inte levereras — ordern är Fakturerad. Bara ordrar i status Under tillverkning kan levereras."
    );
  });
});

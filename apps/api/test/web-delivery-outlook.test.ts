import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OUTLOOK_ORDER_STATUSES,
  allocationHref,
  allocationText,
  headLine,
  outlookDate,
  outlookLabel,
  outlookTone,
  uncoveredText,
} from "../../web/lib/deliveryOutlook.js";
import type { OrderOutlook, OutlookAllocation } from "../../web/lib/types.js";

// Leveransläge on the kundorder card: the pure texts and tones
// (apps/web/lib/deliveryOutlook.ts) and the guards on the component. The
// rules themselves are the API's (delivery-outlook.test.ts).

const TODAY = "2026-11-26";
const outlook = (over: Partial<OrderOutlook> = {}): OrderOutlook => ({
  status: "on_time",
  daysLate: 0,
  atRisk: false,
  promisedDate: "2026-12-04",
  estimatedDeliveryDate: "2026-12-04",
  counts: { late: 0, uncovered: 0, undated: 0, componentLate: 0 },
  ...over,
});
const allocation = (over: Partial<OutlookAllocation> = {}): OutlookAllocation => ({
  kind: "manufacturing_order",
  documentId: "mo-1",
  documentNumber: "TO-1050",
  quantity: 5,
  readyDate: "2026-12-03",
  late: false,
  undated: false,
  daysLate: 0,
  isDraft: false,
  componentLate: false,
  ...over,
});

describe("outlookDate", () => {
  it("is day and month, with the year only when it is not today's", () => {
    expect(outlookDate("2026-12-08", TODAY)).toBe("8 dec");
    expect(outlookDate("2026-05-01", TODAY)).toBe("1 maj");
    expect(outlookDate("2027-01-11", TODAY)).toBe("11 jan 2027");
  });
});

describe("the row's pill", () => {
  it("names the four states, with the working days on Sen", () => {
    expect(outlookLabel({ status: "on_time", daysLate: 0 })).toBe("I tid");
    expect(outlookLabel({ status: "late", daysLate: 1 })).toBe("Sen 1 dag");
    expect(outlookLabel({ status: "late", daysLate: 3 })).toBe("Sen 3 dagar");
    // Ready on a Saturday after a Friday need: late without a working day.
    expect(outlookLabel({ status: "late", daysLate: 0 })).toBe("Sen");
    expect(outlookLabel({ status: "uncovered", daysLate: 0 })).toBe("Saknar täckning");
    expect(outlookLabel({ status: "undated", daysLate: 0 })).toBe("Tillgång utan datum");
  });

  it("is red for Sen and Saknar täckning, yellow for Tillgång utan datum, neutral in time", () => {
    expect(outlookTone({ status: "late" })).toBe("stopped");
    expect(outlookTone({ status: "uncovered" })).toBe("stopped");
    expect(outlookTone({ status: "undated" })).toBe("delayed");
    expect(outlookTone({ status: "on_time" })).toBe("draft");
  });
});

describe("headLine", () => {
  it("says the estimated delivery, the promised date and the working days when late", () => {
    expect(headLine(outlook({ status: "late", daysLate: 3, atRisk: true, estimatedDeliveryDate: "2026-12-08" }), TODAY)).toEqual({
      text: "Beräknad leverans 8 dec (lovat 4 dec) · 3 arbetsdagar sen",
      tone: "stopped",
    });
    expect(headLine(outlook({ status: "late", daysLate: 1, estimatedDeliveryDate: "2026-12-07" }), TODAY)!.text).toBe(
      "Beräknad leverans 7 dec (lovat 4 dec) · 1 arbetsdag sen"
    );
    // Another row has no ready day: no date to promise.
    expect(headLine(outlook({ status: "late", daysLate: 2, estimatedDeliveryDate: null }), TODAY)!.text).toBe("Leveransen är 2 arbetsdagar sen (lovat 4 dec)");
  });

  it("in time, uncovered, undated — and nothing for an order without an outlook", () => {
    expect(headLine(outlook(), TODAY)).toEqual({ text: "Leverans i tid (lovat 4 dec)", tone: "draft" });
    expect(headLine(outlook({ promisedDate: null, estimatedDeliveryDate: null }), TODAY)!.text).toBe("Leverans i tid");
    expect(headLine(outlook({ status: "uncovered", counts: { late: 0, uncovered: 1, undated: 0, componentLate: 0 } }), TODAY)).toEqual({
      text: "Saknar täckning på 1 rad",
      tone: "stopped",
    });
    expect(headLine(outlook({ status: "uncovered", counts: { late: 1, uncovered: 2, undated: 0, componentLate: 0 } }), TODAY)!.text).toBe("Saknar täckning på 2 rader");
    expect(headLine(outlook({ status: "undated" }), TODAY)).toEqual({ text: "Kan inte beräknas — tillgång utan datum", tone: "delayed" });
    expect(headLine(outlook({ status: "none" }), TODAY)).toBeNull();
  });
});

describe("allocationText", () => {
  it("stock, a TO with its ready day, a late one, a draft IO, an undated one, Halvfabrikat sent", () => {
    expect(allocationText(allocation({ kind: "stock", documentId: null, documentNumber: null, readyDate: TODAY }), "6 st", TODAY)).toEqual({ label: "Lager", detail: "6 st", late: null });
    expect(allocationText(allocation(), "5 st", TODAY)).toEqual({ label: "TO-1050", detail: "5 st · klar 3 dec", late: null });
    expect(allocationText(allocation({ late: true, daysLate: 2 }), "5 st", TODAY)).toEqual({ label: "TO-1050", detail: "5 st · klar 3 dec", late: "2 dagar för sent" });
    expect(allocationText(allocation({ late: true, daysLate: 1 }), "5 st", TODAY).late).toBe("1 dag för sent");
    expect(allocationText(allocation({ late: true, daysLate: 0 }), "5 st", TODAY).late).toBe("för sent");
    expect(allocationText(allocation({ kind: "purchase_order", documentNumber: "IO-88", readyDate: "2026-12-02", isDraft: true }), "3 m", TODAY)).toEqual({
      label: "IO-88",
      detail: "3 m · 2 dec (utkast)",
      late: null,
    });
    expect(allocationText(allocation({ kind: "purchase_order", documentNumber: "IO-89", readyDate: null, undated: true }), "3 st", TODAY).detail).toBe("3 st · saknar datum");
    expect(allocationText(allocation({ componentLate: true }), "5 st", TODAY).detail).toBe("5 st · klar 3 dec · halvfabrikat sent");
    expect(uncoveredText("4 st")).toBe("Saknas 4 st");
  });

  it("links an IO and a TO to their cards, never the stock", () => {
    expect(allocationHref({ kind: "manufacturing_order", documentId: "m" })).toBe("/tillverkning/ordrar/m");
    expect(allocationHref({ kind: "purchase_order", documentId: "p" })).toBe("/inkop/ordrar/p");
    expect(allocationHref({ kind: "stock", documentId: null })).toBeNull();
  });
});

describe("the component and the card", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");

  it("only an order whose rows are a demand has an outlook", () => {
    expect(OUTLOOK_ORDER_STATUSES).toEqual(["confirmed", "in_production"]);
  });

  it("the card shows it to Försäljning or Tillverkning, on those statuses, and reads it again with the card", () => {
    const card = read("components/sales/SalesOrderDetail.tsx");
    expect(card).toMatch(/const canCheckDelivery = useCan\(\)\(\["forsaljning", "tillverkning"\]\)/);
    expect(card).toMatch(/const showOutlook = canCheckDelivery && OUTLOOK_ORDER_STATUSES\.includes\(order\.status\)/);
    expect(card).toMatch(/useDeliveryOutlook\(order\.id, showOutlook, rows\)/);
  });

  it("the component only reads — one GET, a sequence guard, links through GatedLink, errors through apiErrorMessage", () => {
    const component = read("components/sales/DeliveryOutlook.tsx");
    expect(component.match(/apiFetch</g)).toHaveLength(1);
    expect(component).toMatch(/\/delivery-outlook`\)/);
    expect(component).not.toMatch(/method:/);
    expect(component).toMatch(/seq !== sequence\.current/);
    expect(component).toMatch(/apiErrorMessage\(err, OUTLOOK_ERROR\)/);
    expect(component).toMatch(/<GatedLink href=\{href\}>/);
    expect(component).not.toMatch(/<table|<Table/);
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, DELIVERY_RISK_FILTER, SALES_ORDER_OUTLOOK_STATUSES, salesOrderOutlookText, type SalesOrderListOutlook } from "@navet/shared";
// The web's own files (the web cannot import @navet/shared).
import * as web from "../../web/lib/deliveryRisk.js";
import { MANUFACTURING_ORDER_FILTER, PURCHASE_ORDER_FILTER, QUOTE_FILTER, SALES_ORDER_FILTER } from "../../web/lib/statusFilters.js";
import { OVERVIEW_CARD_ALERT_KIND, OVERVIEW_CARD_HALF, OVERVIEW_CARD_HREF, OVERVIEW_CARD_LABELS, DEFAULT_OVERVIEW_CARDS, overviewCardAvailable } from "../../web/lib/overviewCards.js";
import { ALERT_KIND_CATALOG } from "../src/modules/alerts/service/alert-kinds.js";

// Leverans i fara on the web (leveransläget, etapp 3c): the kundorder list's
// chip and row mark, and Översiktens card. The rules are the API's
// (sales-delivery-risk.test.ts, alerts.integration.test.ts).

const outlook = (status: SalesOrderListOutlook["status"], extra: Partial<SalesOrderListOutlook> = {}): SalesOrderListOutlook => ({
  status,
  daysLate: 0,
  atRisk: status === "late" || status === "uncovered",
  ...extra,
});

describe("the kundorder list's Leverans i fara", () => {
  it("the chip is the API's filter value, on the kundorder list only", () => {
    expect(web.DELIVERY_RISK_FILTER).toBe(DELIVERY_RISK_FILTER);
    expect(SALES_ORDER_FILTER.narrow).toEqual([
      { value: "late", label: "Sen" },
      { value: "delivery_risk", label: "Leverans i fara" },
    ]);
    for (const filter of [QUOTE_FILTER, PURCHASE_ORDER_FILTER, MANUFACTURING_ORDER_FILTER]) {
      expect((filter.narrow ?? []).map((c) => c.value)).not.toContain("delivery_risk");
    }
    // The alert's Öppna listan opens the list with the chip chosen.
    expect(ALERT_KIND_CATALOG.find((d) => d.kind === "sales_order_delivery_risk")!.listHref).toBe(
      `/forsaljning/ordrar?${SALES_ORDER_FILTER.param}=${web.DELIVERY_RISK_FILTER}`
    );
  });

  it("marks only what needs a look, in the card's words and tones", () => {
    expect(web.listOutlookMark(null)).toBeNull();
    expect(web.listOutlookMark(undefined)).toBeNull();
    expect(web.listOutlookMark(outlook("on_time"))).toBeNull();
    expect(web.listOutlookMark(outlook("uncovered"))).toEqual({ label: "Saknar täckning", tone: "stopped" });
    expect(web.listOutlookMark(outlook("late", { daysLate: 3 }))).toEqual({ label: "Sen 3 dagar", tone: "stopped" });
    expect(web.listOutlookMark(outlook("late", { daysLate: 1 }))).toEqual({ label: "Sen 1 dag", tone: "stopped" });
    expect(web.listOutlookMark(outlook("late"))).toEqual({ label: "Sen", tone: "stopped" });
    // Not late itself but at risk: Halvfabrikat sent, yellow.
    expect(web.listOutlookMark(outlook("on_time", { atRisk: true }))).toEqual({ label: "Halvfabrikat sent", tone: "delayed" });
    expect(web.listOutlookMark(outlook("undated", { atRisk: true }))).toEqual({ label: "Halvfabrikat sent", tone: "delayed" });
    // Tillgång utan datum is a mark but not at risk.
    expect(web.listOutlookMark(outlook("undated"))).toEqual({ label: "Tillgång utan datum", tone: "delayed" });
  });

  it("says the same as the CSV column for every outlook", () => {
    expect(web.listOutlookText(null)).toBe(salesOrderOutlookText(null));
    for (const status of SALES_ORDER_OUTLOOK_STATUSES) {
      for (const daysLate of [0, 1, 4]) {
        for (const atRisk of [false, true]) {
          const o = { status, daysLate, atRisk };
          expect(web.listOutlookText(o), JSON.stringify(o)).toBe(salesOrderOutlookText(o));
        }
      }
    }
    expect(salesOrderOutlookText(outlook("on_time"))).toBe("I tid");
  });

  it("only the kundorder list asks the API for the mark (withOutlook is opt-in — the order pickers never pay for it)", () => {
    const root = fileURLToPath(new URL("../../web/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(`${root}${dir}`);
    const asking = files.filter((f) => readFileSync(f, "utf8").includes("withOutlook=true")).map((f) => f.slice(root.length)).sort();
    expect(asking).toEqual(["app/forsaljning/ordrar/page.tsx", "components/sales/SalesOrdersPageClient.tsx", "components/split/splitLists.tsx"]);
    expect(readFileSync(`${root}app/forsaljning/ordrar/page.tsx`, "utf8")).toContain("&kind=order&withOutlook=true");
    expect(readFileSync(`${root}components/split/splitLists.tsx`, "utf8")).toContain('api: "/api/v1/sales-orders?kind=order&withOutlook=true"');
    // The export: the kundorder list's link only (the offert list has no column).
    expect(readFileSync(`${root}components/sales/SalesOrdersPageClient.tsx`, "utf8")).toContain('${isQuote ? "" : "&withOutlook=true"}');
  });
});

describe("Översiktens kort Leverans i fara", () => {
  it("is a half card on the alert kind, gated by the kundorder list and not in the standard", () => {
    expect(OVERVIEW_CARD_LABELS.deliveryRisk).toBe("Leverans i fara");
    expect(OVERVIEW_CARD_HALF.deliveryRisk).toBe(true);
    expect(OVERVIEW_CARD_ALERT_KIND.deliveryRisk).toBe("sales_order_delivery_risk");
    expect(ALERT_KINDS).toContain(OVERVIEW_CARD_ALERT_KIND.deliveryRisk);
    expect(OVERVIEW_CARD_HREF.deliveryRisk).toBe("/forsaljning/ordrar");
    expect(DEFAULT_OVERVIEW_CARDS).not.toContain("deliveryRisk");
    expect(overviewCardAvailable({ role: "user", permissions: ["forsaljning"] }, "deliveryRisk")).toBe(true);
    expect(overviewCardAvailable({ role: "user", permissions: ["inkop"] }, "deliveryRisk")).toBe(false);
  });
});

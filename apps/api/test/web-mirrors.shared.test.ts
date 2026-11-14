import { describe, expect, it } from "vitest";
import * as shared from "@navet/shared";
import { computeLineMargin, sumMargins } from "../src/modules/costing/service/margin.js";
import { einvoiceStatusLabel } from "../src/modules/einvoice/service/einvoice-status.js";
import { freightMode } from "../src/modules/shipping/service/parcels.js";
// The web can't import @navet/shared, so these files hold copies of rules that
// live in packages/shared or the API. The copies are equivalent, not
// byte-for-byte, so this guard compares BEHAVIOUR: web output against the
// original over a spread of inputs, and the constants with toEqual. (Same idea
// as currency-web-mirror.shared.test.ts.) Web files that import React, Next or
// the API client are not loaded here, only their pure parts.
import * as webUnits from "../../web/lib/units.js";
import * as webSales from "../../web/lib/salesDocumentKind.js";
import * as webList from "../../web/lib/listQuery.js";
import * as webFav from "../../web/lib/favorites.js";
import * as webAlerts from "../../web/lib/alerts.js";
import * as webQuality from "../../web/lib/quality.js";
import * as webPlugins from "../../web/lib/plugins.js";
import * as webEinvoice from "../../web/lib/einvoice.js";
import * as webMargin from "../../web/lib/margin.js";
import * as webShipping from "../../web/lib/shipping.js";
import * as webSerials from "../../web/lib/serials.js";
import * as webMailSignature from "../../web/lib/mailSignature.js";

describe("units mirror (apps/web/lib/units.ts)", () => {
  const factors = [null, undefined, "", 0, -2, 1, 0.5, 2, "2", "7.38", 12.5, 0.3, 1000];
  const quantities = [-1, 0, 0.1, 0.2, 1, 2.5, 7, 100, 103.32, 12345.6789];

  it("converts quantities and prices like the shared helpers", () => {
    for (const f of factors)
      for (const q of quantities) {
        expect(webUnits.toBaseQuantity(q, f)).toBe(shared.toBaseQuantity(q, f));
        expect(webUnits.toUnitQuantity(q, f)).toBe(shared.toUnitQuantity(q, f));
        expect(webUnits.toBasePrice(q, f)).toBe(shared.toBasePrice(q, f));
        expect(webUnits.toUnitPrice(q, f)).toBe(shared.toUnitPrice(q, f));
      }
  });

  it("rounds up to a multiple like the one implementation (roundUpToMultiple)", () => {
    for (const step of [...factors, 7.38, 0.001, "0.25", 3])
      for (const q of [...quantities, 0.3, 0.6, 0.9, 7.38, 14.76, 100])
        expect(webUnits.roundUpToMultiple(q, step)).toBe(shared.roundUpToMultiple(q, step));
    expect(webUnits.roundUpToMultiple(0.1 + 0.2, 0.3)).toBe(0.3);
  });

  it("converts operation times like the shared helpers", () => {
    const units = ["minutes_per_unit", "units_per_hour", "seconds_per_unit"] as const;
    for (const v of [0.5, 1, 7, 8.5714, 12, 60, 123.456]) {
      expect(webUnits.unitsPerHourToMinutesPerUnit(v)).toBe(shared.unitsPerHourToMinutesPerUnit(v));
      expect(webUnits.minutesPerUnitToUnitsPerHour(v)).toBe(shared.minutesPerUnitToUnitsPerHour(v));
      expect(webUnits.secondsPerUnitToMinutesPerUnit(v)).toBe(shared.secondsPerUnitToMinutesPerUnit(v));
      expect(webUnits.minutesPerUnitToSecondsPerUnit(v)).toBe(shared.minutesPerUnitToSecondsPerUnit(v));
      for (const u of units) {
        expect(webUnits.runTimeInUnit(v, u)).toBe(shared.runTimeInUnit(v, u));
        expect(webUnits.runTimeToMinutes(v, u)).toBe(shared.runTimeToMinutes(v, u));
      }
    }
  });
});

describe("salesDocumentKind mirror", () => {
  it("derives the same kind for every status and number combination", () => {
    const statuses = shared.salesOrderStatusSchema.options;
    for (const status of statuses)
      for (const quoteNumber of [null, "OF-1", "OF-2"])
        for (const orderNumber of ["OF-1", "KO-1"]) {
          const order = { status, orderNumber, quoteNumber };
          expect(webSales.salesDocumentKind(order)).toBe(shared.salesDocumentKind(order));
        }
    // The web's quoteNumber is optional: undefined behaves as null.
    expect(webSales.salesDocumentKind({ status: "cancelled", orderNumber: "KO-1" })).toBe("order");
  });
});

describe("list page size mirror", () => {
  it("offers the same page sizes and default", () => {
    expect([...webList.LIST_PAGE_SIZE_OPTIONS]).toEqual([...shared.LIST_PAGE_SIZE_OPTIONS]);
    expect(webList.LIST_PAGE_SIZE).toBe(shared.DEFAULT_LIST_PAGE_SIZE);
  });
});

describe("favorites mirror", () => {
  it("has the same limits", () => {
    expect(webFav.MAX_FAVORITES).toBe(shared.MAX_FAVORITES);
    expect(webFav.FAVORITE_TITLE_MAX).toBe(shared.FAVORITE_TITLE_MAX);
  });

  it("builds a href that the shared schema accepts, without the page number", () => {
    const href = webFav.favoriteHref("/forsaljning/ordrar", new URLSearchParams("status=late&page=3&search=a b"));
    expect(href).toBe("/forsaljning/ordrar?status=late&search=a+b");
    expect(shared.favoriteSchema.safeParse({ href, title: "Sena order" }).success).toBe(true);
    expect(webFav.favoriteHref("/artiklar", new URLSearchParams("page=2"))).toBe("/artiklar");
  });
});

describe("alerts mirror", () => {
  it("has the same alert kinds and areas in the same order", () => {
    expect([...webAlerts.ALERT_KINDS]).toEqual([...shared.ALERT_KINDS]);
    expect([...webAlerts.ALERT_AREAS]).toEqual([...shared.ALERT_AREAS]);
    expect(webAlerts.ALERT_AREA_LABELS).toEqual(shared.ALERT_AREA_LABELS);
  });
});

describe("quality mirror", () => {
  it("has the same enumerations and labels", () => {
    expect([...webQuality.DEVIATION_TYPES]).toEqual([...shared.DEVIATION_TYPES]);
    expect(webQuality.DEVIATION_TYPE_LABELS).toEqual(shared.DEVIATION_TYPE_LABELS);
    expect([...webQuality.DEVIATION_STATUSES]).toEqual([...shared.DEVIATION_STATUSES]);
    expect(webQuality.DEVIATION_STATUS_LABELS).toEqual(shared.DEVIATION_STATUS_LABELS);
    expect([...webQuality.DEVIATION_DECISIONS]).toEqual([...shared.DEVIATION_DECISIONS]);
    expect(webQuality.DEVIATION_DECISION_LABELS).toEqual(shared.DEVIATION_DECISION_LABELS);
    expect([...webQuality.DEVIATION_COST_KINDS]).toEqual([...shared.DEVIATION_COST_KINDS]);
    expect(webQuality.DEVIATION_COST_KIND_LABELS).toEqual(shared.DEVIATION_COST_KIND_LABELS);
    expect([...webQuality.DEVIATION_LINK_DOCUMENT_TYPES]).toEqual([...shared.DEVIATION_LINK_DOCUMENT_TYPES]);
    expect(webQuality.DEVIATION_LINK_DOCUMENT_LABELS).toEqual(shared.DEVIATION_LINK_DOCUMENT_LABELS);
    expect(webQuality.DEVIATION_ACTION_LABELS).toEqual(shared.DEVIATION_ACTION_LABELS);
    expect(Object.keys(webQuality.DEVIATION_STATUS_PILL)).toEqual([...shared.DEVIATION_STATUSES]);
  });
});

describe("plugins mirror", () => {
  it("has the same event types, statuses, modules and tab targets", () => {
    expect(webPlugins.PLUGIN_EVENT_CATALOG.map((e) => e.type)).toEqual([...shared.PLUGIN_EVENT_TYPES]);
    for (const def of webPlugins.PLUGIN_EVENT_CATALOG) {
      const original = shared.pluginEventDef(def.type);
      expect(original, def.type).toBeDefined();
      expect(def.label).toBe(original!.label);
      expect(def.permission).toBe(original!.permission);
    }
    expect(Object.keys(webPlugins.PLUGIN_STATUS_LABELS)).toEqual([...shared.PLUGIN_STATUSES]);
    expect(Object.keys(webPlugins.PLUGIN_DELIVERY_STATUS_LABELS)).toEqual([...shared.PLUGIN_DELIVERY_STATUSES]);
    expect(Object.keys(webPlugins.PLUGIN_MODULE_LABELS).sort()).toEqual([...shared.PLUGIN_PAGE_MODULES].sort());
    expect(Object.keys(webPlugins.PLUGIN_MODULE_NAV).sort()).toEqual([...shared.PLUGIN_PAGE_MODULES].sort());
    expect(Object.keys(webPlugins.PLUGIN_TAB_TARGET_LABELS).sort()).toEqual([...shared.PLUGIN_TAB_TARGETS].sort());
  });

  it("labels the test event and falls back to the type", () => {
    expect(webPlugins.pluginEventLabel(shared.PLUGIN_TEST_EVENT_TYPE)).toBe("Testhändelse");
    expect(webPlugins.pluginEventLabel("nope.nothing")).toBe("nope.nothing");
  });

  it("accepts as a navigation path only what the manifest's relative-path rule accepts as internal", () => {
    const paths = ["/artiklar", "/artiklar?x=1", "//evil.example", "/\\evil", "https://x.se", "", "artiklar", "/api/x", "/_next/x", "/a\nb"];
    for (const p of paths) {
      // Shared isRelativePluginPath is a manifest rule (a page path under the
      // plugin's own base), so only the web-specific guard is pinned here:
      // anything that is not a single-slash path must be refused by both.
      if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) {
        expect(webPlugins.isInternalNavigationPath(p), p).toBe(false);
      }
    }
    expect(webPlugins.isInternalNavigationPath("/artiklar")).toBe(true);
    expect(webPlugins.isInternalNavigationPath("/api/x")).toBe(false);
  });
});

describe("einvoice mirror", () => {
  it("has the same statuses, environments and Swedish status text", () => {
    expect(Object.keys(webEinvoice.EINVOICE_STATUS_LABELS)).toEqual([...shared.EINVOICE_STATUSES]);
    for (const status of shared.EINVOICE_STATUSES)
      expect(webEinvoice.EINVOICE_STATUS_LABELS[status]).toBe(einvoiceStatusLabel(status));
    expect(Object.keys(webEinvoice.EINVOICE_ENVIRONMENT_LABELS).sort()).toEqual([...shared.EINVOICE_ENVIRONMENTS].sort());
    expect(Object.keys(webEinvoice.EINVOICE_STATUS_PILL)).toEqual([...shared.EINVOICE_STATUSES]);
  });
});

describe("margin mirror", () => {
  const inputs = [
    { quantity: 10, unitPrice: 100, discountPercent: 0, selfCostPerUnit: 60 },
    { quantity: 3, unitPrice: 99.99, discountPercent: 12.5, selfCostPerUnit: 70.123 },
    { quantity: 5, unitPrice: 10, discountPercent: 0, selfCostPerUnit: 20 },
    { quantity: 5, unitPrice: 10, discountPercent: 0, selfCostPerUnit: null },
    { quantity: 5, unitPrice: 0, discountPercent: 0, selfCostPerUnit: 4 },
    { quantity: 5, unitPrice: 10, discountPercent: 100, selfCostPerUnit: 4 },
  ];

  it("computes line margins like the API", () => {
    for (const input of inputs) expect(webMargin.computeLineMargin(input)).toEqual(computeLineMargin(input));
  });

  it("sums margins like the API", () => {
    const lists = [[], inputs.slice(0, 1), inputs, inputs.filter((i) => i.selfCostPerUnit === null), inputs.slice(2, 5)];
    for (const list of lists) {
      expect(webMargin.sumMargins(list.map((i) => webMargin.computeLineMargin(i)))).toEqual(
        sumMargins(list.map((i) => computeLineMargin(i)))
      );
    }
  });
});

describe("shipping mirror (freightModeText)", () => {
  it("chooses the same freight mode as parcels.ts freightMode", () => {
    const text = { package: /^Förpackning: /, own: /^Egna mått$/, none: /^Inget fraktsätt/ };
    const numbers = [null, 0, 1, 12, 500];
    for (const packageTypeId of [null, "pt-1"])
      for (const qty of numbers)
        for (const l of numbers)
          for (const w of [null, 300])
            for (const h of [null, 0, 40]) {
              const api = freightMode({
                id: "a",
                name: "A",
                type: "purchased",
                weight: 1,
                lengthMm: l,
                widthMm: w,
                heightMm: h,
                parcelKind: null,
                stackable: false,
                loadingMeters: null,
                packageTypeId,
                quantityPerPackage: qty,
              });
              const webText = webShipping.freightModeText(
                {
                  packageTypeId,
                  quantityPerPackage: qty === null ? null : String(qty),
                  length: l === null ? null : String(l),
                  width: w === null ? null : String(w),
                  height: h === null ? null : String(h),
                },
                "Kartong"
              );
              expect(webText).toMatch(text[api]);
            }
  });

  it("has the same parcel kinds and shipment statuses", () => {
    expect(Object.keys(webShipping.PARCEL_KIND_LABELS).sort()).toEqual([...shared.parcelKindSchema.options].sort());
    expect(Object.keys(webShipping.SHIPMENT_STATUS_LABELS).sort()).toEqual([...shared.shipmentStatusSchema.options].sort());
  });
});

describe("serials mirror (apps/web/lib/serials.ts)", () => {
  it("compresses serial numbers like the shared helper", () => {
    const lists = [
      [],
      ["SN-000003"],
      ["SN-000002", "SN-000001"],
      ["SN-000010", "SN-000009", "SN-000008", "SN-000012"],
      ["A9", "A10", "A11", "B-1", "B-2", "B-3", "X"],
      ["12", "13", "14", "ä-1", "a-1", "z-1", "SN-1", "sn-2", "SN-3"],
      ["99999999999999999998", "99999999999999999999", "100000000000000000000"],
    ];
    for (const list of lists) {
      expect(webSerials.compressSerialNumbers(list)).toBe(shared.compressSerialNumbers(list));
      expect(webSerials.serialNumberRuns(list)).toEqual(shared.serialNumberRuns(list));
      expect(webSerials.sortSerialNumbers(list)).toEqual(shared.sortSerialNumbers(list));
    }
  });
});

describe("E-postsignatur mirror (apps/web/lib/mailSignature.ts)", () => {
  it("has the shared field lists, and a label for every field", () => {
    expect(webMailSignature.MAIL_SIGNATURE_USER_FIELDS).toEqual(shared.MAIL_SIGNATURE_USER_FIELDS);
    expect(webMailSignature.MAIL_SIGNATURE_COMPANY_FIELDS).toEqual(shared.MAIL_SIGNATURE_COMPANY_FIELDS);
    expect(Object.keys(webMailSignature.MAIL_SIGNATURE_USER_FIELD_LABELS)).toEqual([...shared.MAIL_SIGNATURE_USER_FIELDS]);
    expect(Object.keys(webMailSignature.MAIL_SIGNATURE_COMPANY_FIELD_LABELS)).toEqual([...shared.MAIL_SIGNATURE_COMPANY_FIELDS]);
  });
});

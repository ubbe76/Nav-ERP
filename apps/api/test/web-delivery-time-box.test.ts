import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ESTIMATE_CONFIGURE,
  ESTIMATE_NO_DATE,
  estimateErrorLine,
  estimateKey,
  estimateLine,
} from "../../web/lib/deliveryTimeBox.js";
import type { DeliveryTimeCheckRequest } from "../../web/lib/deliveryTimeCheck.js";
import type { DeliveryTimeCheckResult } from "../../web/lib/types.js";

// The Leveranstid box (Ny offert / Ny kundorder): the key, the texts and
// guards on the hook and the component.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const request = (over: Partial<DeliveryTimeCheckRequest> = {}): DeliveryTimeCheckRequest => ({
  customerId: "c1",
  rows: [
    { articleId: "a1", quantity: 2 },
    { articleId: "a2", quantity: 5, configuration: { selection: { width: 600, color: "vit" } } },
  ],
  ...over,
});
const result = (over: Partial<DeliveryTimeCheckResult> = {}): DeliveryTimeCheckResult => ({
  shipDate: "2026-12-10",
  deliveryDate: "2026-12-12",
  rows: [],
  notes: [],
  ...over,
});

describe("estimateKey", () => {
  it("is empty without a request", () => {
    expect(estimateKey(null)).toBe("");
  });
  it("is stable against row order, whitespace and selection key order", () => {
    const a = estimateKey(request());
    const b = estimateKey({
      customerId: " c1 ",
      rows: [
        { articleId: "a2 ", quantity: 5, configuration: { selection: { color: " vit", width: 600 } } },
        { articleId: "a1", quantity: 2 },
      ],
    });
    expect(b).toBe(a);
  });
  it("changes with quantity, customer and configuration", () => {
    const base = estimateKey(request());
    expect(estimateKey(request({ rows: [{ articleId: "a1", quantity: 3 }, request().rows![1]!] }))).not.toBe(base);
    expect(estimateKey(request({ customerId: "c2" }))).not.toBe(base);
    expect(estimateKey(request({ customerId: undefined }))).not.toBe(base);
    expect(
      estimateKey(request({ rows: [request().rows![0]!, { articleId: "a2", quantity: 5, configuration: { selection: { width: 800, color: "vit" } } }] }))
    ).not.toBe(base);
  });
});

describe("estimateLine", () => {
  it("shows delivery and shipping with a customer", () => {
    expect(estimateLine(result(), true)).toEqual({ text: "Tidigast leverans 12 dec (avsändning 10 dec)", alternative: null, date: "2026-12-12" });
  });
  it("shows only shipping without a customer", () => {
    const l = estimateLine(result({ deliveryDate: "2026-12-10" }), false);
    expect(l.text).toBe("Tidigast avsändning 10 dec");
    expect(l.date).toBe("2026-12-10");
  });
  it("adds the alternatives summary", () => {
    const l = estimateLine(result({ usesAlternatives: true, ordinaryDeliveryDate: "2026-12-20" }), true);
    expect(l.alternative).toBe("Leverans 12 dec med alternativa resurser (ordinarie: 20 dec)");
    const none = estimateLine(result({ usesAlternatives: true, ordinaryDeliveryDate: null }), true);
    expect(none.alternative).toContain("ordinarie resurser ger inget datum inom två år");
  });
  it("says so when no day is found", () => {
    expect(estimateLine(result({ shipDate: null, deliveryDate: null }), true)).toEqual({ text: ESTIMATE_NO_DATE, alternative: null, date: null });
    expect(ESTIMATE_NO_DATE).toBe("Ingen leveransdag inom två år");
  });
  it("turns configuration-required into a hint", () => {
    expect(estimateErrorLine("configuration-required", "x")).toBe(ESTIMATE_CONFIGURE);
    expect(ESTIMATE_CONFIGURE).toBe("Konfigurera raden för att se leveranstiden");
    expect(estimateErrorLine(undefined, "Boom")).toBe("Boom");
  });
});

describe("source guards", () => {
  const hook = read("../../web/lib/useDeliveryTimeEstimate.ts");
  const box = read("../../web/components/sales/DeliveryTimeBox.tsx");
  const form = read("../../web/components/sales/NewQuoteForm.tsx");

  it("the hook waits 800 ms, uses a request sequence and pauses when hidden", () => {
    expect(hook).toContain("ESTIMATE_DELAY_MS = 800");
    expect(hook).toMatch(/setTimeout\([\s\S]*ESTIMATE_DELAY_MS\)/);
    expect(hook).toMatch(/seq\.current === mySeq/);
    expect(hook).toContain('document.visibilityState === "visible"');
    expect(hook).toContain("visibilitychange");
  });
  it("the only request is the existing delivery-time check", () => {
    for (const src of [hook, box]) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toContain("apiFetch");
      expect(src).not.toContain("applyDeliveryTime");
    }
    expect(hook).toContain("runDeliveryTimeCheck(");
  });
  it("the box writes a date only through the click on Använd datumet", () => {
    expect(box).not.toMatch(/useEffect/);
    expect(box).not.toMatch(/onUseDate\([^)]*\)\s*;?\s*\n\s*\}, \[/);
    const calls = box.match(/onUseDate\(/g) ?? [];
    // button click + the dialog's own "Använd datumet"; both user clicks
    expect(calls.length).toBe(2);
    expect(box).toContain('useCan()');
    expect(box).toContain('["forsaljning", "tillverkning"]');
  });
  it("the form sets the date as touched and has no request without valid rows", () => {
    expect(form).toContain("<DeliveryTimeBox");
    expect(form).toContain("checkRows.length > 0 ? checkRequest : null");
  });
});

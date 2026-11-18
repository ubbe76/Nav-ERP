import { describe, expect, it } from "vitest";
// The web helper's only import is format.ts, so vitest loads it directly.
import {
  REST_SUGGESTION_DEFAULTS,
  othersStampingOnOperation,
  restFieldValue,
  stampRestSuggestion,
  suggestsRest,
} from "../../web/lib/restSuggestion.js";

// Rest som förslag i antalsfältet — the rule behind the setting, one place
// for Inleverans, Utleverans, Rapportera and Stämpla ut.
describe("suggestsRest", () => {
  it("defaults to today's behaviour: on, on, on, off", () => {
    expect(REST_SUGGESTION_DEFAULTS).toEqual({ receipt: true, delivery: true, report: true, stamp: false });
    for (const settings of [null, undefined, {}]) {
      expect(suggestsRest(settings, "receipt")).toBe(true);
      expect(suggestsRest(settings, "delivery")).toBe(true);
      expect(suggestsRest(settings, "report")).toBe(true);
      expect(suggestsRest(settings, "stamp")).toBe(false);
    }
  });

  it("reads one routine at a time", () => {
    const settings = { restSuggestReceipt: false, restSuggestDelivery: true, restSuggestReport: false, restSuggestStamp: true };
    expect(suggestsRest(settings, "receipt")).toBe(false);
    expect(suggestsRest(settings, "delivery")).toBe(true);
    expect(suggestsRest(settings, "report")).toBe(false);
    expect(suggestsRest(settings, "stamp")).toBe(true);
  });
});

describe("restFieldValue", () => {
  it("is the rest when suggested and empty — never 0 — when not", () => {
    expect(restFieldValue(true, 7)).toBe("7");
    expect(restFieldValue(true, 2.5)).toBe("2.5");
    expect(restFieldValue(true, 0)).toBe("0");
    expect(restFieldValue(true, -3)).toBe("0");
    expect(restFieldValue(true, 0.1 + 0.2)).toBe("0.3");
    expect(restFieldValue(false, 7)).toBe("");
    expect(restFieldValue(false, 0)).toBe("");
  });
});

describe("stampRestSuggestion", () => {
  it("fills Antal OK with Kvar only when on and alone on the operation", () => {
    expect(stampRestSuggestion({ enabled: true, remaining: 12, othersStamping: false })).toEqual({ value: "12", othersStamping: false });
  });

  it("leaves the field empty and says why when someone else stamps on the operation", () => {
    expect(stampRestSuggestion({ enabled: true, remaining: 12, othersStamping: true })).toEqual({ value: "", othersStamping: true });
  });

  it("is empty and silent when the setting is off, whoever else stamps", () => {
    expect(stampRestSuggestion({ enabled: false, remaining: 12, othersStamping: false })).toEqual({ value: "", othersStamping: false });
    expect(stampRestSuggestion({ enabled: false, remaining: 12, othersStamping: true })).toEqual({ value: "", othersStamping: false });
  });
});

describe("othersStampingOnOperation", () => {
  const mine = { id: "s1", moOperationId: "op1" };
  it("counts another open stamp on the same operation, never the session itself or another operation", () => {
    expect(othersStampingOnOperation([mine], mine)).toBe(false);
    expect(othersStampingOnOperation([mine, { id: "s2", moOperationId: "op2" }], mine)).toBe(false);
    expect(othersStampingOnOperation([mine, { id: "s3", moOperationId: "op1" }], mine)).toBe(true);
  });
});

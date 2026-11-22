import { describe, expect, it } from "vitest";
import { instantFromField, stampClock, stampDayHref, stampDayLabel, stampHours, stampRange } from "../../web/lib/stampDay";
import { toDateTimeLocalValue } from "../../web/lib/date";

// Stämplingar (Personal & lön, 2026-11-22): the page's pure rules.
describe("Stämplingar (webben)", () => {
  it("links a day", () => {
    expect(stampDayHref("abc", "2026-11-03")).toBe("/personal/stamplingar?employee=abc&date=2026-11-03");
  });

  it("writes the clock on the day, and the date on another day", () => {
    expect(stampClock("2026-11-03T06:02:00.000Z", "2026-11-03")).toBe("07:02");
    expect(stampClock("2026-11-02T21:10:00.000Z", "2026-11-03")).toMatch(/^2 nov\.? 22:10$/);
    expect(stampRange("2026-11-03T06:02:00.000Z", null, "2026-11-03")).toBe("07:02 – pågår");
    expect(stampDayLabel("2026-11-03")).toBe("tisdag 3 november 2026");
  });

  it("an untouched field sends the stored instant, seconds and all", () => {
    const stored = "2026-11-03T06:02:41.123Z";
    expect(instantFromField(toDateTimeLocalValue(stored), stored)).toBe(stored);
    const edited = toDateTimeLocalValue("2026-11-03T06:30:00.000Z");
    expect(instantFromField(edited, stored)).toBe("2026-11-03T06:30:00.000Z");
    expect(instantFromField("", null)).toBeNull();
  });

  it("previews the hours as the server counts them", () => {
    expect(stampHours("2026-11-03T06:00:00.000Z", "2026-11-03T10:30:00.000Z", 30)).toBe(4);
    expect(stampHours("2026-11-03T06:00:00.000Z", "2026-11-03T06:00:10.000Z", 0)).toBe(0.01);
    expect(stampHours("2026-11-03T06:00:00.000Z", "2026-11-03T05:00:00.000Z", 0)).toBeNull();
    expect(stampHours("2026-11-03T06:00:00.000Z", "2026-11-03T07:00:00.000Z", 60)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { DURATION_HINT, durationFromHours, durationPattern, formatDuration, hoursFromDuration, keypadPlaceholder, parseDuration, readAbsenceMinutes } from "../../web/lib/duration";

// Tidsfälten som tt:mm (2026-11-22, användarens val): t:mm, or a bare
// number of minutes.
describe("tidsfälten (tt:mm)", () => {
  it("reads t:mm and bare minutes", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("01:30")).toBe(90);
    expect(parseDuration("40:00")).toBe(2400);
    expect(parseDuration(":45")).toBe(45);
    expect(parseDuration("7.30")).toBe(450);
    expect(parseDuration("7,30")).toBe(450);
    expect(parseDuration(" 0:05 ")).toBe(5);
    // A bare number is minutes (the user's choice), not hours.
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("8")).toBe(8);
    expect(parseDuration("0")).toBe(0);
  });

  it("refuses what could be read two ways, and what is not a time", () => {
    // The old hours habit: 4,5 is neither 4:50 nor 4 minutes.
    expect(parseDuration("4,5")).toBeNull();
    expect(parseDuration("1:5")).toBeNull();
    expect(parseDuration("1:60")).toBeNull();
    expect(parseDuration("1:30:00")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1 h")).toBeNull();
  });

  it("takes a sign only where it is allowed", () => {
    expect(parseDuration("-1:30")).toBeNull();
    expect(parseDuration("-1:30", { signed: true })).toBe(-90);
    expect(parseDuration("−45", { signed: true })).toBe(-45);
    expect(parseDuration("-0", { signed: true })).toBe(0);
  });

  it("writes whole minutes as t:mm", () => {
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(8)).toBe("0:08");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(2400)).toBe("40:00");
    expect(formatDuration(479.6)).toBe("8:00");
    expect(formatDuration(-90)).toBe("-1:30");
    expect(formatDuration(-0.2)).toBe("0:00");
  });

  it("the input's pattern accepts exactly what the parser reads", () => {
    const samples = ["1:30", "01:30", ":45", "7.30", "7,30", " 0:05 ", "90", "8", "0", "4,5", "1:5", "1:60", "", "abc", "1 h", "-1:30", "−45", "- 1:30", "1:30:00", "1234567"];
    for (const signed of [false, true]) {
      const pattern = new RegExp(`^(?:${durationPattern(signed)})$`, "v");
      for (const sample of samples) {
        expect([signed, sample, pattern.test(sample)]).toEqual([signed, sample, parseDuration(sample, { signed }) !== null]);
      }
    }
  });

  it("an hours field sends two decimals, and the stored hours while it shows them", () => {
    expect(durationFromHours("7.5")).toBe("7:30");
    expect(durationFromHours(7.33)).toBe("7:20");
    expect(hoursFromDuration("7:30")).toBe(7.5);
    expect(hoursFromDuration("0:20")).toBe(0.33);
    expect(hoursFromDuration("1:30x")).toBeNull();
    // 0.01 h shows as 0:01; left as it is, the stored 0.01 goes back, not 0.02.
    expect(durationFromHours("0.01")).toBe("0:01");
    expect(hoursFromDuration("0:01", "0.01")).toBe(0.01);
    expect(hoursFromDuration("1", "0.01")).toBe(0.01);
    expect(hoursFromDuration("0:02", "0.01")).toBe(0.03);
  });

  it("a touch screen's example shows the comma its keypad has, and reads the same", () => {
    expect(keypadPlaceholder("tt:mm")).toBe("t.ex. 1,30");
    expect(keypadPlaceholder("t.ex. 1:30")).toBe("t.ex. 1,30");
    expect(keypadPlaceholder("t.ex. 40:00")).toBe("t.ex. 40,00");
    expect(keypadPlaceholder("t.ex. 0:05")).toBe("t.ex. 0,05");
    // A value shown as a default is not an example to rewrite.
    expect(keypadPlaceholder("Systemstandard: 1:22")).toBe("Systemstandard: 1:22");
    for (const example of ["1:30", "40:00", "0:05", "8:00"]) {
      const comma = keypadPlaceholder(`t.ex. ${example}`).replace("t.ex. ", "");
      expect(parseDuration(comma)).toBe(parseDuration(example));
    }
    expect(DURATION_HINT).toContain("1,30");
  });

  it("an absence is 0:01–24:00", () => {
    expect(readAbsenceMinutes("8:00")).toBe(480);
    expect(readAbsenceMinutes("24:00")).toBe(1440);
    expect(readAbsenceMinutes("24:01")).toBe("Frånvaron ska vara mellan 0:01 och 24:00.");
    expect(readAbsenceMinutes("0")).toBe("Frånvaron ska vara mellan 0:01 och 24:00.");
    expect(readAbsenceMinutes("4,5")).toBe(DURATION_HINT);
  });
});

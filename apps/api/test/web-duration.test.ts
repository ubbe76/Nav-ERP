import { describe, expect, it } from "vitest";
import { DURATION_HINT, durationFromHours, durationPattern, formatDuration, hoursFromDuration, parseDuration, readAbsenceMinutes, withAutoColon } from "../../web/lib/duration";

// Tidsfälten som tt:mm (2026-11-22, användarens val): t:mm; digits alone
// with the last two as the minutes and the colon filled in while typed
// (2026-11-25), one or two digits alone are minutes.
describe("tidsfälten (tt:mm)", () => {
  it("reads t:mm and bare minutes", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("01:30")).toBe(90);
    expect(parseDuration("40:00")).toBe(2400);
    expect(parseDuration(":45")).toBe(45);
    expect(parseDuration("7.30")).toBe(450);
    expect(parseDuration("7,30")).toBe(450);
    expect(parseDuration(" 0:05 ")).toBe(5);
    // One or two digits are minutes (the user's choice), not hours.
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("8")).toBe(8);
    expect(parseDuration("0")).toBe(0);
    // Three digits or more: the last two are the minutes (2026-11-25).
    expect(parseDuration("130")).toBe(90);
    expect(parseDuration("0130")).toBe(90);
    expect(parseDuration("1000")).toBe(600);
    expect(parseDuration("4000")).toBe(2400);
    expect(parseDuration("123456")).toBe(1234 * 60 + 56);
  });

  it("refuses what could be read two ways, and what is not a time", () => {
    // The old hours habit: 4,5 is neither 4:50 nor 4 minutes.
    expect(parseDuration("4,5")).toBeNull();
    expect(parseDuration("1:5")).toBeNull();
    expect(parseDuration("1:60")).toBeNull();
    expect(parseDuration("1:30:00")).toBeNull();
    // 1:90 is no time, and seven digits are more hours than a field takes.
    expect(parseDuration("190")).toBeNull();
    expect(parseDuration("1234567")).toBeNull();
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
    const samples = ["1:30", "01:30", ":45", "7.30", "7,30", " 0:05 ", "90", "8", "0", "130", "0130", "123456", "190", "4,5", "1:5", "1:60", "", "abc", "1 h", "-1:30", "−45", "-130", "- 1:30", "1:30:00", "1234567"];
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

  it("puts the colon in while digits are typed", () => {
    // Typed digit by digit on the phone's keypad, which has no colon.
    const typed = (keys: string, from = "") => [...keys].reduce((shown, key) => withAutoColon(shown + key, shown), from);
    expect(typed("1")).toBe("1");
    expect(typed("13")).toBe("13");
    expect(typed("130")).toBe("1:30");
    expect(typed("0130")).toBe("01:30");
    expect(typed("1305")).toBe("13:05");
    expect(typed("4000")).toBe("40:00");
    // What it shows reads as what was typed.
    for (const keys of ["8", "90", "130", "0130", "1305", "4000"]) expect(parseDuration(typed(keys))).toBe(parseDuration(keys));
    // A backspace is left as it is, so the last digit can be retyped.
    expect(withAutoColon("13:0", "13:05")).toBe("13:0");
    expect(withAutoColon("13:08", "13:0")).toBe("13:08");
    expect(withAutoColon("1:3", "1:30")).toBe("1:3");
    // Deleting the colon alone puts it back; a digit added moves it.
    expect(withAutoColon("130", "1:30")).toBe("1:30");
    expect(withAutoColon("12:30", "1:30")).toBe("12:30");
    expect(withAutoColon("1:230", "1:30")).toBe("12:30");
    // A separator typed by hand is left as typed until the field is left.
    expect(typed("1:30")).toBe("1:30");
    expect(typed("7,30")).toBe("7,30");
    expect(typed("7.30")).toBe("7.30");
    expect(typed("1:")).toBe("1:");
    // A sign stays in front (an ATF adjustment), and a cleared field is empty.
    expect(typed("-130")).toBe("-1:30");
    expect(typed("−")).toBe("−");
    expect(withAutoColon("", "1:30")).toBe("");
    expect(withAutoColon(" 130 ", "")).toBe("1:30");
    expect(DURATION_HINT).toContain("130");
  });

  it("an absence is 0:01–24:00", () => {
    expect(readAbsenceMinutes("8:00")).toBe(480);
    expect(readAbsenceMinutes("24:00")).toBe(1440);
    expect(readAbsenceMinutes("24:01")).toBe("Frånvaron ska vara mellan 0:01 och 24:00.");
    expect(readAbsenceMinutes("0")).toBe("Frånvaron ska vara mellan 0:01 och 24:00.");
    expect(readAbsenceMinutes("4,5")).toBe(DURATION_HINT);
  });
});

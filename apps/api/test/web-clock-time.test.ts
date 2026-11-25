import { describe, expect, it } from "vitest";
import { CLOCK_PATTERN, normalizeClockTime } from "../../web/lib/clockTime";
import { withAutoColon } from "../../web/lib/duration";

// Klockslagen (scheman, OB-tillägg — components/ui/ClockInput.tsx): HH:MM in
// 24 hours, typed loosely, with the colon filled in while digits are typed
// (2026-11-25, the user's wish — the phone's numeric keypad has no colon).
describe("klockslag (HH:MM)", () => {
  it("reads a loosely typed clock time", () => {
    expect(normalizeClockTime("7")).toBe("07:00");
    expect(normalizeClockTime("16")).toBe("16:00");
    expect(normalizeClockTime("730")).toBe("07:30");
    expect(normalizeClockTime("7:30")).toBe("07:30");
    expect(normalizeClockTime("7.30")).toBe("07:30");
    expect(normalizeClockTime("7,30")).toBe("07:30");
    expect(normalizeClockTime("0730")).toBe("07:30");
    expect(normalizeClockTime("1630")).toBe("16:30");
    expect(normalizeClockTime("23:59")).toBe("23:59");
    expect(normalizeClockTime("24:00")).toBeNull();
    expect(normalizeClockTime("7:60")).toBeNull();
    expect(normalizeClockTime("12345")).toBeNull();
    expect(normalizeClockTime("abc")).toBeNull();
  });

  it("puts the colon in while digits are typed, and reads what it shows", () => {
    const typed = (keys: string) => [...keys].reduce((shown, key) => withAutoColon(shown + key, shown), "");
    expect(typed("0730")).toBe("07:30");
    expect(typed("1630")).toBe("16:30");
    expect(typed("730")).toBe("7:30");
    expect(typed("7")).toBe("7");
    // Five characters at most (the field's maxLength) — and every result is
    // a clock time the pattern accepts once the field is left.
    const pattern = new RegExp(`^(?:${CLOCK_PATTERN})$`);
    for (const keys of ["7", "16", "730", "0730", "1630", "2359"]) {
      const shown = typed(keys);
      expect(shown.length).toBeLessThanOrEqual(5);
      const left = normalizeClockTime(shown);
      expect(left).toBe(normalizeClockTime(keys));
      expect(pattern.test(left ?? "")).toBe(true);
    }
  });
});

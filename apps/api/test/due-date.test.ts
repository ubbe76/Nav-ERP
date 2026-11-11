import { describe, expect, it } from "vitest";
import { dueDateFromTerm } from "../src/modules/system/service/due-date.js";

// Förfallodag = fakturadatum + betalningsvillkorets dagar, in calendar days.
describe("dueDateFromTerm", () => {
  it("counts calendar days over both daylight-saving changes and month/leap-year ends", () => {
    expect(dueDateFromTerm("2026-03-28", "1")).toBe("2026-03-29");
    expect(dueDateFromTerm("2026-10-24", "1")).toBe("2026-10-25");
    expect(dueDateFromTerm("2026-03-15", "30")).toBe("2026-04-14");
    expect(dueDateFromTerm("2026-12-15", "30")).toBe("2027-01-14");
    expect(dueDateFromTerm("2028-02-28", "1")).toBe("2028-02-29");
    expect(dueDateFromTerm("2026-05-04", "0")).toBe("2026-05-04");
  });

  it("gives no date for a term that is not a number of days", () => {
    expect(dueDateFromTerm("2026-05-04", "KONTANT")).toBeNull();
    expect(dueDateFromTerm("2026-05-04", "")).toBeNull();
    expect(dueDateFromTerm("2026-05-04", null)).toBeNull();
  });
});

// Systemgranskningen 2026-11-11: only a code that IS a day count — one to
// four digits, optionally with the import's collision suffix — gives a
// förfallodag. parseInt read any leading number ("2/10" ⇒ 2, "-30" ⇒ −30)
// and "99999999" threw a RangeError in addDays (a 500 at Utfärda and in
// GET /alerts).
describe("dueDateFromTerm — strict codes", () => {
  it("reads the import's collision suffix as the same day count", () => {
    expect(dueDateFromTerm("2026-03-15", "30_2")).toBe("2026-04-14");
    expect(dueDateFromTerm("2026-03-15", "10_12")).toBe("2026-03-25");
    expect(dueDateFromTerm("2026-03-15", "9999")).toBe("2053-07-30");
  });

  it("gives no date for anything else instead of a wrong one or a crash", () => {
    for (const code of ["2/10", "-30", "30 dagar", " 30", "30_", "V_1_MANAD_NETTO", "1_MANAD_NETTO", "10_30_NETTO", "99999999", "12345", "3.5"]) {
      expect([code, dueDateFromTerm("2026-05-04", code)]).toEqual([code, null]);
    }
  });
});

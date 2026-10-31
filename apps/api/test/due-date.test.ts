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

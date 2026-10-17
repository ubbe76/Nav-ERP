import { describe, expect, it } from "vitest";
import {
  addDays,
  addWorkingDays,
  decodeDeliveryDefaults,
  deliveryFromShipDate,
  deliveryDateWarning,
  deliveryHolidayWindow,
  deliverySummary,
  earliestCustomerDelivery,
  effectiveDeliverySettings,
  isListedDay,
  isValidCustomerDelivery,
  isValidPurchaseArrival,
  lastListedOnOrBefore,
  nextListedOnOrAfter,
  nextWorkingDayOnOrAfter,
  shipDateFor,
  subtractWorkingDays,
  suggestPurchaseDeliveryDate,
  type DeliverySettings,
} from "../src/modules/system/service/delivery-days.js";

// Pure tests — no database. 2026-10-17 is a Saturday, 2026-10-19 a Monday.
const off = new Set(["2026-12-25"]);
const none: DeliverySettings = { weekdays: [], mode: "arrival", transitDays: 0 };
const s = (weekdays: number[], mode: DeliverySettings["mode"], transitDays = 0): DeliverySettings => ({
  weekdays,
  mode,
  transitDays,
});

describe("delivery-days — working days", () => {
  it("adds and subtracts working days across a weekend", () => {
    expect(addWorkingDays("2026-10-16", 1, off)).toBe("2026-10-19");
    expect(subtractWorkingDays("2026-10-19", 1, off)).toBe("2026-10-16");
  });

  it("n = 0 leaves the date unchanged, even on a Saturday", () => {
    expect(addWorkingDays("2026-10-17", 0, off)).toBe("2026-10-17");
    expect(subtractWorkingDays("2026-10-17", 0, off)).toBe("2026-10-17");
  });

  it("skips a full-day holiday", () => {
    expect(addWorkingDays("2026-12-24", 1, off)).toBe("2026-12-28");
    expect(nextWorkingDayOnOrAfter("2026-12-25", off)).toBe("2026-12-28");
    expect(nextWorkingDayOnOrAfter("2026-10-19", off)).toBe("2026-10-19");
  });
});

describe("delivery-days — listed days", () => {
  it("empty weekdays means working days", () => {
    expect(isListedDay("2026-10-17", none, off)).toBe(false);
    expect(isListedDay("2026-10-19", none, off)).toBe(true);
  });

  it("an explicitly ticked Saturday is listed", () => {
    expect(isListedDay("2026-10-17", s([6], "arrival"), off)).toBe(true);
  });

  it("a full-day holiday is never listed", () => {
    expect(isListedDay("2026-12-25", s([5], "arrival"), off)).toBe(false);
  });

  it("gives up after 60 days and returns the input date", () => {
    const sundays = new Set<string>();
    for (let d = "2026-10-18"; d < "2026-12-31"; d = addDays(d, 7)) sundays.add(d);
    expect(nextListedOnOrAfter("2026-10-17", s([7], "arrival"), sundays)).toBe("2026-10-17");
    expect(lastListedOnOrBefore("2026-12-20", s([7], "arrival"), sundays)).toBe("2026-12-20");
  });
});

describe("delivery-days — suggestPurchaseDeliveryDate", () => {
  const today = "2026-10-17";

  it("short-circuits to today's rule without settings", () => {
    const base = { today, leadTimeDays: null, settings: none, offDays: off };
    expect(suggestPurchaseDeliveryDate({ ...base, demandDate: "2026-10-28" })).toEqual({
      date: "2026-10-27",
      late: false,
    });
    expect(suggestPurchaseDeliveryDate({ ...base, demandDate: "2026-10-10" })).toEqual({
      date: "2026-10-17",
      late: false,
    });
    expect(suggestPurchaseDeliveryDate({ ...base, demandDate: null })).toEqual({ date: null, late: false });
  });

  it("arrival mode: the last arrival day before the demand", () => {
    expect(
      suggestPurchaseDeliveryDate({
        demandDate: "2026-10-28",
        today,
        leadTimeDays: 0,
        settings: s([1], "arrival"),
        offDays: off,
      })
    ).toEqual({ date: "2026-10-26", late: false });
  });

  it("dispatch mode: the arrival of the last dispatch that makes it before the demand", () => {
    expect(
      suggestPurchaseDeliveryDate({
        demandDate: "2026-10-30",
        today,
        leadTimeDays: 0,
        settings: s([1, 4], "dispatch", 2),
        offDays: off,
      })
    ).toEqual({ date: "2026-10-28", late: false });
  });

  it("counts from Monday when today is a Saturday (t0)", () => {
    expect(
      suggestPurchaseDeliveryDate({
        demandDate: null,
        today,
        leadTimeDays: 0,
        settings: s([], "dispatch", 2),
        offDays: off,
      })
    ).toEqual({ date: "2026-10-21", late: false });
  });

  it("lead time pushing past the demand gives the floor and late", () => {
    expect(
      suggestPurchaseDeliveryDate({
        demandDate: "2026-10-21",
        today,
        leadTimeDays: 10,
        settings: s([1], "arrival"),
        offDays: off,
      })
    ).toEqual({ date: "2026-11-02", late: true });
  });

  it("lead time alone (no days, no transit) still gives a floor", () => {
    expect(
      suggestPurchaseDeliveryDate({ demandDate: null, today, leadTimeDays: 5, settings: none, offDays: off })
    ).toEqual({ date: "2026-10-26", late: false });
  });
});

describe("delivery-days — customer side", () => {
  it("shipDateFor in dispatch mode lands on a working day, not Sunday", () => {
    expect(shipDateFor("2026-10-26", s([], "dispatch", 1), off)).toBe("2026-10-23");
  });

  it("shipDateFor in arrival mode subtracts the transit days", () => {
    expect(shipDateFor("2026-10-20", s([2], "arrival", 2), off)).toBe("2026-10-16");
  });

  it("shipDateFor without settings returns the delivery date", () => {
    expect(shipDateFor("2026-10-25", none, off)).toBe("2026-10-25");
  });

  it("earliestCustomerDelivery in both modes", () => {
    expect(earliestCustomerDelivery("2026-10-17", s([2], "arrival", 2), off)).toBe("2026-10-27");
    expect(earliestCustomerDelivery("2026-10-17", s([1, 4], "dispatch", 2), off)).toBe("2026-10-21");
  });

  it("deliveryFromShipDate from a given ship day in both modes", () => {
    // Ready to ship Wednesday 21: next Tuesday is the 27th after 2 transit days (Friday 23).
    expect(deliveryFromShipDate("2026-10-21", s([2], "arrival", 2), off)).toBe("2026-10-27");
    // Dispatch Mon/Thu: Thursday 22 + 2 = Monday 26.
    expect(deliveryFromShipDate("2026-10-21", s([1, 4], "dispatch", 2), off)).toBe("2026-10-26");
    // No settings: the ship day itself.
    expect(deliveryFromShipDate("2026-10-21", none, off)).toBe("2026-10-21");
  });

  it("isValidCustomerDelivery mirrors the purchase side", () => {
    expect(isValidCustomerDelivery("2026-10-21", s([1, 4], "dispatch", 2), off)).toBe(true);
    expect(isValidCustomerDelivery("2026-10-22", s([1, 4], "dispatch", 2), off)).toBe(false);
    expect(isValidCustomerDelivery("2026-10-27", s([2], "arrival"), off)).toBe(true);
    expect(isValidCustomerDelivery("2026-10-28", s([2], "arrival"), off)).toBe(false);
  });
});

// Transit is up to 60 WORKING days. The search for the latest dispatch must
// start at the latest possible dispatch day, not at the delivery date — a
// 60-calendar-day window from the delivery date never reaches a dispatch
// 43+ working days back, and the callers then fell back silently (the ship
// date became the delivery date, every purchase suggestion was late, every
// date invalid). Monday 2026-10-19 is the dispatch day in every case.
describe("delivery-days — long transit (43–60 working days)", () => {
  const today = "2026-10-17";
  const ship = "2026-10-19";
  // Tuesday dispatch only; Tuesday 2026-11-03 is a full-day holiday.
  const offSparse = new Set(["2026-11-03", "2026-12-25", "2027-01-01", "2027-01-06"]);
  const tuesdayShip = "2026-10-20";

  describe.each([43, 50, 60])("transit %i", (transit) => {
    const working = s([], "dispatch", transit);
    const sparse = s([2], "dispatch", transit);
    const delivery = addWorkingDays(ship, transit, off);
    const sparseDelivery = addWorkingDays(tuesdayShip, transit, offSparse);

    it("shipDateFor finds the dispatch day", () => {
      expect(shipDateFor(delivery, working, off)).toBe(ship);
      expect(shipDateFor(sparseDelivery, sparse, offSparse)).toBe(tuesdayShip);
      // The dispatch Tuesday that would fit is a holiday: the Tuesday before.
      const holidayDelivery = addWorkingDays("2026-11-03", transit, offSparse);
      expect(shipDateFor(holidayDelivery, sparse, offSparse)).toBe("2026-10-27");
    });

    it("isValidCustomerDelivery and isValidPurchaseArrival accept the arrival and refuse the day after", () => {
      expect(isValidCustomerDelivery(delivery, working, off)).toBe(true);
      expect(isValidPurchaseArrival(delivery, working, off)).toBe(true);
      // A Saturday is never an arrival in working-day mode.
      const saturday = addDays(delivery, (6 - new Date(`${delivery}T00:00:00Z`).getUTCDay() + 7) % 7 || 7);
      expect(isValidCustomerDelivery(saturday, working, off)).toBe(false);
      expect(isValidPurchaseArrival(saturday, working, off)).toBe(false);

      expect(isValidCustomerDelivery(sparseDelivery, sparse, offSparse)).toBe(true);
      expect(isValidPurchaseArrival(sparseDelivery, sparse, offSparse)).toBe(true);
      expect(isValidCustomerDelivery(addDays(sparseDelivery, 1), sparse, offSparse)).toBe(false);
      expect(isValidPurchaseArrival(addDays(sparseDelivery, 1), sparse, offSparse)).toBe(false);
      // The holiday Tuesday's would-be arrival has no dispatch.
      expect(isValidCustomerDelivery(addWorkingDays("2026-11-03", transit, offSparse), sparse, offSparse)).toBe(false);
    });

    it("suggestPurchaseDeliveryDate: the latest arrival before the demand, not late", () => {
      // Demand two working days after the earliest arrival: the dispatch
      // one working day after Monday still makes it (arrival = the working
      // day before the demand).
      const demand = addWorkingDays(delivery, 2, off);
      expect(
        suggestPurchaseDeliveryDate({ demandDate: demand, today, leadTimeDays: 0, settings: working, offDays: off })
      ).toEqual({ date: addWorkingDays(delivery, 1, off), late: false });

      // Tuesday dispatch: demand the working day after the arrival ⇒ that
      // arrival (the next Tuesday's would be too late).
      expect(
        suggestPurchaseDeliveryDate({
          demandDate: addWorkingDays(sparseDelivery, 1, offSparse),
          today,
          leadTimeDays: 0,
          settings: sparse,
          offDays: offSparse,
        })
      ).toEqual({ date: sparseDelivery, late: false });

      // Demand before the earliest arrival ⇒ the floor and late.
      expect(
        suggestPurchaseDeliveryDate({ demandDate: delivery, today, leadTimeDays: 0, settings: working, offDays: off })
      ).toEqual({ date: delivery, late: true });
    });
  });

  // The latest possible dispatch may be a weekend day when it is ticked: a
  // Saturday dispatch with one transit day arrives on Monday.
  it("a ticked Saturday with transit 1 ships the Saturday before a Monday delivery", () => {
    expect(shipDateFor("2026-10-26", s([6], "dispatch", 1), off)).toBe("2026-10-24");
    expect(isValidCustomerDelivery("2026-10-26", s([6], "dispatch", 1), off)).toBe(true);
  });

  // Equivalence with the previous definition (search back from the
  // delivery date itself) wherever that one could find an answer: every
  // date over four months, transit 0–8, many weekday sets, holidays.
  it("agrees with a brute-force search back from the delivery date", () => {
    const holidays = new Set(["2026-11-03", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01", "2027-01-06"]);
    const reference = (date: string, settings: DeliverySettings): string => {
      for (let i = 0, day = date; i <= 120; i++, day = addDays(day, -1)) {
        if (isListedDay(day, settings, holidays) && addWorkingDays(day, settings.transitDays, holidays) <= date) return day;
      }
      return date;
    };
    const weekdaySets = [[], [1], [6], [7], [2, 4], [5], [1, 2, 3, 4, 5, 6, 7]];
    for (let date = "2026-10-01"; date <= "2027-01-31"; date = addDays(date, 1)) {
      for (let transit = 0; transit <= 8; transit++) {
        for (const weekdays of weekdaySets) {
          const settings = s(weekdays, "dispatch", transit);
          if (!transit && !weekdays.length) continue; // short-circuit, not a search
          expect(shipDateFor(date, settings, holidays), `${date} transit ${transit} [${weekdays}]`).toBe(
            reference(date, settings)
          );
        }
      }
    }
  });
});

describe("delivery-days — isValidPurchaseArrival", () => {
  it("dispatch mode: Monday + 2 = Wednesday is valid, Thursday is not", () => {
    expect(isValidPurchaseArrival("2026-10-28", s([1], "dispatch", 2), off)).toBe(true);
    expect(isValidPurchaseArrival("2026-10-29", s([1], "dispatch", 2), off)).toBe(false);
  });

  it("arrival mode: only listed days", () => {
    expect(isValidPurchaseArrival("2026-10-26", s([1], "arrival"), off)).toBe(true);
    expect(isValidPurchaseArrival("2026-10-27", s([1], "arrival"), off)).toBe(false);
  });

  it("no dispatch day within the search window is not valid", () => {
    const sundays = new Set<string>();
    for (let d = "2026-08-16"; d < "2026-12-31"; d = addDays(d, 7)) sundays.add(d);
    expect(isValidPurchaseArrival("2026-10-20", s([7], "dispatch", 1), sundays)).toBe(false);
  });
});

describe("delivery-days — texts", () => {
  it("deliverySummary per side and mode", () => {
    expect(deliverySummary("supplier", s([1, 4], "dispatch", 2))).toBe(
      "Leverantören skickar mån, tor · 2 transportdagar"
    );
    expect(deliverySummary("supplier", s([1, 4], "arrival"))).toBe("Levereras till oss mån, tor");
    expect(deliverySummary("customer", s([1, 4], "dispatch", 1))).toBe("Vi skickar mån, tor · 1 transportdag");
    expect(deliverySummary("customer", s([2], "arrival"))).toBe("Kunden tar emot tis");
    expect(deliverySummary("customer", s([], "dispatch", 2))).toBe("2 transportdagar");
    expect(deliverySummary("supplier", none)).toBeNull();
  });

  it("deliveryDateWarning per side and mode", () => {
    expect(deliveryDateWarning("supplier", "2026-10-21", s([1], "arrival"), off)).toBe(
      "Leverantören levererar inte till oss på onsdagar."
    );
    expect(deliveryDateWarning("customer", "2026-10-21", s([1], "arrival"), off)).toBe(
      "Kunden tar inte emot leveranser på onsdagar."
    );
    expect(deliveryDateWarning("supplier", "2026-10-22", s([1, 4], "dispatch", 2), off)).toBe(
      "Datumet passar inte leverantörens avsändningsdagar (mån, tor + 2 transportdagar)."
    );
    expect(deliveryDateWarning("customer", "2026-10-22", s([1, 4], "dispatch", 2), off)).toBe(
      "Datumet passar inte våra avsändningsdagar till kunden (mån, tor + 2 transportdagar)."
    );
    expect(deliveryDateWarning("supplier", "2026-12-25", s([5], "arrival"), off)).toBe(
      "Leverantören levererar inte till oss på helgdagar."
    );
  });

  it("no warning without weekdays or for a valid date", () => {
    expect(deliveryDateWarning("supplier", "2026-10-17", s([], "arrival", 2), off)).toBeNull();
    expect(deliveryDateWarning("supplier", "2026-10-26", s([1], "arrival"), off)).toBeNull();
  });
});

describe("delivery-days — settings", () => {
  it("decodes missing or junk values to the defaults", () => {
    const defaults = { supplier: { mode: "arrival", transitDays: 0 }, customer: { mode: "dispatch", transitDays: 0 } };
    expect(decodeDeliveryDefaults(() => null)).toEqual(defaults);
    for (const junk of ["abc", "99", "weird", "-1", "1.5"]) {
      expect(decodeDeliveryDefaults(() => junk)).toEqual(defaults);
    }
  });

  it("decodes valid values", () => {
    const values: Record<string, string> = {
      supplier_delivery_day_mode: "dispatch",
      supplier_transit_days: "2",
      customer_delivery_day_mode: "arrival",
      customer_transit_days: "60",
    };
    expect(decodeDeliveryDefaults((k) => values[k])).toEqual({
      supplier: { mode: "dispatch", transitDays: 2 },
      customer: { mode: "arrival", transitDays: 60 },
    });
  });

  it("the partner's own values win, null falls back to the side's default", () => {
    const defaults = decodeDeliveryDefaults((k) =>
      k === "customer_delivery_day_mode" ? "arrival" : k === "customer_transit_days" ? "3" : null
    );
    expect(
      effectiveDeliverySettings({ deliveryWeekdays: [1], deliveryDayMode: null, transitDays: null }, "customer", defaults)
    ).toEqual({ weekdays: [1], mode: "arrival", transitDays: 3 });
    expect(
      effectiveDeliverySettings({ deliveryWeekdays: [], deliveryDayMode: "dispatch", transitDays: 0 }, "customer", defaults)
    ).toEqual({ weekdays: [], mode: "dispatch", transitDays: 0 });
  });

  it("deliveryHolidayWindow covers the searches both ways", () => {
    expect(deliveryHolidayWindow(["2026-10-17", "2026-11-01"], 5)).toEqual({ from: "2026-07-24", to: "2027-03-11" });
  });

  // A stored date near 9999 or 0001 (older orders predate the zod bound)
  // must not turn into a "+010000-…" string Postgres rejects with a 500.
  it("deliveryHolidayWindow is clamped to 1900-01-01…2999-12-31", () => {
    expect(deliveryHolidayWindow(["9999-12-31"], 60)).toEqual({
      from: addDays("2999-12-31", -(2 * 60 + 75)),
      to: "2999-12-31",
    });
    expect(deliveryHolidayWindow(["0001-01-01"], 0)).toEqual({ from: "1900-01-01", to: "1900-05-01" });
    expect(deliveryHolidayWindow(["0001-01-01", "9999-12-31"], 0)).toEqual({ from: "1900-01-01", to: "2999-12-31" });
    // The extremes of the range itself stay inside it.
    expect(deliveryHolidayWindow(["2999-12-31"], 0).to).toBe("2999-12-31");
    expect(deliveryHolidayWindow(["1900-01-01"], 0).from).toBe("1900-01-01");
  });

  it("shipDateFor copes with a delivery date at the end of the calendar", () => {
    // Friday 9999-12-31, two transit days ⇒ Wednesday; nothing counts forward.
    expect(shipDateFor("9999-12-31", s([], "dispatch", 2), off)).toBe("9999-12-29");
    // 43 working days back from a Friday is a Tuesday; the Monday before it.
    expect(shipDateFor("9999-12-31", s([1], "dispatch", 43), off)).toBe(subtractWorkingDays("9999-12-31", 44, off));
  });
});

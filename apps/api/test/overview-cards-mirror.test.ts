import { describe, expect, it } from "vitest";
import { ALERT_KINDS, DEFAULT_OVERVIEW_CARDS, OVERVIEW_CARDS, overviewCardsSchema } from "@navet/shared";
// The web mirror (the web can't import @navet/shared) — loaded directly so
// the two lists can never drift.
import * as web from "../../web/lib/overviewCards.js";
import { alertRows, capacityRows, deliveryRows, deviationRows, endOfIsoWeek } from "../../web/lib/overviewCardRows.js";
import type { CapacityResult } from "../../web/lib/types.js";

// Fler kort på Översikten: the card registry, the standard, the gate and
// the layout rule.
describe("Översiktens kort", () => {
  it("web mirror is identical, and every card has a label and a width", () => {
    expect([...web.OVERVIEW_CARDS]).toEqual([...OVERVIEW_CARDS]);
    expect([...web.DEFAULT_OVERVIEW_CARDS]).toEqual([...DEFAULT_OVERVIEW_CARDS]);
    for (const card of OVERVIEW_CARDS) {
      expect(web.OVERVIEW_CARD_LABELS[card]).toBeTruthy();
      expect(typeof web.OVERVIEW_CARD_HALF[card]).toBe("boolean");
    }
    for (const kind of Object.values(web.OVERVIEW_CARD_ALERT_KIND)) expect(ALERT_KINDS).toContain(kind);
  });

  it("keeps the standard at the four original cards — a new card never appears unpicked", () => {
    expect([...DEFAULT_OVERVIEW_CARDS]).toEqual(["flow", "attention", "orders", "stock"]);
    expect(web.resolveOverviewCards(null)).toEqual(["flow", "attention", "orders", "stock"]);
    expect(web.resolveOverviewCards(["quotes", "bogus", "quotes", "flow"])).toEqual(["quotes", "flow"]);
    expect(overviewCardsSchema.safeParse([...OVERVIEW_CARDS]).success).toBe(true);
    expect(overviewCardsSchema.safeParse(["quotes", "quotes"]).success).toBe(false);
  });

  it("offers a newer card only to a user who may open its list; the four originals to everyone", () => {
    const sales = { role: "user" as const, permissions: ["forsaljning" as const] };
    const purchasing = { role: "user" as const, permissions: ["inkop" as const] };
    const admin = { role: "admin" as const, permissions: [] };
    const offered = (user: typeof sales | typeof purchasing | typeof admin) =>
      OVERVIEW_CARDS.filter((card) => web.overviewCardAvailable(user, card));
    expect(offered(sales)).toEqual(["flow", "attention", "orders", "stock", "favorites", "deliveries", "receivables", "quotes"]);
    expect(offered(purchasing)).toEqual(["flow", "attention", "orders", "stock", "favorites", "arrivals", "payables"]);
    expect(offered(admin)).toEqual([...OVERVIEW_CARDS]);
  });

  it("Favoriter in the user menu: Menyn, Översikten or Båda sets the sidebar and the card together", () => {
    expect(web.favoritesPlacement(true, false)).toBe("sidebar");
    expect(web.favoritesPlacement(false, true)).toBe("overview");
    expect(web.favoritesPlacement(true, true)).toBe("both");
    expect(web.favoritesPlacement(false, false)).toBeNull();
    // The standard has no Favoriter card; adding one puts it first, after
    // that the standard is a list of its own.
    expect(web.hasFavoritesCard(null)).toBe(false);
    expect(web.overviewCardsWithFavorites(null, false)).toBeUndefined();
    expect(web.overviewCardsWithFavorites(null, true)).toEqual(["favorites", "flow", "attention", "orders", "stock"]);
    expect(web.overviewCardsWithFavorites(["quotes", "favorites"], true)).toBeUndefined();
    expect(web.overviewCardsWithFavorites(["quotes", "favorites", "bogus"], false)).toEqual(["quotes"]);
    expect(web.overviewCardsWithFavorites(["favorites"], false)).toEqual([]);
    expect(web.hasFavoritesCard(["quotes", "favorites"])).toBe(true);
    // Every list it writes is one PATCH /me/settings takes.
    expect(overviewCardsSchema.safeParse(web.overviewCardsWithFavorites(null, true)).success).toBe(true);
    expect(overviewCardsSchema.safeParse(web.overviewCardsWithFavorites(["favorites"], false)).success).toBe(true);
  });

  it("pairs two half cards on a row and gives a lone half card the full width", () => {
    expect(web.overviewRows(["flow", "quotes", "deliveries", "capacity", "stock", "deviations"])).toEqual([
      ["flow"],
      ["quotes", "deliveries"],
      ["capacity"],
      ["stock"],
      ["deviations"],
    ]);
  });

  it("ends the week on Sunday — a Sunday is its own week's end", () => {
    expect(endOfIsoWeek("2026-11-09")).toBe("2026-11-15"); // Monday
    expect(endOfIsoWeek("2026-11-12")).toBe("2026-11-15");
    expect(endOfIsoWeek("2026-11-15")).toBe("2026-11-15"); // Sunday
    expect(endOfIsoWeek("2026-12-30")).toBe("2027-01-03"); // across the year
  });

  it("builds the rows: late red, today yellow, the most loaded resource first, overdue cases first and once", () => {
    const today = "2026-11-10";
    expect(
      deliveryRows(
        [
          { id: "a", orderNumber: "KO-1", counterpartyName: "Exempel Storkök AB", nextDeliveryDate: "2026-11-01" },
          { id: "b", orderNumber: "KO-2", counterpartyName: null, nextDeliveryDate: today },
          { id: "c", orderNumber: "KO-3", counterpartyName: "Exempel AB", nextDeliveryDate: "2026-11-13" },
        ],
        today,
        "/forsaljning/ordrar"
      ).map((r) => [r.primary, r.tone, r.secondary, r.aside, r.href])
    ).toEqual([
      ["KO-1 · Exempel Storkök AB", "red", "Försenad", "2026-11-01", "/forsaljning/ordrar/a"],
      ["KO-2", "yellow", "I dag", today, "/forsaljning/ordrar/b"],
      ["KO-3 · Exempel AB", null, "", "2026-11-13", "/forsaljning/ordrar/c"],
    ]);

    const cell = (loadHours: number, availableHours: number | null) => ({
      loadHours,
      availableHours,
      loadPercent: availableHours ? (loadHours / availableHours) * 100 : null,
      orders: [],
    });
    const resource = (code: string, c: ReturnType<typeof cell>, active = true) => ({
      workCenterId: code,
      code,
      name: `Resurs ${code}`,
      type: "machine" as const,
      active,
      capacityFactor: 1,
      hasSchedule: c.availableHours !== null,
      weeks: [c],
      later: cell(0, null),
      undated: cell(0, null),
    });
    const capacity = {
      weeks: [],
      summary: {},
      groups: [
        {
          productionGroupId: null,
          code: null,
          name: "Ogrupperade resurser",
          resources: [resource("100", cell(20, 40)), resource("200", cell(44, 40)), resource("300", cell(5, null)), resource("400", cell(0, 0)), resource("500", cell(36, 40), false), resource("600", cell(36, 40))],
          weekTotals: [],
          laterTotal: cell(0, null),
          undatedTotal: cell(0, null),
        },
      ],
    } as unknown as CapacityResult;
    const { rows, total } = capacityRows(capacity, "/tillverkning/belaggning");
    expect(rows.map((r) => [r.primary, r.aside, r.tone, r.secondary])).toEqual([
      ["200 Resurs 200", "110 %", "red", "44,0 h av 40,0 h"],
      ["600 Resurs 600", "90 %", "yellow", "36,0 h av 40,0 h"],
      ["100 Resurs 100", "50 %", null, "20,0 h av 40,0 h"],
      ["300 Resurs 300", "–", null, "5,0 h · inget schema"],
    ]);
    expect(total).toBe(4); // the inactive one and the one without load or capacity are left out

    const caseRow = (id: string, overdue: boolean) => ({
      id,
      deviationNumber: `AV-${id}`,
      type: "customer",
      title: "Repig plåt",
      counterpartyName: "Exempel Storkök AB",
      dueDate: "2026-11-01",
      overdue,
    });
    expect(
      deviationRows([caseRow("2", true)], [caseRow("3", false), caseRow("2", true)], { customer: "Kundreklamation" }).map((r) => [
        r.primary,
        r.tone,
        r.secondary,
      ])
    ).toEqual([
      ["AV-2 Repig plåt", "red", "Kundreklamation · Exempel Storkök AB · Försenad"],
      ["AV-3 Repig plåt", null, "Kundreklamation · Exempel Storkök AB"],
    ]);

    expect(alertRows(undefined)).toEqual([]);
    expect(
      alertRows({
        kind: "quote_followup",
        label: "Offerter att följa upp",
        severity: "yellow",
        count: 1,
        listHref: "/forsaljning/offerter?status=quote",
        error: false,
        message: null,
        items: [{ key: "q", severity: "red", href: "/forsaljning/offerter/q", primary: "OF-1", secondary: null, date: null }],
      })
    ).toEqual([{ key: "q", href: "/forsaljning/offerter/q", tone: "red", primary: "OF-1", secondary: "" }]);
  });
});

import { describe, expect, it } from "vitest";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";
import { evaluateCloseBlockers, evaluateStepBlockers, evaluateWarnings, type StepGateInput } from "../src/modules/economy/service/year-end-checks.js";

const GATE: StepGateInput = {
  today: "2025-02-10",
  closingDate: "2024-12-31",
  draftCount: 0,
  previousYear: null,
  closingPeriodStatus: "open",
};

describe("evaluateStepBlockers", () => {
  it("is empty when nothing blocks", () => {
    expect(evaluateStepBlockers(GATE)).toEqual([]);
  });

  it("names each blocker", () => {
    const codes = evaluateStepBlockers({
      today: "2024-12-31",
      closingDate: "2024-12-31",
      draftCount: 2,
      previousYear: { label: "2023", status: "open" },
      closingPeriodStatus: "locked",
    }).map((check) => check.code);
    expect(codes).toEqual(["draft-verifications", "previous-year-open", "closing-period-locked", "closing-date-not-passed"]);
  });

  it("lets a closed previous year and a passed closing day through", () => {
    expect(evaluateStepBlockers({ ...GATE, previousYear: { label: "2023", status: "closed" }, today: "2025-01-01" })).toEqual([]);
  });

  it("counts drafts in the message", () => {
    expect(evaluateStepBlockers({ ...GATE, draftCount: 3 })[0]!.message).toBe(
      "3 verifikatutkast i räkenskapsåret måste bokföras eller tas bort"
    );
  });
});

const CLEAN = {
  unsettledVatMonths: [],
  receivables: { accountNumber: "1510", ledger: 245000, register: 245000 },
  payables: { accountNumber: "2440", ledger: 6500, register: 6500 },
  fixedAssetMismatches: [],
  revenueWithoutVatBox: [],
  inventoryStale: null,
};

describe("evaluateWarnings", () => {
  it("is empty when everything reconciles", () => {
    expect(evaluateWarnings(CLEAN)).toEqual([]);
  });

  it("warns when the inventory account drifted after steg 2", () => {
    const [warning] = evaluateWarnings({ ...CLEAN, inventoryStale: { ledger: 213450, value: 212450 } });
    expect(warning!.code).toBe("inventory-stale");
    expect(warning!.message).toContain(formatNumber(212450));
  });

  it("phrases the receivables difference as ledger − register", () => {
    const [warning] = evaluateWarnings({ ...CLEAN, receivables: { accountNumber: "1510", ledger: 245000, register: 245060 } });
    expect(warning).toEqual({
      code: "receivables-mismatch",
      message: `Kundreskontran stämmer inte mot konto 1510: huvudbok ${formatNumber(245000)}, reskontra ${formatNumber(245060)} (skillnad ${formatNumber(-60)})`,
    });
  });

  // A reskontra the Bokslut page could not read is null — its check-failed
  // warning says so; no mismatch is made up.
  it("says nothing about a reskontra that could not be checked", () => {
    expect(evaluateWarnings({ ...CLEAN, receivables: null, payables: null })).toEqual([]);
  });

  it("prefixes a positive payables difference with +", () => {
    const [warning] = evaluateWarnings({ ...CLEAN, payables: { accountNumber: "2440", ledger: 7000, register: 6500 } });
    expect(warning!.message).toContain(`(skillnad +${formatNumber(500)})`);
  });

  it("lists unsettled VAT months, register mismatches and revenue without a box", () => {
    const warnings = evaluateWarnings({
      ...CLEAN,
      unsettledVatMonths: ["2024-11", "2024-12"],
      fixedAssetMismatches: ["1220 Inventarier och verktyg: huvudbok 0,00, register 120 000,00 (skillnad -120 000,00)"],
      revenueWithoutVatBox: [{ accountNumber: "3899", accountName: "Övrigt", net: 500 }],
    });
    expect(warnings.map((w) => w.code)).toEqual(["vat-unsettled", "fixed-assets-mismatch", "revenue-without-vat-box"]);
    expect(warnings[0]!.message).toBe(
      "Momsen är inte omförd för: november 2024, december 2024 — efter stängningen kan den inte bokföras i året"
    );
    expect(warnings[2]!.message).toBe("Intäkter på konton utan momsruta: 3899 Övrigt");
  });
});

describe("evaluateCloseBlockers", () => {
  const READY = {
    ...GATE,
    yearEndDate: "2024-12-31",
    inventoryDone: true,
    missingDepreciationAssets: 0,
    accrualsDone: true,
    resultNet: 0,
    openingBalanceImports: [],
    openingBalanceDifferences: 0,
  };

  it("is empty when every step is done and the result is transferred", () => {
    expect(evaluateCloseBlockers(READY)).toEqual([]);
  });

  it("ignores a locked closing month (closing locks it anyway) but keeps the other step blockers", () => {
    expect(evaluateCloseBlockers({ ...READY, closingPeriodStatus: "locked" })).toEqual([]);
    expect(evaluateCloseBlockers({ ...READY, draftCount: 1 }).map((c) => c.code)).toEqual(["draft-verifications"]);
  });

  it("names every undone step and the opening-balance import", () => {
    const codes = evaluateCloseBlockers({
      ...READY,
      inventoryDone: false,
      missingDepreciationAssets: 2,
      accrualsDone: false,
      resultNet: 437250,
      openingBalanceImports: ["I-2025-1"],
      openingBalanceDifferences: 2,
    }).map((c) => c.code);
    expect(codes).toEqual([
      "inventory-not-done",
      "depreciation-missing",
      "accruals-not-done",
      "result-not-transferred",
      "next-year-opening-balance-import",
    ]);
  });

  it("explains the opening-balance import with the verification number", () => {
    const [check] = evaluateCloseBlockers({ ...READY, openingBalanceImports: ["I-2025-1"], openingBalanceDifferences: 2 });
    expect(check!.message).toBe(
      "Nästa räkenskapsår har importerade ingående balanser (I-2025-1) som dubblerar årets utgående balanser — omför I-2025-1 innan året stängs"
    );
  });

  it("refuses a year whose last day is today or later, and allows it the day after", () => {
    const early = { ...READY, closingDate: "2024-12-20" };
    for (const today of ["2024-12-31", "2024-12-21"]) {
      expect(evaluateCloseBlockers({ ...early, today })).toEqual([
        {
          code: "fiscal-year-not-ended",
          message: "Räkenskapsåret slutar 2024-12-31 — det kan stängas tidigast dagen efter",
        },
      ]);
    }
    expect(evaluateCloseBlockers({ ...early, today: "2025-01-01" })).toEqual([]);
  });

  it("gives one blocker, not two, when the closing day is the year's last day and neither has passed", () => {
    // closingDate = yearEndDate = 2024-12-31 in READY.
    expect(evaluateCloseBlockers({ ...READY, today: "2024-12-31" }).map((c) => c.code)).toEqual(["fiscal-year-not-ended"]);
    // An earlier closing day that has passed while the year has not: still one.
    expect(evaluateCloseBlockers({ ...READY, closingDate: "2024-12-20", today: "2024-12-25" }).map((c) => c.code)).toEqual([
      "fiscal-year-not-ended",
    ]);
  });

  it("does not gate the steps on the year's end (only the close)", () => {
    expect(evaluateStepBlockers({ ...GATE, closingDate: "2024-12-20", today: "2024-12-21" })).toEqual([]);
  });

  it("blocks on an IB difference even without an unreversed import", () => {
    const blockers = evaluateCloseBlockers({ ...READY, openingBalanceDifferences: 2 });
    expect(blockers).toEqual([
      {
        code: "next-year-opening-balance-import",
        message:
          "Nästa räkenskapsårs ingående balanser skiljer sig från årets utgående balanser på 2 konton — se IB-avstämningen innan året stängs",
      },
    ]);
  });
});

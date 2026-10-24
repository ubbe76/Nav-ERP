import { describe, expect, it } from "vitest";
import { toSek } from "@navet/shared";
import {
  fxRevaluationEntries,
  revalue,
  revalueItem,
  sameNetAmounts,
  sameRates,
  type FxOpenItem,
} from "../src/modules/economy/service/fx-revaluation.js";
import { evaluateCloseBlockers, evaluateWarnings, type CloseGateInput, type WarningInput } from "../src/modules/economy/service/year-end-checks.js";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";

// Valuta steg 4: the valutaomvärdering's pure arithmetic and its checks.

function item(overrides: Partial<FxOpenItem>): FxOpenItem {
  return {
    side: "receivable",
    id: crypto.randomUUID(),
    number: "FA-1",
    partnerName: "Kund GmbH",
    currency: "EUR",
    exchangeRate: 11,
    openAmount: 1000,
    openAmountSek: 11000,
    ...overrides,
  };
}

const sum = (entries: { amount: number }[]) => Math.round(entries.reduce((s, e) => s + e.amount * 100, 0)) / 100;

describe("revalueItem — one invoice", () => {
  it("is the balance day's toSek minus the booked open SEK, to the öre", () => {
    expect(revalueItem(1000, 11000, 11.5)).toEqual({ revaluedSek: 11500, difference: 500 });
    expect(revalueItem(1000, 11000, 10.75)).toEqual({ revaluedSek: 10750, difference: -250 });
    // Unchanged rate, nothing to revalue.
    expect(revalueItem(1000, 11000, 11)).toEqual({ revaluedSek: 11000, difference: 0 });
  });

  it("rounds through toSek, half away from zero, also for a negative (credit) open amount", () => {
    // 0.05 × 11.13 = 0.5565 ⇒ 0.56; −0.05 ⇒ −0.56 (a float round2 would give −0.55).
    expect(revalueItem(0.05, 0.55, 11.13)).toEqual({ revaluedSek: 0.56, difference: 0.01 });
    expect(revalueItem(-0.05, -0.55, 11.13)).toEqual({ revaluedSek: -0.56, difference: -0.01 });
    expect(revalueItem(-1000, -11000, 11.5)).toEqual({ revaluedSek: -11500, difference: -500 });
  });

  it("revalues a partly paid invoice on what is left, against the SEK still booked", () => {
    // 1000 EUR booked at 11.131 = 11131.00; 400 EUR paid released 4452.40.
    const bookedLeft = Math.round((11131 - toSek(400, 11.131)) * 100) / 100;
    expect(bookedLeft).toBe(6678.6);
    expect(revalueItem(600, bookedLeft, 11.2)).toEqual({ revaluedSek: 6720, difference: 41.4 });
  });

  it("brings a booked SEK value with nothing left in the currency to 0", () => {
    expect(revalueItem(0, 0.03, 11.2)).toEqual({ revaluedSek: 0, difference: -0.03 });
  });
});

describe("revalue — the whole step", () => {
  it("sums per currency and side from each invoice's own öre", () => {
    const result = revalue(
      [
        item({ openAmount: 0.05, openAmountSek: 0.55 }),
        item({ openAmount: 0.05, openAmountSek: 0.55 }),
        item({ currency: "USD", openAmount: 100, openAmountSek: 1000, exchangeRate: 10 }),
        item({ side: "payable", openAmount: 500, openAmountSek: 5500, number: "LF-1 (A1)" }),
      ],
      new Map([
        ["EUR", 11.13],
        ["USD", 9.5],
      ])
    );
    // Per invoice 0.56 each — the currency total is 1.12, not toSek(0.10) = 1.11.
    expect(result.receivable.currencies).toEqual([
      { currency: "EUR", rate: 11.13, invoiceCount: 2, openAmount: 0.1, bookedSek: 1.1, revaluedSek: 1.12, difference: 0.02 },
      { currency: "USD", rate: 9.5, invoiceCount: 1, openAmount: 100, bookedSek: 1000, revaluedSek: 950, difference: -50 },
    ]);
    expect(result.receivable).toMatchObject({ invoiceCount: 3, bookedSek: 1001.1, revaluedSek: 951.12, difference: -49.98 });
    expect(result.payable).toMatchObject({ invoiceCount: 1, bookedSek: 5500, revaluedSek: 5565, difference: 65 });
    // Receivables −49.98 and a payable growing by 65: result −114.98.
    expect(result.resultEffect).toBe(-114.98);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("lists a currency without a rate as missing and leaves its sums open", () => {
    const result = revalue([item({}), item({ currency: "NOK", openAmountSek: 1000, exchangeRate: 1 })], new Map([["EUR", 11.5]]));
    expect(result.missingCurrencies).toEqual(["NOK"]);
    expect(result.receivable.currencies.find((c) => c.currency === "NOK")).toMatchObject({ rate: null, revaluedSek: null, difference: null });
    expect(result.receivable.difference).toBeNull();
    expect(result.resultEffect).toBeNull();
    expect(() => fxRevaluationEntries(result)).toThrow();
  });

  it("is empty for no items", () => {
    const result = revalue([], new Map());
    expect(result.receivable).toEqual({ invoiceCount: 0, bookedSek: 0, revaluedSek: 0, difference: 0, currencies: [] });
    expect(result.resultEffect).toBe(0);
    expect(fxRevaluationEntries(result)).toEqual([]);
  });
});

describe("fxRevaluationEntries — the verification", () => {
  it("debits receivables and credits kursvinst for a stronger EUR; credits payables and debits kursförlust", () => {
    const result = revalue(
      [item({}), item({ side: "payable", openAmount: 500, openAmountSek: 5500 })],
      new Map([["EUR", 11.5]])
    );
    expect(fxRevaluationEntries(result)).toEqual([
      { role: "receivable", amount: 500 },
      { role: "payable", amount: -250 },
      { role: "gain", amount: -500 },
      { role: "loss", amount: 250 },
    ]);
  });

  it("mirrors both for a weaker EUR", () => {
    const result = revalue(
      [item({}), item({ side: "payable", openAmount: 500, openAmountSek: 5500 })],
      new Map([["EUR", 10.5]])
    );
    expect(fxRevaluationEntries(result)).toEqual([
      { role: "receivable", amount: -500 },
      { role: "payable", amount: 250 },
      { role: "gain", amount: -250 },
      { role: "loss", amount: 500 },
    ]);
  });

  it("nets each reskontra account but keeps gains and losses per currency gross, and always balances", () => {
    const result = revalue(
      [
        item({}), // EUR +500
        item({ currency: "USD", openAmount: 100, openAmountSek: 1000, exchangeRate: 10 }), // USD −50
        item({ side: "payable", currency: "USD", openAmount: 200, openAmountSek: 2000, exchangeRate: 10 }), // debt −100 ⇒ gain
      ],
      new Map([
        ["EUR", 11.5],
        ["USD", 9.5],
      ])
    );
    const entries = fxRevaluationEntries(result);
    expect(entries).toEqual([
      { role: "receivable", amount: 450 },
      { role: "payable", amount: 100 },
      { role: "gain", amount: -600 },
      { role: "loss", amount: 50 },
    ]);
    expect(sum(entries)).toBe(0);
  });

  it("revalues a credit note (negative open amount) the other way", () => {
    const result = revalue([item({ number: "FA-2", openAmount: -1000, openAmountSek: -11000 })], new Map([["EUR", 11.5]]));
    expect(fxRevaluationEntries(result)).toEqual([
      { role: "receivable", amount: -500 },
      { role: "loss", amount: 500 },
    ]);
  });

  it("books nothing when the rate equals the booked one", () => {
    expect(fxRevaluationEntries(revalue([item({})], new Map([["EUR", 11]])))).toEqual([]);
  });
});

describe("re-run comparisons", () => {
  it("compares net amounts per account, order and splits aside", () => {
    expect(sameNetAmounts([{ accountId: "a", amount: 1 }, { accountId: "b", amount: -1 }], [{ accountId: "b", amount: -1 }, { accountId: "a", amount: 1 }])).toBe(true);
    expect(sameNetAmounts([{ accountId: "a", amount: 0.3 }, { accountId: "a", amount: 0.2 }], [{ accountId: "a", amount: 0.5 }])).toBe(true);
    expect(sameNetAmounts([{ accountId: "a", amount: 0.5 }], [{ accountId: "a", amount: 0.51 }])).toBe(false);
    expect(sameNetAmounts([], [{ accountId: "a", amount: 0 }])).toBe(true);
  });

  it("compares rates per currency, source and day aside", () => {
    const riksbank = { currency: "EUR", rate: 11.5, date: "2024-12-31", source: "riksbank" as const };
    expect(sameRates([riksbank], [{ ...riksbank, date: null, source: "step" }])).toBe(true);
    expect(sameRates([riksbank], [{ ...riksbank, rate: 11.4 }])).toBe(false);
    expect(sameRates([riksbank], [])).toBe(false);
    expect(sameRates([], [])).toBe(true);
  });
});

describe("checks", () => {
  const gate: CloseGateInput = {
    today: "2025-02-10",
    closingDate: "2024-12-31",
    draftCount: 0,
    previousYear: null,
    closingPeriodStatus: "open",
    yearEndDate: "2024-12-31",
    inventoryDone: true,
    missingDepreciationAssets: 0,
    accrualsDone: true,
    resultNet: 0,
    openingBalanceImports: [],
    openingBalanceDifferences: 0,
  };

  it("blocks the close only while foreign items wait for the revaluation", () => {
    expect(evaluateCloseBlockers(gate)).toEqual([]);
    expect(evaluateCloseBlockers({ ...gate, fxRevaluation: { openItems: 0, done: false } })).toEqual([]);
    expect(evaluateCloseBlockers({ ...gate, fxRevaluation: { openItems: 2, done: true } })).toEqual([]);
    expect(evaluateCloseBlockers({ ...gate, fxRevaluation: { openItems: 2, done: false } })).toEqual([
      {
        code: "fx-revaluation-not-done",
        message: "Valutaomvärderingen är inte gjord — 2 öppna fakturor i annan valuta än SEK per bokslutsdagen",
      },
    ]);
  });

  const clean: WarningInput = {
    unsettledVatMonths: [],
    receivables: { accountNumber: "1510", ledger: 11500, register: 11000, revaluation: 500 },
    payables: { accountNumber: "2440", ledger: 5750, register: 5500, revaluation: 250 },
    fixedAssetMismatches: [],
    revenueWithoutVatBox: [],
    inventoryStale: null,
  };

  it("reconciles the ledger against the reskontra plus the revaluation", () => {
    expect(evaluateWarnings(clean)).toEqual([]);
    const [warning] = evaluateWarnings({ ...clean, receivables: { ...clean.receivables, ledger: 11440 } });
    expect(warning).toEqual({
      code: "receivables-mismatch",
      message: `Kundreskontran stämmer inte mot konto 1510: huvudbok ${formatNumber(11440)}, reskontra ${formatNumber(11000)} + valutaomvärdering ${formatNumber(500)} (skillnad ${formatNumber(-60)})`,
    });
    const [loss] = evaluateWarnings({ ...clean, payables: { accountNumber: "2440", ledger: 5000, register: 5500, revaluation: -250 } });
    expect(loss!.message).toBe(
      `Leverantörsreskontran stämmer inte mot konto 2440: huvudbok ${formatNumber(5000)}, reskontra ${formatNumber(5500)} - valutaomvärdering ${formatNumber(250)} (skillnad ${formatNumber(-250)})`
    );
  });

  it("warns when the booked revaluation is stale", () => {
    expect(evaluateWarnings({ ...clean, fxRevaluationStale: true })).toEqual([
      {
        code: "fx-revaluation-stale",
        message: "De öppna valutaposterna har ändrats sedan valutaomvärderingen bokfördes — gör om valutaomvärderingen",
      },
    ]);
  });
});

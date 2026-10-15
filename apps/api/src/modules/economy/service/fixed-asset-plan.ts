import { round2 } from "@navet/shared";

// Avskrivningsplan (spec 4): per asset and category for one fiscal year,
// plus the reconciliation of the register against the asset/ack accounts.
// Pure — the service loads the inputs, this never touches the database.
//
// A depreciation row belongs to its RUN'S VERIFICATION DATE, not to its
// month: that is the date the ledger carries, so the plan agrees with the
// general ledger for the same date (a run through June dated 30/6 lands in
// June; a January catch-up booked in June lands in June — exactly like the
// ledger).

export interface PlanFiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

export interface PlanAssetInput {
  id: string;
  assetNumber: string;
  name: string;
  categoryId: string;
  acquisitionDate: string;
  acquisitionCost: number;
  disposalDate: string | null;
  // Ingående avskrivning: depreciation booked before the company used Nav. It
  // is already in the ledger's opening balance (SIE IB), so it is never a
  // movement here — always part of the asset's opening accumulated depreciation.
  openingDepreciation?: number;
  // Live rows only (superseded_by_run_id IS NULL), dated by their run.
  depreciations: { date: string; amount: number }[];
}

export interface PlanAccount {
  id: string;
  number: string;
  name: string;
}

export interface PlanCategoryInput {
  id: string;
  name: string;
  assetAccount: PlanAccount;
  accumulatedAccount: PlanAccount;
}

export interface PlanTotals {
  acquisitionOpening: number;
  acquisitions: number;
  disposals: number;
  acquisitionClosing: number;
  depreciationOpening: number;
  depreciationYear: number;
  depreciationDisposed: number;
  depreciationClosing: number;
  bookValueClosing: number;
}

export interface PlanAssetRow extends PlanTotals {
  assetId: string;
  assetNumber: string;
  name: string;
  categoryId: string;
  categoryName: string;
  acquisitionDate: string;
  disposalDate: string | null;
}

export interface PlanCategoryBlock {
  categoryId: string;
  categoryName: string;
  assetAccountNumber: string;
  accumulatedAccountNumber: string;
  assets: PlanAssetRow[];
  totals: PlanTotals;
}

export interface ReconciliationRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  kind: "asset" | "accumulated";
  registerAmount: number;
  // Asset account: debit − credit. Ack account: credit − debit (shown positive).
  ledgerAmount: number;
  difference: number; // ledger − register
  mismatch: boolean;
}

export interface FixedAssetPlan {
  fiscalYear: PlanFiscalYear;
  categories: PlanCategoryBlock[];
  totals: PlanTotals;
  reconciliation: ReconciliationRow[];
}

const TOTAL_KEYS: (keyof PlanTotals)[] = [
  "acquisitionOpening",
  "acquisitions",
  "disposals",
  "acquisitionClosing",
  "depreciationOpening",
  "depreciationYear",
  "depreciationDisposed",
  "depreciationClosing",
  "bookValueClosing",
];

function emptyTotals(): PlanTotals {
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0])) as unknown as PlanTotals;
}

function addTotals(into: PlanTotals, row: PlanTotals): void {
  for (const key of TOTAL_KEYS) into[key] = round2(into[key] + row[key]);
}

function inYear(date: string, year: PlanFiscalYear): boolean {
  return date >= year.startDate && date <= year.endDate;
}

export function buildFixedAssetPlan(input: {
  fiscalYear: PlanFiscalYear;
  categories: PlanCategoryInput[];
  assets: PlanAssetInput[];
  ledgerBalances: { accountId: string; debit: number; credit: number }[];
}): FixedAssetPlan {
  const { fiscalYear: year } = input;
  const blocks = new Map<string, PlanCategoryBlock>(
    input.categories.map((category) => [
      category.id,
      {
        categoryId: category.id,
        categoryName: category.name,
        assetAccountNumber: category.assetAccount.number,
        accumulatedAccountNumber: category.accumulatedAccount.number,
        assets: [],
        totals: emptyTotals(),
      },
    ])
  );

  for (const asset of input.assets) {
    // Not yet acquired, or gone before the year started: not in this year's plan.
    if (asset.acquisitionDate > year.endDate) continue;
    if (asset.disposalDate !== null && asset.disposalDate < year.startDate) continue;
    const block = blocks.get(asset.categoryId);
    if (!block) continue;

    const disposedInYear = asset.disposalDate !== null && inYear(asset.disposalDate, year);
    const acquisitionOpening = asset.acquisitionDate < year.startDate ? asset.acquisitionCost : 0;
    const acquisitions = inYear(asset.acquisitionDate, year) ? asset.acquisitionCost : 0;
    const disposals = disposedInYear ? -asset.acquisitionCost : 0;
    const acquisitionClosing = round2(acquisitionOpening + acquisitions + disposals);
    const depreciationOpening = round2(
      (asset.openingDepreciation ?? 0) +
        asset.depreciations.filter((row) => row.date < year.startDate).reduce((sum, row) => sum + row.amount, 0)
    );
    const depreciationYear = round2(
      asset.depreciations.filter((row) => inYear(row.date, year)).reduce((sum, row) => sum + row.amount, 0)
    );
    const depreciationDisposed = disposedInYear ? -round2(depreciationOpening + depreciationYear) : 0;
    const depreciationClosing = round2(depreciationOpening + depreciationYear + depreciationDisposed);
    const row: PlanAssetRow = {
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      name: asset.name,
      categoryId: asset.categoryId,
      categoryName: block.categoryName,
      acquisitionDate: asset.acquisitionDate,
      disposalDate: asset.disposalDate,
      acquisitionOpening,
      acquisitions,
      disposals,
      acquisitionClosing,
      depreciationOpening,
      depreciationYear,
      depreciationDisposed,
      depreciationClosing,
      bookValueClosing: round2(acquisitionClosing - depreciationClosing),
    };
    block.assets.push(row);
    addTotals(block.totals, row);
  }

  const categories = [...blocks.values()];
  const totals = emptyTotals();
  for (const block of categories) addTotals(totals, block.totals);

  // Reconciliation per ACCOUNT: categories sharing an account are summed.
  const register = new Map<string, { account: PlanAccount; kind: "asset" | "accumulated"; amount: number }>();
  for (const category of input.categories) {
    const block = blocks.get(category.id)!;
    for (const [account, kind, amount] of [
      [category.assetAccount, "asset", block.totals.acquisitionClosing],
      [category.accumulatedAccount, "accumulated", block.totals.depreciationClosing],
    ] as const) {
      const current = register.get(account.id) ?? { account, kind, amount: 0 };
      current.amount = round2(current.amount + amount);
      register.set(account.id, current);
    }
  }
  const ledgerByAccount = new Map(input.ledgerBalances.map((row) => [row.accountId, round2(row.debit - row.credit)]));
  const reconciliation = [...register.values()]
    .map(({ account, kind, amount }) => {
      const balance = ledgerByAccount.get(account.id) ?? 0;
      const ledgerAmount = kind === "asset" ? balance : round2(-balance);
      const difference = round2(ledgerAmount - amount);
      return {
        accountId: account.id,
        accountNumber: account.number,
        accountName: account.name,
        kind,
        registerAmount: amount,
        ledgerAmount,
        difference,
        mismatch: difference !== 0,
      };
    })
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return { fiscalYear: year, categories, totals, reconciliation };
}

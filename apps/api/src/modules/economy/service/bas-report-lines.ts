// Report layout for the balance sheet and income statement (B6a). Pure leaf —
// no database, no imports — in the same spirit as bas-accounts.ts and
// month-periods.ts, so the whole classification can be unit-tested in
// milliseconds.
//
// The accounts table has no type/class column: the BAS class lives in the
// leading digit of the 4-digit number. This file is the one place that turns
// a number into a report line.
//
// INVARIANT: the intervals below cover "0000"–"9999" EXACTLY ONCE, so
// classifyAccount is a total function that never returns null. That is what
// keeps the balance sheet balanced — a posting on a class 0 or 9 account
// still lands somewhere (under "Ej klassificerade konton" on the asset side)
// instead of silently vanishing from the report. The coverage is enforced by
// a test that walks all 10 000 numbers.
//
// Comparisons are STRING comparisons: every account number is exactly four
// digits (DB CHECK constraint), so zero-padded lexicographic order equals
// numeric order — the same trick as TAXABLE_SALES_INTERVAL in
// vat-report.service.ts.

export type ReportSection = "assets" | "equityAndLiabilities";

// Inclusive at both ends.
export type AccountInterval = readonly [string, string];

export interface BalanceSheetLineDef {
  key: string;
  label: string;
  intervals: readonly AccountInterval[];
  // Computed lines carry no accounts: the builder fills them from the class
  // 3–8 result, because the system has no year-end closing.
  computed?: boolean;
}

export interface BalanceSheetGroupDef {
  key: string;
  label: string;
  section: ReportSection;
  lines: readonly BalanceSheetLineDef[];
}

export const BALANCE_SHEET_GROUPS: readonly BalanceSheetGroupDef[] = [
  {
    key: "fixedAssets",
    label: "Anläggningstillgångar",
    section: "assets",
    lines: [
      { key: "intangibleAssets", label: "Immateriella anläggningstillgångar", intervals: [["1000", "1099"]] },
      { key: "buildingsAndLand", label: "Byggnader och mark", intervals: [["1100", "1199"]] },
      { key: "machineryAndEquipment", label: "Maskiner och inventarier", intervals: [["1200", "1299"]] },
      { key: "financialAssets", label: "Finansiella anläggningstillgångar", intervals: [["1300", "1399"]] },
    ],
  },
  {
    key: "currentAssets",
    label: "Omsättningstillgångar",
    section: "assets",
    lines: [
      { key: "inventory", label: "Varulager", intervals: [["1400", "1499"]] },
      { key: "accountsReceivable", label: "Kundfordringar", intervals: [["1500", "1599"]] },
      { key: "otherReceivables", label: "Övriga fordringar", intervals: [["1600", "1699"]] },
      {
        key: "prepaidExpenses",
        label: "Förutbetalda kostnader och upplupna intäkter",
        intervals: [["1700", "1799"]],
      },
      { key: "shortTermInvestments", label: "Kortfristiga placeringar", intervals: [["1800", "1899"]] },
      { key: "cashAndBank", label: "Kassa och bank", intervals: [["1900", "1999"]] },
    ],
  },
  {
    // Only ever renders when something was actually booked outside class 1–8.
    key: "unclassifiedAssets",
    label: "Ej klassificerade konton",
    section: "assets",
    lines: [
      {
        key: "unclassified",
        label: "Konton utanför kontoklass 1–8",
        intervals: [
          ["0000", "0999"],
          ["9000", "9999"],
        ],
      },
    ],
  },
  {
    key: "equity",
    label: "Eget kapital",
    section: "equityAndLiabilities",
    lines: [
      { key: "restrictedEquity", label: "Bundet eget kapital", intervals: [["2080", "2089"]] },
      {
        key: "unrestrictedEquity",
        label: "Fritt eget kapital",
        intervals: [
          ["2000", "2079"],
          ["2090", "2099"],
        ],
      },
      // Class 3–8 booked BEFORE the fiscal year start. Non-zero only while no
      // closing entry has been made for the previous years.
      {
        key: "retainedResult",
        label: "Balanserat resultat (ej bokslutsfört)",
        intervals: [],
        computed: true,
      },
      // Class 3–8 booked within the fiscal year, up to and including asOf.
      { key: "yearResult", label: "Årets resultat", intervals: [], computed: true },
    ],
  },
  {
    key: "untaxedReserves",
    label: "Obeskattade reserver",
    section: "equityAndLiabilities",
    lines: [{ key: "untaxedReserves", label: "Obeskattade reserver", intervals: [["2100", "2199"]] }],
  },
  {
    key: "provisions",
    label: "Avsättningar",
    section: "equityAndLiabilities",
    lines: [{ key: "provisions", label: "Avsättningar", intervals: [["2200", "2299"]] }],
  },
  {
    key: "longTermLiabilities",
    label: "Långfristiga skulder",
    section: "equityAndLiabilities",
    lines: [{ key: "longTermLiabilities", label: "Långfristiga skulder", intervals: [["2300", "2399"]] }],
  },
  {
    key: "currentLiabilities",
    label: "Kortfristiga skulder",
    section: "equityAndLiabilities",
    lines: [
      { key: "accountsPayable", label: "Leverantörsskulder", intervals: [["2440", "2449"]] },
      { key: "taxLiabilities", label: "Skatteskulder", intervals: [["2500", "2599"]] },
      {
        // Holds the VAT accounts (2610–2650), so a booked momsomföring stays
        // visible on the balance sheet.
        key: "otherCurrentLiabilities",
        label: "Övriga kortfristiga skulder",
        intervals: [
          ["2400", "2439"],
          ["2450", "2499"],
          ["2600", "2899"],
        ],
      },
      {
        key: "accruedExpenses",
        label: "Upplupna kostnader och förutbetalda intäkter",
        intervals: [["2900", "2999"]],
      },
    ],
  },
];

export type IncomeStatementEntryDef =
  | { kind: "line"; key: string; label: string; intervals: readonly AccountInterval[] }
  // A subtotal is the running sum of EVERY line above it, not of the lines
  // since the previous subtotal.
  | { kind: "subtotal"; key: string; label: string };

export const INCOME_STATEMENT_ENTRIES: readonly IncomeStatementEntryDef[] = [
  { kind: "line", key: "netSales", label: "Nettoomsättning", intervals: [["3000", "3799"]] },
  { kind: "line", key: "otherOperatingIncome", label: "Övriga rörelseintäkter", intervals: [["3800", "3999"]] },
  { kind: "line", key: "rawMaterials", label: "Råvaror och förnödenheter", intervals: [["4000", "4899"]] },
  { kind: "line", key: "inventoryChange", label: "Förändring av lager", intervals: [["4900", "4999"]] },
  { kind: "line", key: "otherExternalCosts", label: "Övriga externa kostnader", intervals: [["5000", "6999"]] },
  { kind: "line", key: "personnelCosts", label: "Personalkostnader", intervals: [["7000", "7699"]] },
  { kind: "line", key: "depreciation", label: "Av- och nedskrivningar", intervals: [["7700", "7899"]] },
  { kind: "line", key: "otherOperatingCosts", label: "Övriga rörelsekostnader", intervals: [["7900", "7999"]] },
  { kind: "subtotal", key: "operatingResult", label: "Rörelseresultat" },
  { kind: "line", key: "financialIncome", label: "Finansiella intäkter", intervals: [["8000", "8399"]] },
  { kind: "line", key: "financialCosts", label: "Finansiella kostnader", intervals: [["8400", "8799"]] },
  { kind: "subtotal", key: "resultAfterFinancial", label: "Resultat efter finansiella poster" },
  { kind: "line", key: "appropriations", label: "Bokslutsdispositioner", intervals: [["8800", "8899"]] },
  { kind: "subtotal", key: "resultBeforeTax", label: "Resultat före skatt" },
  { kind: "line", key: "tax", label: "Skatt på årets resultat", intervals: [["8900", "8989"]] },
  // Årsbokslut: the year's result BEFORE the closing transfer, so a closed
  // year still reads its result here (the transfer zeroes the last subtotal).
  { kind: "subtotal", key: "yearResult", label: "Årets resultat" },
  // A manually booked closing entry (8999) lands here and cancels the rest of
  // class 3–8, which is exactly why the balance sheet stays correct with or
  // without a bokslut.
  { kind: "line", key: "bookedYearResult", label: "Årets resultat (bokfört)", intervals: [["8990", "8999"]] },
  { kind: "subtotal", key: "computedResult", label: "Beräknat resultat" },
];

export type AccountClassification =
  | { report: "balanceSheet"; section: ReportSection; groupKey: string; lineKey: string }
  | { report: "incomeStatement"; lineKey: string };

// Total by construction — see the coverage invariant at the top of the file.
export function classifyAccount(accountNumber: string): AccountClassification {
  for (const group of BALANCE_SHEET_GROUPS) {
    for (const line of group.lines) {
      for (const [low, high] of line.intervals) {
        if (accountNumber >= low && accountNumber <= high) {
          return {
            report: "balanceSheet",
            section: group.section,
            groupKey: group.key,
            lineKey: line.key,
          };
        }
      }
    }
  }
  for (const entry of INCOME_STATEMENT_ENTRIES) {
    if (entry.kind !== "line") continue;
    for (const [low, high] of entry.intervals) {
      if (accountNumber >= low && accountNumber <= high) {
        return { report: "incomeStatement", lineKey: entry.key };
      }
    }
  }
  // Unreachable while the coverage test passes; kept so a future edit that
  // opens a gap fails loudly instead of silently unbalancing the report.
  throw new Error(`Account number ${accountNumber} is not covered by the report interval table`);
}

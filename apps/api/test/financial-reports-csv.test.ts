import { describe, expect, it } from "vitest";
import {
  buildBalanceSheetCsv,
  buildGeneralLedgerCsv,
  buildIncomeStatementCsv,
  buildVerificationListCsv,
} from "../src/modules/economy/service/financial-reports-csv.js";

// Pure flattening tests — no database, no pdfkit. Rows must appear in the
// same order as the web pages/PDFs, with decimal commas.

function lines(csv: string): string[] {
  return csv.replace("﻿", "").trimEnd().split("\r\n");
}

const account = (nr: string, name: string, amount: number) => ({
  accountId: `id-${nr}`,
  accountNumber: nr,
  accountName: name,
  amount,
});

describe("buildBalanceSheetCsv", () => {
  it("flattens groups → lines → accounts with section totals in report order", () => {
    const csv = buildBalanceSheetCsv({
      assets: {
        groups: [
          {
            key: "g1",
            label: "Omsättningstillgångar",
            total: 1500.5,
            lines: [
              { key: "l1", label: "Kassa och bank", computed: false, total: 1500.5, accounts: [account("1910", "Kassa", 1500.5)] },
            ],
          },
        ],
        total: 1500.5,
      },
      equityAndLiabilities: {
        groups: [
          {
            key: "g2",
            label: "Eget kapital",
            total: 1500.5,
            lines: [{ key: "l2", label: "Beräknat resultat", computed: true, total: 1500.5, accounts: [] }],
          },
        ],
        total: 1500.5,
      },
      difference: 0,
    });
    const rows = lines(csv);
    expect(rows[0]).toBe("Konto;Benämning;Belopp");
    expect(rows).toContain(";Omsättningstillgångar;");
    expect(rows).toContain("1910;Kassa;1500,50");
    expect(rows).toContain(";Summa tillgångar;1500,50");
    expect(rows).toContain(";Summa eget kapital och skulder;1500,50");
    // Section headings present, like the PDF and web page:
    expect(rows).toContain(";Tillgångar;");
    expect(rows).toContain(";Eget kapital och skulder;");
    // Group order preserved: assets before equity
    expect(rows.indexOf(";Omsättningstillgångar;")).toBeLessThan(rows.indexOf(";Eget kapital;"));
    expect(rows.indexOf(";Tillgångar;")).toBeLessThan(rows.indexOf(";Omsättningstillgångar;"));
  });
});

describe("buildIncomeStatementCsv", () => {
  it("renders lines, subtotals and the period result", () => {
    const csv = buildIncomeStatementCsv({
      entries: [
        { kind: "line", key: "rev", label: "Nettoomsättning", total: 200, accounts: [account("3010", "Försäljning", 200)] },
        { kind: "subtotal", key: "sub", label: "Bruttoresultat", total: 200 },
      ],
      result: 200,
    });
    const rows = lines(csv);
    expect(rows).toContain("3010;Försäljning;200,00");
    expect(rows).toContain(";Bruttoresultat;200,00");
    expect(rows[rows.length - 1]).toBe(";Periodens resultat;200,00");
  });
});

describe("buildGeneralLedgerCsv", () => {
  it("renders opening/closing balance rows around each account's rows", () => {
    const csv = buildGeneralLedgerCsv({
      from: "2026-01-01",
      to: "2026-01-31",
      accountFrom: "1000",
      accountTo: "1999",
      totalDebit: 100,
      totalCredit: 0,
      accounts: [
        {
          accountId: "a1",
          accountNumber: "1910",
          accountName: "Kassa",
          openingBalance: 50,
          closingBalance: 150,
          totalDebit: 100,
          totalCredit: 0,
          rows: [
            {
              date: "2026-01-10",
              seriesCode: "A",
              yearLabel: "2026",
              verificationNumber: 1,
              displayNumber: "A-2026-1",
              description: "Insättning",
              debit: "100.00",
              credit: "0.00",
              verificationId: "v1",
              balance: 150,
            },
          ],
        },
      ],
    });
    const rows = lines(csv);
    expect(rows[0]).toBe("Konto;Kontonamn;Datum;Verifikat;Text;Debet;Kredit;Saldo");
    const opening = rows.findIndex((r) => r.includes("Ingående saldo"));
    const row = rows.findIndex((r) => r.includes("A-2026-1"));
    const closing = rows.findIndex((r) => r.includes("Utgående saldo"));
    expect(opening).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(opening);
    expect(closing).toBeGreaterThan(row);
    expect(rows[row]).toBe("1910;Kassa;2026-01-10;A-2026-1;Insättning;100,00;0,00;150,00");
  });
});

describe("buildVerificationListCsv", () => {
  it("renders one row per verification row with the header repeated", () => {
    const csv = buildVerificationListCsv({
      verifications: [
        {
          id: "v1",
          date: "2026-01-10",
          displayNumber: "A-2026-1",
          description: "Hyra januari",
          status: "posted",
          totalDebit: 100,
          totalCredit: 100,
          rows: [
            { accountNumber: "5010", accountName: "Lokalhyra", description: "", debit: "100.00", credit: "0.00" },
            { accountNumber: "1910", accountName: "Kassa", description: "", debit: "0.00", credit: "100.00" },
          ],
        },
      ],
    });
    const rows = lines(csv);
    expect(rows[0]).toBe("Verifikat;Datum;Text;Konto;Kontonamn;Debet;Kredit");
    expect(rows[1]).toBe("A-2026-1;2026-01-10;Hyra januari;5010;Lokalhyra;100,00;0,00");
    expect(rows[2]).toBe("A-2026-1;2026-01-10;Hyra januari;1910;Kassa;0,00;100,00");
  });
});

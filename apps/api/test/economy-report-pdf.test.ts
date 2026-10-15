import { describe, expect, it } from "vitest";
import { testDocumentPdfService } from "./helpers/services.js";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";

// The PDF renderers own the paper, not the numbers: economy formats every
// amount and label, mail draws it in the shared A4 template. These tests are
// about what actually lands on the page.

describe("renderFinancialStatement", () => {
  it("prints group headings, account lines and the total", async () => {
    const buffer = await testDocumentPdfService.renderFinancialStatement({
      title: "Balansräkning",
      subtitle: `Per 2026-12-31 · Räkenskapsår 2026`,
      rows: [
        { kind: "group", label: "Omsättningstillgångar", amount: null },
        { kind: "line", label: "Kassa och bank", amount: null },
        { kind: "account", label: "1930 Företagskonto", amount: "340 000,00" },
        { kind: "subtotal", label: "Summa omsättningstillgångar", amount: "340 000,00" },
        { kind: "total", label: "SUMMA TILLGÅNGAR", amount: "340 000,00" },
      ],
    });
    const text = pdfText(buffer);
    expect(text).toContain("Balansräkning");
    expect(text).toContain("Per 2026-12-31");
    expect(text).toContain("Omsättningstillgångar");
    expect(text).toContain("1930 Företagskonto");
    expect(text).toContain("SUMMA TILLGÅNGAR");
    expect(text).toContain("340 000,00");
  });

  it("prints a negative amount with an ASCII hyphen, never U+2212", async () => {
    const buffer = await testDocumentPdfService.renderFinancialStatement({
      title: "Resultaträkning",
      subtitle: "2026-01-01 – 2026-12-31",
      rows: [
        { kind: "line", label: "Råvaror och förnödenheter", amount: "-6 000,00" },
        { kind: "subtotal", label: "Rörelseresultat", amount: "-6 000,00" },
      ],
    });
    const text = pdfText(buffer);
    expect(text).toContain("-6 000,00");
    expect(text).not.toContain("−");
  });
});

describe("renderGeneralLedger", () => {
  it("prints one section per account with opening and closing balances", async () => {
    const buffer = await testDocumentPdfService.renderGeneralLedger({
      title: "Huvudbok",
      subtitle: "2026-01-01 – 2026-12-31",
      accounts: [
        {
          heading: "1930 · Företagskonto",
          openingAmount: "0,00",
          closingAmount: "600,00",
          rows: [
            {
              date: "2026-01-10",
              verification: "A-2026-1",
              text: "Insättning",
              debit: "1 000,00",
              credit: "0,00",
              balance: "1 000,00",
            },
            {
              date: "2026-02-10",
              verification: "A-2026-2",
              text: "Inköp",
              debit: "0,00",
              credit: "400,00",
              balance: "600,00",
            },
          ],
        },
      ],
      emptyText: "Inga bokförda rader i intervallet.",
    });
    const text = pdfText(buffer);
    expect(text).toContain("1930");
    expect(text).toContain("Ingående saldo");
    expect(text).toContain("Utgående saldo");
    expect(text).toContain("A-2026-1");
    expect(text).toContain("600,00");
  });

  it("prints the empty text when no account has rows", async () => {
    const buffer = await testDocumentPdfService.renderGeneralLedger({
      title: "Huvudbok",
      subtitle: "2026-01-01 – 2026-12-31",
      accounts: [],
      emptyText: "Inga bokförda rader i intervallet.",
    });
    expect(pdfText(buffer)).toContain("Inga bokförda rader i intervallet.");
  });
});

describe("renderVerificationList", () => {
  it("prints one block per verification with its posting rows and totals", async () => {
    const buffer = await testDocumentPdfService.renderVerificationList({
      title: "Verifikatlista",
      subtitle: "Räkenskapsår 2026",
      verifications: [
        {
          heading: "A-2026-1 · 2026-01-15 · Kundfaktura",
          rows: [
            { account: "1510 Kundfordringar", text: "Kundfaktura", debit: "12 500,00", credit: "0,00" },
            { account: "3001 Försäljning", text: "Kundfaktura", debit: "0,00", credit: "10 000,00" },
            { account: "2610 Utgående moms", text: "Kundfaktura", debit: "0,00", credit: "2 500,00" },
          ],
          totalDebit: "12 500,00",
          totalCredit: "12 500,00",
        },
      ],
      emptyText: "Inga verifikat matchar filtret.",
    });
    const text = pdfText(buffer);
    expect(text).toContain("Verifikatlista");
    expect(text).toContain("A-2026-1");
    expect(text).toContain("1510 Kundfordringar");
    expect(text).toContain("12 500,00");
  });

  it("prints a draft's Utkast label", async () => {
    const buffer = await testDocumentPdfService.renderVerificationList({
      title: "Verifikatlista",
      subtitle: "Räkenskapsår 2026",
      verifications: [
        {
          heading: "Utkast · 2026-02-01 · Ej bokfört",
          rows: [{ account: "1930 Företagskonto", text: "Ej bokfört", debit: "500,00", credit: "0,00" }],
          totalDebit: "500,00",
          totalCredit: "0,00",
        },
      ],
      emptyText: "Inga verifikat matchar filtret.",
    });
    expect(pdfText(buffer)).toContain("Utkast");
  });
});

// A free-text posting description long enough to wrap onto several lines in
// the narrow text column. The renderer must let the wrapped height drive the
// row advance — with a fixed per-row step the wrapped lines pile onto the
// following rows and a long list never leaves page one.
const LONG_TEXT =
  "Omvärdering av halvfabrikat efter inventering enligt styrelsebeslut, fördelad på kostnadsställe 410 tillverkning";

describe("report line wrapping", () => {
  it("lets wrapped verification row text consume real height so long lists spill onto a new page", async () => {
    const buffer = await testDocumentPdfService.renderVerificationList({
      title: "Verifikatlista",
      subtitle: "Räkenskapsår 2026",
      verifications: [
        {
          heading: "A-2026-1 · 2026-01-15 · Lagerjustering",
          rows: Array.from({ length: 20 }, (_, i) => ({
            account: `49${String(i).padStart(2, "0")} Lagerförändring`,
            text: LONG_TEXT,
            debit: "1 000,00",
            credit: "0,00",
          })),
          totalDebit: "20 000,00",
          totalCredit: "0,00",
        },
        {
          heading: "A-2026-2 · 2026-01-16 · Nästa verifikat",
          rows: [{ account: "1930 Företagskonto", text: "Kort text", debit: "0,00", credit: "1,00" }],
          totalDebit: "0,00",
          totalCredit: "1,00",
        },
      ],
      emptyText: "Inga verifikat matchar filtret.",
    });
    expect(pdfPageCount(buffer)).toBe(2);
    const text = pdfText(buffer);
    // No truncation: words from both ends of the long description print...
    expect(text).toContain("Omvärdering");
    expect(text).toContain("tillverkning");
    // ...and the verification after the page break still prints.
    expect(text).toContain("A-2026-2");
  });

  it("lets wrapped general ledger row text consume real height too", async () => {
    const buffer = await testDocumentPdfService.renderGeneralLedger({
      title: "Huvudbok",
      subtitle: "2026-01-01 – 2026-12-31",
      accounts: [
        {
          heading: "4900 · Lagerförändring",
          openingAmount: "0,00",
          closingAmount: "20 000,00",
          rows: Array.from({ length: 20 }, (_, i) => ({
            date: "2026-01-10",
            verification: `A-2026-${i + 1}`,
            text: LONG_TEXT,
            debit: "1 000,00",
            credit: "0,00",
            balance: `${i + 1} 000,00`,
          })),
        },
      ],
      emptyText: "Inga bokförda rader i intervallet.",
    });
    expect(pdfPageCount(buffer)).toBe(2);
    const text = pdfText(buffer);
    expect(text).toContain("Omvärdering");
    expect(text).toContain("Utgående saldo");
  });
});

describe("report page numbers", () => {
  it("stamps Sida X av Y on every page of a multi-page verification list", async () => {
    const buffer = await testDocumentPdfService.renderVerificationList({
      title: "Verifikatlista",
      subtitle: "Räkenskapsår 2026",
      verifications: Array.from({ length: 40 }, (_, i) => ({
        heading: `A-2026-${i + 1} · 2026-01-15 · Kundfaktura`,
        rows: [{ account: "1510 Kundfordringar", text: "Kundfaktura", debit: "100,00", credit: "0,00" }],
        totalDebit: "100,00",
        totalCredit: "100,00",
      })),
      emptyText: "Inga verifikat matchar filtret.",
    });
    const pages = pdfPageCount(buffer);
    expect(pages).toBeGreaterThan(1);
    const text = pdfText(buffer);
    expect(text).toContain(`Sida 1 av ${pages}`);
    expect(text).toContain(`Sida ${pages} av ${pages}`);
  });

  it("leaves a single-page report unnumbered", async () => {
    const buffer = await testDocumentPdfService.renderVerificationList({
      title: "Verifikatlista",
      subtitle: "Räkenskapsår 2026",
      verifications: [
        {
          heading: "A-2026-1 · 2026-01-15 · Kundfaktura",
          rows: [{ account: "1510 Kundfordringar", text: "Kundfaktura", debit: "100,00", credit: "0,00" }],
          totalDebit: "100,00",
          totalCredit: "100,00",
        },
      ],
      emptyText: "Inga verifikat matchar filtret.",
    });
    expect(pdfPageCount(buffer)).toBe(1);
    expect(pdfText(buffer)).not.toContain("Sida");
  });
});

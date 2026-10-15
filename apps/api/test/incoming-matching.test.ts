import { describe, expect, it } from "vitest";
import { matchIncomingEntry, type MatchingLookup, type OpenReceivable } from "../src/modules/banking/service/incoming-matching.js";
import { namesMatch } from "../src/modules/banking/service/name-match.js";
import { computeOcrNumber } from "../src/modules/system/service/ocr.js";

function receivable(invoiceNumber: string, customerId: string, customerName: string, openAmount: number, dueDate = "2024-10-01"): OpenReceivable {
  return { invoiceId: `id-${invoiceNumber}`, invoiceNumber, ocrNumber: computeOcrNumber(invoiceNumber), customerId, customerName, dueDate, openAmount };
}
const FA5012 = receivable("FA-5012", "c1", "AB Fönsterbolaget", 10000);
const FA5015 = receivable("FA-5015", "c2", "Rörfirman i Exempelby AB", 10000);
const FA5020 = receivable("FA-5020", "c3", "Bygg & Kakel i Älvby AB", 6250);
const FA5030 = receivable("FA-5030", "c4", "Alfa Verkstad AB", 7000, "2024-09-20");
const FA5031 = receivable("FA-5031", "c4", "Alfa Verkstad AB", -500, "2024-09-25");
const FA5032 = receivable("FA-5032", "c4", "Alfa Verkstad AB", 300, "2024-10-05");
const OPEN = [FA5012, FA5015, FA5020, FA5030, FA5031, FA5032];

function lookup(overrides: Partial<MatchingLookup> = {}): MatchingLookup {
  const byCustomer = new Map<string, OpenReceivable[]>();
  for (const r of OPEN) byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), r]);
  return {
    openByOcr: new Map(OPEN.map((r) => [r.ocrNumber!, r])),
    closedByOcr: new Map([[computeOcrNumber("FA-4999"), { invoiceNumber: "FA-4999", ocrNumber: computeOcrNumber("FA-4999"), status: "paid" as const }]]),
    candidatesByAmount: OPEN,
    openByCustomer: byCustomer,
    customers: [
      { id: "c1", name: "AB Fönsterbolaget" },
      { id: "c2", name: "Rörfirman i Exempelby AB" },
      { id: "c3", name: "Bygg & Kakel i Älvby AB" },
      { id: "c4", name: "Alfa Verkstad AB" },
    ],
    ...overrides,
  };
}
const entry = (amount: number, remittance: { type: "SCOR" | "CINV" | "CREN" | "USTRD" | "ADDTL"; value: string; amount: number | null }[], counterpartyName: string | null = null) => ({
  id: "e1",
  amount,
  counterpartyName,
  remittance,
});

describe("matchIncomingEntry (tolerans 1 kr)", () => {
  it("exact OCR closes the item → Matchad", () => {
    const p = matchIncomingEntry(entry(10000, [{ type: "CINV", value: "501262", amount: 10000 }]), lookup(), 1);
    expect(p).toMatchObject({ state: "matched", basis: "ocr", partial: false, customerId: "c1" });
    expect(p.rows).toEqual([expect.objectContaining({ invoiceNumber: "FA-5012", appliedAmount: 10000, outcome: expect.objectContaining({ kind: "closes" }) })]);
  });

  it("partial payment on an OCR → Matchad, marked partial", () => {
    const p = matchIncomingEntry(entry(9930, [{ type: "CINV", value: "501569", amount: null }]), lookup(), 1);
    expect(p).toMatchObject({ state: "matched", partial: true });
    expect(p.rows[0]!.outcome).toMatchObject({ kind: "partial", rest: 70 });
  });

  it("öresavrundning within tolerance closes with a write-off", () => {
    const p = matchIncomingEntry(entry(9999.5, [{ type: "SCOR", value: "501262", amount: null }]), lookup(), 1);
    expect(p.rows[0]!.outcome).toMatchObject({ kind: "closes_with_writeoff", writeOffAmount: 0.5 });
  });

  it("overpayment beyond tolerance → Omatchad with a reason", () => {
    const p = matchIncomingEntry(entry(10070, [{ type: "SCOR", value: "501262", amount: null }]), lookup(), 1);
    expect(p).toMatchObject({ state: "unmatched", reason: "Överbetalning 70,00 kr på FA-5012 — registrera manuellt under Betalningar" });
  });

  it("invoice + credit note with their own amounts → two rows, Matchad", () => {
    const p = matchIncomingEntry(
      entry(6500, [
        { type: "CINV", value: computeOcrNumber("FA-5030"), amount: 7000 },
        { type: "CREN", value: computeOcrNumber("FA-5031"), amount: 500 },
      ]),
      lookup(),
      1
    );
    expect(p.state).toBe("matched");
    expect(p.rows.map((r) => [r.invoiceNumber, r.appliedAmount])).toEqual([["FA-5030", 7000], ["FA-5031", -500]]);
  });

  it("several OCRs without amounts → Förslag, oldest first", () => {
    const p = matchIncomingEntry(
      entry(7100, [
        { type: "USTRD", value: `Fakturor ${computeOcrNumber("FA-5032")} och ${computeOcrNumber("FA-5030")}`, amount: null },
      ]),
      lookup(),
      1
    );
    expect(p).toMatchObject({ state: "suggested", basis: "ocr", reason: "Fördelningen behöver granskas" });
    // Oldest due first, capped at its open amount; the last takes the rest.
    expect(p.rows.map((r) => [r.invoiceNumber, r.appliedAmount])).toEqual([["FA-5030", 7000], ["FA-5032", 100]]);
  });

  it("OCRs of two customers → no OCR match; falls through to amount/name", () => {
    const p = matchIncomingEntry(entry(20000, [{ type: "CINV", value: "501262", amount: null }, { type: "CINV", value: "501569", amount: null }]), lookup(), 1);
    expect(p).toMatchObject({ state: "unmatched", reason: "OCR-referenserna tillhör olika kunder" });
  });

  it("OCRs of two customers, but amount + name fit one of them → Förslag with the reason kept", () => {
    // Controller ruling (spec §5.1 rule 3/4): the OCR rule gives up, rule 4 still runs.
    const p = matchIncomingEntry(
      entry(10000, [{ type: "CINV", value: "501262", amount: null }, { type: "CINV", value: "501569", amount: null }], "AB FONSTERBOLAGET"),
      lookup(),
      1
    );
    expect(p).toMatchObject({ state: "suggested", basis: "amount_name", customerId: "c1", reason: "OCR-referenserna tillhör olika kunder" });
    expect(p.rows.map((r) => r.invoiceNumber)).toEqual(["FA-5012"]);
    expect(p.alternatives.map((r) => r.invoiceNumber)).toEqual(["FA-5015"]);
  });

  it("OCR of an already paid invoice → Omatchad: possible double payment", () => {
    const ocr = computeOcrNumber("FA-4999");
    const p = matchIncomingEntry(entry(123, [{ type: "SCOR", value: ocr, amount: null }]), lookup(), 1);
    expect(p).toMatchObject({ state: "unmatched", reason: `OCR ${ocr} tillhör FA-4999 som redan är betald — möjlig dubbelbetalning` });
  });

  it("OCR of a paid invoice still tries amount + name (rule 3 → rule 4), keeping the double-payment reason", () => {
    const ocr = computeOcrNumber("FA-4999");
    const p = matchIncomingEntry(entry(6250, [{ type: "SCOR", value: ocr, amount: null }], "BYGG O KAKEL ALVBY"), lookup(), 1);
    expect(p).toMatchObject({
      state: "suggested",
      basis: "amount_name",
      customerId: "c3",
      reason: `OCR ${ocr} tillhör FA-4999 som redan är betald — möjlig dubbelbetalning`,
    });
  });

  it("flags the double payment even when an unknown OCR comes first", () => {
    const paid = computeOcrNumber("FA-4999");
    const p = matchIncomingEntry(
      entry(123, [{ type: "SCOR", value: computeOcrNumber("FA-1111"), amount: null }, { type: "SCOR", value: paid, amount: null }]),
      lookup(),
      1
    );
    expect(p).toMatchObject({ state: "unmatched", reason: `OCR ${paid} tillhör FA-4999 som redan är betald — möjlig dubbelbetalning` });
  });

  it("several OCRs that are all credit notes → Omatchad, the allocation cannot add up", () => {
    const FA5033 = receivable("FA-5033", "c4", "Alfa Verkstad AB", -200);
    const base = lookup();
    const p = matchIncomingEntry(
      entry(300, [{ type: "USTRD", value: `${computeOcrNumber("FA-5031")} ${computeOcrNumber("FA-5033")}`, amount: null }]),
      { ...base, openByOcr: new Map([...base.openByOcr, [FA5033.ocrNumber!, FA5033]]) },
      1
    );
    expect(p).toMatchObject({ state: "unmatched", reason: "Fördelningen går inte ihop — välj fakturor manuellt", rows: [] });
  });

  it("unknown OCR → reason kept while amount + name still suggests", () => {
    const p = matchIncomingEntry(entry(6250, [{ type: "SCOR", value: computeOcrNumber("FA-1111"), amount: null }], "BYGG O KAKEL ALVBY"), lookup(), 1);
    expect(p).toMatchObject({ state: "suggested", basis: "amount_name", customerId: "c3", reason: `OCR ${computeOcrNumber("FA-1111")} hittades inte bland öppna poster` });
  });

  it("no reference: amount + name → Förslag (the worked example's third payment)", () => {
    const p = matchIncomingEntry(entry(6250, [{ type: "USTRD", value: "Faktura september", amount: null }], "BYGG O KAKEL ALVBY"), lookup(), 1);
    expect(p).toMatchObject({ state: "suggested", basis: "amount_name", customerId: "c3", reason: null });
    expect(p.rows.map((r) => r.invoiceNumber)).toEqual(["FA-5020"]);
  });

  it("no reference, unique amount, no name → Förslag: endast belopp", () => {
    const p = matchIncomingEntry(entry(300, [], null), lookup(), 1);
    expect(p).toMatchObject({ state: "suggested", basis: "amount_only" });
  });

  it("name of one customer, amount within that customer's open total → fördelning", () => {
    // 6800 matches no single open item, but Alfa's open total (7000 − 500 + 300).
    const p = matchIncomingEntry(entry(6800, [], "Alfa Verkstad"), lookup(), 1);
    expect(p).toMatchObject({ state: "suggested", basis: "name_allocation", customerId: "c4" });
  });

  it("nothing fits → Omatchad", () => {
    const p = matchIncomingEntry(entry(4321, [{ type: "USTRD", value: "Hej", amount: null }], "Okänd Firma"), lookup(), 1);
    expect(p).toMatchObject({ state: "unmatched", reason: "Ingen faktura matchar referens, belopp eller namn", rows: [] });
  });
});

describe("namesMatch", () => {
  it("ignores case, accents, &, i/och/AB and punctuation", () => {
    expect(namesMatch("BYGG O KAKEL ALVBY", "Bygg & Kakel i Älvby AB")).toBe(true);
    expect(namesMatch("AB FONSTERBOLAGET", "AB Fönsterbolaget")).toBe(true);
    expect(namesMatch("RORFIRMAN I EXEMPELBY AB", "Rörfirman i Exempelby AB")).toBe(true);
    expect(namesMatch("Bygg AB", "Kakel AB")).toBe(false);
    expect(namesMatch("AB", "AB")).toBe(false);
  });
});

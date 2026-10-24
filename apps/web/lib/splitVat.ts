// Momshjälp för verifikattabellen (Bokföringsgranskningen etapp 3): delar ett
// belopp inklusive moms på netto + momsrad, eller lägger till beräknad moms
// för omvända koder. Ren funktion utan importer — ingen @navet/shared, så att
// den kan provas direkt av apps/api/test (webben kan inte importera paketet
// och API-testerna importerar den här filen). Servern ser bara vanliga rader;
// momskoden lagras aldrig på verifikatet.

export type SplitVatSide = "debit" | "credit";

// The part of a GET /vat-codes row (VatCodeView in vatCodes.ts) the split
// needs: the catalog kind and rate plus the company's account per slot. A
// VatCodeView satisfies it structurally.
export interface SplitVatCode {
  code?: string;
  kind: string;
  rate: number;
  accounts: readonly { slot: string; accountNumber: string }[];
}

export interface SplitVatRow {
  accountNumber: string;
  side: SplitVatSide;
  amount: number;
  description: string;
}

export interface SplitVatResult {
  // What stays on the user's own row (the amount excluding VAT for a
  // domestic code; unchanged for an omvänd code, where the amount IS the net).
  net: number;
  // VAT rows to insert directly under the user's row.
  rows: SplitVatRow[];
  // Set when the split could not be made (the code lacks an account); then
  // `net` is the untouched amount and `rows` is empty.
  error: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Same arithmetic as the server's computedVatAmount (omvänd moms): half away
// from zero to öre.
function computedVat(base: number, rate: number): number {
  const magnitude = Math.round(Math.abs(base) * rate + 1e-9) / 100;
  return base < 0 ? -magnitude : magnitude;
}

// Which codes the Momskod cell offers: domestic codes that carry VAT and the
// omvända inköpskoder. Momsfritt, sales-only codes (EUV…), IUTV and import
// codes have no VAT to split.
export function splitVatApplies(code: Pick<SplitVatCode, "kind" | "rate">): boolean {
  if (code.kind === "reverse_purchase") return code.rate > 0;
  return code.kind === "domestic" && code.rate > 0;
}

function accountFor(code: SplitVatCode, slot: "inputVat" | "outputVat"): string | null {
  const hit = code.accounts.find((a) => a.slot === slot);
  return hit && hit.accountNumber ? hit.accountNumber : null;
}

// `amount` is the row's amount on `side`.
//  - Domestic code: the amount is INCLUDING VAT. net = amount / (1 + rate),
//    rounded to öre; the VAT row is amount − net (so the öre remainder lands
//    on the VAT row and net + VAT is exactly the amount). Ingående moms on the
//    debit side, utgående moms on the credit side, following the row's side.
//  - Omvänd code (reverse_purchase): the amount is the net base. The computed
//    VAT is booked as BOTH an ingående and an utgående row on the code's
//    accounts (netting to zero), ingående on the row's own side.
export function splitVat(amount: number, code: SplitVatCode, side: SplitVatSide): SplitVatResult {
  const unchanged: SplitVatResult = { net: amount, rows: [], error: null };
  if (!Number.isFinite(amount) || amount <= 0 || !splitVatApplies(code)) return unchanged;
  const label = code.code ? ` ${code.code}` : "";
  const opposite: SplitVatSide = side === "debit" ? "credit" : "debit";

  if (code.kind === "reverse_purchase") {
    const vat = computedVat(amount, code.rate);
    if (vat === 0) return unchanged;
    const input = accountFor(code, "inputVat");
    const output = accountFor(code, "outputVat");
    if (!input || !output) {
      return { net: amount, rows: [], error: `Momskoden${label} saknar konto för ingående eller utgående moms.` };
    }
    return {
      net: amount,
      rows: [
        { accountNumber: input, side, amount: vat, description: `Ingående moms${label}` },
        { accountNumber: output, side: opposite, amount: vat, description: `Utgående moms${label}` },
      ],
      error: null,
    };
  }

  const net = round2((amount * 100) / (100 + code.rate));
  const vat = round2(amount - net);
  if (vat === 0) return { net, rows: [], error: null };
  const slot = side === "debit" ? "inputVat" : "outputVat";
  const account = accountFor(code, slot);
  if (!account) {
    return {
      net: amount,
      rows: [],
      error: `Momskoden${label} saknar konto för ${side === "debit" ? "ingående" : "utgående"} moms.`,
    };
  }
  return {
    net,
    rows: [
      {
        accountNumber: account,
        side,
        amount: vat,
        description: `${side === "debit" ? "Ingående" : "Utgående"} moms${label}`,
      },
    ],
    error: null,
  };
}

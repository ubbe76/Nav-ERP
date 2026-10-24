"use client";

import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormHint, FormNotice } from "../ui/Form";
import type { InvoiceRate } from "../../lib/useExchangeRate";

// The Kurs of a foreign-currency supplier invoice: SEK per 1 unit of the
// invoice's currency, prefilled for the invoice date (Riksbanken or an own
// rate from Ekonomi → Valutakurser) until it is typed in by hand. The hint says
// where the rate comes from — "Källa: Sveriges Riksbank" for a fetched one
// (Riksbankens villkor).
export function InvoiceRateField({ id, currency, invoiceRate }: { id: string; currency: string; invoiceRate: InvoiceRate }) {
  const { rate, sourceText, fromRiksbank, loading, problem, canReset, setRate, resetToLookup } = invoiceRate;
  return (
    <>
      <Field label={`Kurs (SEK per 1 ${currency})`} htmlFor={id}>
        <Input id={id} type="number" min="0" step="any" size="sm" value={rate} onChange={(e) => setRate(e.target.value)} />
        <FormHint>
          {loading
            ? "Hämtar kursen för fakturadatumet…"
            : sourceText
              ? `${sourceText}${fromRiksbank ? ". Källa: Sveriges Riksbank." : "."} `
              : ""}
          Kursen för fakturadatumet gäller som förval. Momslagen kräver kursen när den beskattningsgrundande händelsen
          inträffar (oftast leveransen) — ändra kursen om leveransdagen skiljer sig från fakturadatumet.
        </FormHint>
      </Field>
      {canReset && (
        <div>
          <Button type="button" variant="ghost" size="small" onClick={resetToLookup}>
            Använd kursen för fakturadatumet
          </Button>
        </div>
      )}
      {problem && <FormNotice>{problem}</FormNotice>}
    </>
  );
}

// Netto/moms/brutto in SEK at the invoice's rate — what approving books. Shown
// under the amount fields of a foreign invoice (a preview in the dialog and on
// a draft, the booked figures after the attest).
export function SekAmountsLine({
  amounts,
  label,
}: {
  amounts: { netAmount: number; vatAmount: number; grossAmount: number } | null;
  label: string;
}) {
  if (!amounts) return null;
  const fmt = (value: number) => value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <FormHint>
      {label}: netto {fmt(amounts.netAmount)} kr · moms {fmt(amounts.vatAmount)} kr · brutto {fmt(amounts.grossAmount)} kr
    </FormHint>
  );
}

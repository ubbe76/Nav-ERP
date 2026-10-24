"use client";

import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormHint, FormNotice, FormStack } from "../ui/Form";
import type { OrderRate } from "../../lib/useOrderRate";

// The Kurs of a quote/order in another currency than SEK: SEK per 1 unit of the
// order's currency, prefilled with today's rate (Riksbanken or an own rate from
// Ekonomi → Valutakurser) until it is typed in by hand. The hint says where the
// rate comes from — "Källa: Sveriges Riksbank" for a fetched one (Riksbankens
// villkor).
export function OrderRateField({
  id,
  currency,
  orderRate,
  quote,
}: {
  id: string;
  currency: string;
  orderRate: OrderRate;
  // Wording: an offert or an order.
  quote?: boolean;
}) {
  const { rate, sourceText, fromRiksbank, loading, problem, touched, showsStored, setRate, useToday } = orderRate;
  // One block, so it takes a single cell when it sits in a FormRow.
  return (
    <FormStack>
      <Field label="Kurs" htmlFor={id}>
        <Input
          id={id}
          type="number"
          min="0"
          step="any"
          size="sm"
          required
          aria-describedby={`${id}-hint`}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
        <FormHint id={`${id}-hint`}>
          SEK per 1 {currency}.{" "}
          {loading
            ? "Hämtar dagens kurs…"
            : sourceText
              ? `${sourceText}${fromRiksbank ? ". Källa: Sveriges Riksbank." : "."} `
              : ""}
          Kursen räknar om artikelns försäljningspris (SEK) till {currency} på nya rader och
          {quote ? " offertens" : " orderns"} värde till SEK i rapporterna. Raderna behåller sina priser om kursen ändras
          efteråt.
        </FormHint>
      </Field>
      {(showsStored || touched) && (
        <div>
          <Button type="button" variant="ghost" size="small" onClick={useToday}>
            {showsStored ? "Hämta dagens kurs" : "Använd dagens kurs"}
          </Button>
        </div>
      )}
      {problem && <FormNotice>{problem}</FormNotice>}
    </FormStack>
  );
}

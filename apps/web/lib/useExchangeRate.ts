"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { documentRateSourceText, SEK, type DocumentRateSourceValue } from "./currency";
import { apiErrorMessage } from "./errorMessages";
import type { ExchangeRateLookup } from "./types";

// Business dates the API accepts (1900-01-01 – 2999-12-31). A date input
// that is half typed ("0002-…") must not reach the API as a 400.
const LOOKUP_DATE = /^(19|2\d)\d\d-\d\d-\d\d$/;

export type RateLookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; lookup: ExchangeRateLookup }
  | { status: "error"; message: string };

// GET /exchange-rates?currency&date — the rate for the day (the latest banking
// day ≤ date, or an own rate from Ekonomi → Valutakurser). Idle for SEK, no
// currency or an unusable date; request-sequenced so a late answer for an
// earlier date never overwrites a newer one.
export function useExchangeRateLookup(currency: string | null, date: string): RateLookupState {
  const [state, setState] = useState<RateLookupState>({ status: "idle" });
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const code = currency?.trim().toUpperCase() ?? "";
    if (!code || code === SEK || !LOOKUP_DATE.test(date)) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    apiFetch<ExchangeRateLookup>(`/api/v1/exchange-rates?currency=${encodeURIComponent(code)}&date=${date}`)
      .then((lookup) => {
        if (mySeq === seq.current) setState({ status: "ok", lookup });
      })
      .catch((err) => {
        if (mySeq === seq.current) setState({ status: "error", message: apiErrorMessage(err, "Kunde inte hämta kursen") });
      });
  }, [currency, date]);

  return state;
}

export interface InvoiceRate {
  // The Kurs field's text ("" = none yet).
  rate: string;
  // True once the user typed in the field — never overwritten by a lookup then
  // (manuellt vinner), and sent to the API as the invoice's own rate.
  touched: boolean;
  // Where the shown rate comes from, ready for the hint ("Riksbanken
  // 2026-10-23", "manuell", …); null while there is none.
  sourceText: string | null;
  // The shown rate was fetched from Riksbanken — Riksbankens villkor: say so.
  fromRiksbank: boolean;
  loading: boolean;
  // Why no rate was found (409 exchange-rate-unavailable), null otherwise.
  problem: string | null;
  setRate: (value: string) => void;
  // Drop the typed rate and look it up again for the date.
  resetToLookup: () => void;
}

// The Kurs of a supplier invoice (dialog and draft card) — the touched
// pattern: the field follows the lookup for the invoice date and the invoice's
// currency until the user types in it; a changed date or currency looks it up
// again unless the user has. `lookupEnabled` lets a card that already holds the
// stored rate skip the lookup until the date/currency actually differs.
export function useInvoiceRate(options: {
  currency: string | null;
  date: string;
  lookupEnabled: boolean;
  initial?: { rate: string; source: DocumentRateSourceValue | null; date: string | null };
}): InvoiceRate {
  const { currency, date, lookupEnabled, initial } = options;
  const [rate, setRateText] = useState(initial?.rate ?? "");
  const [touched, setTouched] = useState(false);
  const [source, setSource] = useState<{ source: DocumentRateSourceValue; date: string | null } | null>(
    initial?.source ? { source: initial.source, date: initial.date } : null
  );
  const [problem, setProblem] = useState<string | null>(null);

  // While the user's own rate stands the lookup is switched off (idle), so
  // "Använd kursen för fakturadatumet" — touched back to false — asks again.
  const active = lookupEnabled && !touched;
  const lookup = useExchangeRateLookup(active ? currency : null, active ? date : "");

  useEffect(() => {
    if (!active) return;
    if (lookup.status === "ok") {
      setRateText(String(lookup.lookup.rate));
      setSource({ source: lookup.lookup.source === "manual" ? "register" : "riksbank", date: lookup.lookup.date });
      setProblem(null);
    } else if (lookup.status === "error") {
      setRateText("");
      setSource(null);
      setProblem(lookup.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup]);

  // Another currency (another supplier picked) makes the shown or typed rate
  // meaningless: start over — the lookup then fills in the new currency's rate.
  const previousCurrency = useRef(currency);
  useEffect(() => {
    if (previousCurrency.current === currency) return;
    previousCurrency.current = currency;
    setTouched(false);
    setRateText("");
    setSource(null);
    setProblem(null);
  }, [currency]);

  return {
    rate,
    touched,
    sourceText: touched ? "manuell" : source ? documentRateSourceText(source.source, source.date) : null,
    fromRiksbank: !touched && source?.source === "riksbank",
    loading: active && lookup.status === "loading",
    problem: touched ? null : problem,
    setRate: (value: string) => {
      setTouched(true);
      setRateText(value);
      setProblem(null);
    },
    resetToLookup: () => {
      setTouched(false);
      setProblem(null);
    },
  };
}

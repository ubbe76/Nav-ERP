"use client";

import { useEffect, useRef, useState } from "react";
import { stockholmToday } from "./date";
import { documentRateSourceText, SEK } from "./currency";
import { useExchangeRateLookup } from "./useExchangeRate";

export interface OrderRate {
  // The Kurs field's text ("" = none yet).
  rate: string;
  // True once the user typed in the field — never overwritten by a lookup then
  // (manuellt vinner).
  touched: boolean;
  // Where the shown rate comes from ("Riksbanken 2026-10-23", "manuell",
  // "orderns nuvarande kurs", …); null while there is none.
  sourceText: string | null;
  // The shown rate was fetched from Riksbanken — Riksbankens villkor: say so.
  fromRiksbank: boolean;
  loading: boolean;
  // Why no rate was found (409 exchange-rate-unavailable), null otherwise.
  problem: string | null;
  // The field shows the order's stored rate rather than today's (only on an
  // order that already has one).
  showsStored: boolean;
  setRate: (value: string) => void;
  // Drop the typed (or stored) rate and look today's up.
  useToday: () => void;
}

// The Kurs of a quote/order — the touched pattern: the field follows today's
// rate for the order's currency (Riksbanken, or an own rate from Ekonomi →
// Valutakurser) until the user types in it. On an existing order the field
// starts at its stored rate (`initial`) and only looks today's up when the
// currency is another one than the order's, or on `useToday()`.
//
// Idle for SEK (the rate is always 1 there) and for a half-typed currency code.
export function useOrderRate(options: {
  currency: string;
  initial?: { currency: string; rate: string };
}): OrderRate {
  const { initial } = options;
  const currency = options.currency.trim().toUpperCase();
  const foreign = /^[A-Z]{3}$/.test(currency) && currency !== SEK;
  const [rate, setRateText] = useState(initial?.rate ?? "");
  const [touched, setTouched] = useState(false);
  // Today's rate was asked for explicitly on the order's own currency.
  const [asked, setAsked] = useState(false);
  const [source, setSource] = useState<{ source: "riksbank" | "register"; date: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const keepsStored = initial !== undefined && currency === initial.currency;
  const active = foreign && !touched && (!keepsStored || asked);
  const lookup = useExchangeRateLookup(active ? currency : null, active ? stockholmToday() : "");

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

  // Another currency makes the shown or typed rate meaningless: start over —
  // the lookup then fills in the new currency's rate (back on the order's own
  // currency the stored rate returns).
  const previousCurrency = useRef(currency);
  useEffect(() => {
    if (previousCurrency.current === currency) return;
    previousCurrency.current = currency;
    setTouched(false);
    setAsked(false);
    setSource(null);
    setProblem(null);
    setRateText(initial !== undefined && currency === initial.currency ? initial.rate : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  const showsStored = keepsStored && !touched && !asked;
  return {
    rate,
    touched,
    sourceText: touched
      ? "manuell"
      : showsStored
        ? "orderns nuvarande kurs"
        : source
          ? documentRateSourceText(source.source, source.date)
          : null,
    fromRiksbank: !touched && !showsStored && source?.source === "riksbank",
    loading: active && lookup.status === "loading",
    problem: touched ? null : problem,
    showsStored,
    setRate: (value: string) => {
      setTouched(true);
      setRateText(value);
      setProblem(null);
    },
    useToday: () => {
      setTouched(false);
      setAsked(true);
      setProblem(null);
    },
  };
}

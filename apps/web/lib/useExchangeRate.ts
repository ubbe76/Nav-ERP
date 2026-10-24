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
  // The Kurs field's text ("" = none yet) — exactly what a save will record
  // (a typed rate, the looked-up one or the saved one).
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
  // "Använd kursen för fakturadatumet": drop the typed (or the saved own) rate
  // and show the automatic one for the date again.
  resetToLookup: () => void;
  // The button above has something to undo: a typed rate, or a saved own rate.
  canReset: boolean;
  // A typed rate that is empty or not above 0 — a save must be stopped, since
  // the field would not be what is saved.
  typedInvalid: boolean;
  // What a PATCH of the invoice should carry as `exchangeRate`: a number = the
  // rate typed in (källa manuell); null = back to the automatic rate (the
  // API looks up the invoice date's rate); undefined = nothing, the API's own
  // rules apply (it looks up again when the currency changes, when the date
  // changes and the rate is not typed in, and when the rate is missing). A
  // looked-up or saved rate is never sent as if it were typed in.
  patchValue: number | null | undefined;
}

// How the shown Kurs comes about: the rate the invoice was saved with
// ("stored", draft card only), a rate typed in, or the automatic lookup for
// the invoice date.
type RateMode = "stored" | "typed" | "auto";

// The Kurs of a supplier invoice (dialog and draft card) — the touched
// pattern: the field follows the lookup for the invoice date and the invoice's
// currency until the user types in it; a changed date or currency looks it up
// again unless the user has.
//
// The draft card passes `stored` (the rate the invoice was saved with, "" =
// "kurs saknas"). The saved rate stays on show until the API would replace it:
// a changed invoice date makes it look the rate up again — unless the saved
// rate was typed in by hand (source manual), which a date change leaves alone.
// A rate that is missing starts as the automatic lookup. Everything shown is
// derived from that, so the field, its source line and the SEK preview always
// match what the save records.
export function useInvoiceRate(options: {
  currency: string | null;
  date: string;
  stored?: {
    rate: string;
    source: DocumentRateSourceValue | null;
    sourceDate: string | null;
    // The invoice date the invoice was saved with.
    invoiceDate: string;
  };
}): InvoiceRate {
  const { currency, date, stored } = options;
  const hasStored = stored !== undefined;
  const storedMissing = hasStored && stored.rate.trim() === "";
  const storedManual = hasStored && stored.source === "manual";
  const startMode: RateMode = hasStored && !storedMissing ? "stored" : "auto";
  const [mode, setMode] = useState<RateMode>(startMode);
  const [typed, setTyped] = useState("");
  const code = currency?.trim().toUpperCase() ?? null;

  // The automatic rate is asked for while it is what the field shows — or, for
  // a saved rate, once the date differs from the saved one and the API would
  // look it up again. A typed rate (or an own saved one) switches it off.
  const lookupWanted =
    mode === "auto" || (mode === "stored" && hasStored && !storedManual && date !== stored.invoiceDate);
  const lookup = useExchangeRateLookup(lookupWanted ? code : null, lookupWanted ? date : "");
  // An answer for another date or currency than the current one is stale (the
  // lookup hook only drops it in an effect, one render later).
  const lookedUp =
    lookupWanted && lookup.status === "ok" && lookup.lookup.currency === code && lookup.lookup.requestedDate === date
      ? lookup.lookup
      : null;

  // Another currency (another supplier picked) makes the typed rate
  // meaningless: start over — the lookup then fills in the new currency's rate.
  const previousCurrency = useRef(code);
  useEffect(() => {
    if (previousCurrency.current === code) return;
    previousCurrency.current = code;
    setMode(startMode);
    setTyped("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  let rate: string;
  let sourceText: string | null;
  let fromRiksbank = false;
  if (mode === "typed") {
    rate = typed;
    sourceText = "manuell";
  } else if (lookupWanted) {
    rate = lookedUp ? String(lookedUp.rate) : "";
    const source: DocumentRateSourceValue | null = lookedUp ? (lookedUp.source === "manual" ? "register" : "riksbank") : null;
    sourceText = lookedUp ? documentRateSourceText(source, lookedUp.date) : null;
    fromRiksbank = source === "riksbank";
  } else {
    rate = hasStored ? stored.rate : "";
    sourceText = hasStored ? documentRateSourceText(stored.source, stored.sourceDate) : null;
    fromRiksbank = hasStored && stored.source === "riksbank";
  }

  const typedNumber = Number(typed.replace(",", "."));
  const typedInvalid = mode === "typed" && !(Number.isFinite(typedNumber) && typedNumber > 0);

  return {
    rate,
    touched: mode === "typed",
    sourceText,
    fromRiksbank,
    loading: lookupWanted && lookedUp === null && (lookup.status === "loading" || lookup.status === "ok"),
    problem: lookupWanted && lookedUp === null && lookup.status === "error" ? lookup.message : null,
    setRate: (value: string) => {
      setMode("typed");
      setTyped(value);
    },
    // A saved automatic rate is simply shown again; a saved own rate (or a
    // missing one, or the dialog's blank field) goes to the lookup.
    resetToLookup: () => {
      setMode(hasStored && !storedMissing && !storedManual ? "stored" : "auto");
      setTyped("");
    },
    canReset: mode === "typed" || (mode === "stored" && storedManual),
    typedInvalid,
    patchValue: mode === "typed" ? (typedInvalid ? undefined : typedNumber) : mode === "auto" && hasStored ? null : undefined,
  };
}

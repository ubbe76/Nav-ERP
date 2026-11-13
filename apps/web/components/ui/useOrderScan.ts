"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { OrderCountState } from "../../lib/orderScan";
import type { ScanGs1, ScanMatch, ScanResult } from "../../lib/types";

// The React half of skanning mot en order (#4) — shared by Inleverans and
// Utleverans; the rules themselves are pure in lib/orderScan.ts.

export type ScanFeedbackState = { tone: "ok" | "warn"; text: string };

// What the last scan did, shown under the scan field (ScanPanel): a warning
// also gives a short buzz on phones that have it — the warehouse is loud.
export function useScanFeedback() {
  const [feedback, setFeedback] = useState<ScanFeedbackState | null>(null);
  const ok = useCallback((text: string) => setFeedback({ tone: "ok", text }), []);
  const warn = useCallback((text: string) => {
    setFeedback({ tone: "warn", text });
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(200);
  }, []);
  const clear = useCallback(() => setFeedback(null), []);
  return { feedback, ok, warn, clear };
}

const ORDER_KINDS = new Set<ScanMatch["kind"]>(["purchaseOrder", "salesOrder", "manufacturingOrder"]);

// The scans of a routine, looked up with GET /scan one after the other in
// arrival order and never dropped: three quick handheld scans are three
// counted. Articles and locations are what gets scanned over and over, so
// they are remembered for the page; a code naming an order is asked for
// again, since its status may change while the page is open — and so is a
// code that names a batch or a serienummer, or nothing at all (the number
// may be received a moment later). `handle` runs after the previous scan's
// handler has finished; `gs1` is what a GS1 code carried next to its GTIN
// (batch, serienummer, utgångsdatum), null for an ordinary code.
export function useScanQueue(
  handle: (code: string, matches: ScanMatch[], gs1: ScanGs1 | null) => Promise<void> | void,
  onLookupError: (message: string) => void
): (code: string) => void {
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lookups = useRef(new Map<string, ScanResult>());
  const handlers = useRef({ handle, onLookupError });
  useEffect(() => {
    handlers.current = { handle, onLookupError };
  });

  return useCallback((code: string) => {
    queue.current = queue.current
      .then(async () => {
        let result = lookups.current.get(code);
        if (!result) {
          try {
            result = await apiFetch<ScanResult>(`/api/v1/scan?code=${encodeURIComponent(code)}`);
          } catch (err) {
            handlers.current.onLookupError(apiErrorMessage(err, "Kunde inte slå upp koden"));
            return;
          }
          if (result.matches.length > 0 && !result.matches.some((m) => ORDER_KINDS.has(m.kind) || m.kind === "batch")) {
            lookups.current.set(code, result);
          }
        }
        // The code as a person reads it: the separator is not shown.
        await handlers.current.handle(displayScanCode(code), result.matches, result.gs1 ?? null);
      })
      .catch(() => undefined);
  }, []);
}

// A scanned code for a message: without the GS1 group separator and other
// control characters (the lookup is sent the raw code).
export function displayScanCode(code: string): string {
  // eslint-disable-next-line no-control-regex
  return code.replace(/[\x00-\x1f\x7f]/g, "");
}

// The counted quantities, mirrored in a ref: queued scans are handled faster
// than React re-renders, and each must count on top of the previous one.
export function useCountState(initial: OrderCountState) {
  const [count, setState] = useState(initial);
  const countRef = useRef(initial);
  const setCount = useCallback((next: OrderCountState) => {
    countRef.current = next;
    setState(next);
  }, []);
  return { count, countRef, setCount };
}

// State that queued scans read and write: mirrored in a ref that is updated
// at once, so a scan handled before React re-renders builds on the previous
// one (as useCountState does for the quantities). The setter takes a value
// or an updater, like useState's.
export function useScanState<T>(initial: T): [T, RefObject<T>, (next: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T | ((prev: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (prev: T) => T)(ref.current) : next;
    setState(ref.current);
  }, []);
  return [state, ref, set];
}

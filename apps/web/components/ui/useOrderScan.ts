"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { OrderCountState } from "../../lib/orderScan";
import type { ScanMatch, ScanResult } from "../../lib/types";

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
// again, since its status may change while the page is open. `handle` runs
// after the previous scan's handler has finished.
export function useScanQueue(
  handle: (code: string, matches: ScanMatch[]) => Promise<void> | void,
  onLookupError: (message: string) => void
): (code: string) => void {
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lookups = useRef(new Map<string, ScanMatch[]>());
  const handlers = useRef({ handle, onLookupError });
  useEffect(() => {
    handlers.current = { handle, onLookupError };
  });

  return useCallback((code: string) => {
    queue.current = queue.current
      .then(async () => {
        let matches = lookups.current.get(code);
        if (!matches) {
          try {
            matches = (await apiFetch<ScanResult>(`/api/v1/scan?code=${encodeURIComponent(code)}`)).matches;
          } catch (err) {
            handlers.current.onLookupError(apiErrorMessage(err, "Kunde inte slå upp koden"));
            return;
          }
          if (!matches.some((m) => ORDER_KINDS.has(m.kind))) lookups.current.set(code, matches);
        }
        await handlers.current.handle(code, matches);
      })
      .catch(() => undefined);
  }, []);
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

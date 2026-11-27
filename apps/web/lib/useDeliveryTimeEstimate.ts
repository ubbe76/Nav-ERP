"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { apiErrorMessage } from "./errorMessages";
import { runDeliveryTimeCheck, type DeliveryTimeCheckRequest } from "./deliveryTimeCheck";
import type { DeliveryTimeCheckResult } from "./types";

export const ESTIMATE_DELAY_MS = 800;

export interface DeliveryTimeEstimate {
  state: "idle" | "waiting" | "loading" | "done" | "error";
  // The latest answer; kept (dimmed by the box) while a newer one is coming.
  result: DeliveryTimeCheckResult | null;
  error: string | null;
  errorCode: string | undefined;
}

const IDLE: DeliveryTimeEstimate = { state: "idle", result: null, error: null, errorCode: undefined };

// The estimate behind the Leveranstid box: the existing delivery-time check
// (POST /delivery-time-check — books nothing) run 800 ms after `key` last
// changed. A request sequence makes sure a late answer never overwrites a
// newer one; while the tab is hidden nothing is sent, and the estimate runs
// when it is visible again.
export function useDeliveryTimeEstimate(request: DeliveryTimeCheckRequest | null, key: string): DeliveryTimeEstimate {
  const [est, setEst] = useState<DeliveryTimeEstimate>(IDLE);
  const [visible, setVisible] = useState(true);
  const seq = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const hasRequest = request !== null;

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    const mySeq = ++seq.current;
    if (!hasRequest) {
      setEst(IDLE);
      return;
    }
    setEst((prev) => ({ ...prev, state: "waiting" }));
    if (!visible) return;
    const timer = setTimeout(() => {
      const body = requestRef.current;
      if (!body) return;
      setEst((prev) => ({ ...prev, state: "loading" }));
      runDeliveryTimeCheck(body)
        .then((result) => {
          if (seq.current === mySeq) setEst({ state: "done", result, error: null, errorCode: undefined });
        })
        .catch((err) => {
          if (seq.current !== mySeq) return;
          setEst({
            state: "error",
            result: null,
            error: apiErrorMessage(err, "Kunde inte räkna ut leveranstiden"),
            errorCode: err instanceof ApiError ? err.code : undefined,
          });
        });
    }, ESTIMATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      seq.current++;
    };
  }, [key, visible, hasRequest]);

  return est;
}

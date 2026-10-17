"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import type { DeliveryDateSuggestion } from "./types";

const WARNING_DEBOUNCE_MS = 300;

export interface DeliveryDateHintState {
  // The suggested date, or null while loading / when the partner has no
  // delivery days. Reset to null the moment the partner/article changes, so a
  // field that still holds the previous suggestion can be cleared.
  suggestion: DeliveryDateSuggestion | null;
  summary: string | null;
  warning: string | null;
}

// Shared engine: one request for the suggestion (keyed on `path`) and one,
// debounced, for the warning on `date`. Each has its own request sequence so a
// late answer for an earlier partner/article/date never overwrites a newer
// one. Errors (404, network) simply mean no suggestion.
function useDeliveryDateSuggestion(
  path: string | null,
  date: string,
  options: { suggest: boolean }
): DeliveryDateHintState {
  const [suggestion, setSuggestion] = useState<DeliveryDateSuggestion | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const suggestionSeq = useRef(0);
  const warningSeq = useRef(0);
  const { suggest } = options;

  useEffect(() => {
    const seq = ++suggestionSeq.current;
    setSuggestion(null);
    if (!path || !suggest) return;
    apiFetch<DeliveryDateSuggestion>(path)
      .then((res) => {
        if (seq === suggestionSeq.current) setSuggestion(res);
      })
      .catch(() => {});
  }, [path, suggest]);

  useEffect(() => {
    const seq = ++warningSeq.current;
    setWarning(null);
    if (!path || !date) return;
    const timer = setTimeout(() => {
      const sep = path.includes("?") ? "&" : "?";
      apiFetch<DeliveryDateSuggestion>(`${path}${sep}date=${encodeURIComponent(date)}`)
        .then((res) => {
          if (seq === warningSeq.current) setWarning(res.warning);
        })
        .catch(() => {});
    }, WARNING_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path, date]);

  return { suggestion, summary: suggestion?.summary ?? null, warning };
}

// Supplier side. Without `articleId` it is the purchase order's header
// suggestion, with `articleId` the row suggestion. `suggest: false` skips the
// suggestion request (a row being edited only wants the warning).
export function useSupplierDeliveryDateSuggestion(args: {
  supplierId: string | null;
  articleId?: string | null;
  date: string;
  suggest?: boolean;
}): DeliveryDateHintState {
  const { supplierId, articleId, date, suggest = true } = args;
  const path = supplierId
    ? `/api/v1/supplier-delivery-date-suggestion?supplierId=${supplierId}${articleId ? `&articleId=${articleId}` : ""}`
    : null;
  return useDeliveryDateSuggestion(path, date, { suggest });
}

export function useCustomerDeliveryDateSuggestion(args: {
  customerId: string | null;
  date: string;
}): DeliveryDateHintState {
  const { customerId, date } = args;
  const path = customerId ? `/api/v1/customer-delivery-date-suggestion?customerId=${customerId}` : null;
  return useDeliveryDateSuggestion(path, date, { suggest: true });
}

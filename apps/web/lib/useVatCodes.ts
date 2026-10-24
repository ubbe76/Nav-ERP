"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { VatCodeView } from "./vatCodes";

// The company's momskoder (GET /vat-codes, catalog order) for the document
// forms. Fetched on mount — a handful of rows, and a code deactivated on
// Ekonomi → Momskoder must not linger in a cache. `loaded` is false until the
// answer arrives (or failed): the forms then keep their automatic choice.
export function useVatCodes(options: { enabled?: boolean } = {}): { codes: VatCodeView[]; loaded: boolean } {
  const { enabled = true } = options;
  const [codes, setCodes] = useState<VatCodeView[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<VatCodeView[]>("/api/v1/vat-codes")
      .then((rows) => {
        if (!cancelled) setCodes(rows);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { codes, loaded };
}

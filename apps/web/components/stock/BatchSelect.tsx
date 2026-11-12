"use client";

import { useEffect, useMemo, useState } from "react";
import { Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { BATCH_AUTO, BATCH_UNKNOWN, batchOptions } from "../../lib/batch";
import { formatQuantity } from "../../lib/format";
import type { BatchBalanceRow } from "../../lib/types";

// Batch balances (#8) for batch-tracked articles, in draw order. Refetches
// when the article set changes; `reload` after a write.
export function useBatchBalances(articleIds: string[]): {
  rows: BatchBalanceRow[];
  reload: () => void;
} {
  const [rows, setRows] = useState<BatchBalanceRow[]>([]);
  const [tick, setTick] = useState(0);
  const key = [...new Set(articleIds)].sort().slice(0, 200).join(",");
  useEffect(() => {
    if (key === "") {
      setRows([]);
      return;
    }
    let cancelled = false;
    apiFetch<{ rows: BatchBalanceRow[] }>(`/api/v1/stock/batch-balances?articleIds=${key}`)
      .then((r) => {
        if (!cancelled) setRows(r.rows);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);
  return { rows, reload: () => setTick((t) => t + 1) };
}

// Batch choice: Automatiskt (default) / Okänd / the batches with stock,
// narrowed to the picked location when there is one.
export function BatchSelect({
  rows,
  articleId,
  locationId,
  value,
  onChange,
  id,
  disabled,
  size,
  "aria-label": ariaLabel,
}: {
  rows: BatchBalanceRow[];
  articleId: string;
  locationId?: string | null;
  value: string;
  onChange: (v: string) => void;
  id?: string;
  disabled?: boolean;
  size?: "xs" | "sm" | "md";
  "aria-label"?: string;
}) {
  const options = useMemo(() => batchOptions(rows, articleId, locationId), [rows, articleId, locationId]);
  // A chosen batch that no longer has stock at the picked location falls
  // back to Automatiskt.
  useEffect(() => {
    if (value !== BATCH_AUTO && value !== BATCH_UNKNOWN && !options.some((o) => o.value === value)) {
      onChange(BATCH_AUTO);
    }
  }, [options, value, onChange]);
  return (
    <Select
      id={id}
      size={size}
      aria-label={ariaLabel ?? "Batch"}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value={BATCH_AUTO}>Automatiskt</option>
      {!options.some((o) => o.value === BATCH_UNKNOWN) && <option value={BATCH_UNKNOWN}>Okänd</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label} ({formatQuantity(String(o.quantity))})
        </option>
      ))}
    </Select>
  );
}

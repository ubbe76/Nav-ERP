"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { computeLineMargin, formatMargin } from "../../lib/margin";
import type { ArticleSelfCost } from "../../lib/types";

// The self cost behind a row form's täckningsbidrag. A row being priced does
// not exist yet, so it cannot get its cost from listRows the way saved rows do
// — this fetches it per article instead, once per article rather than per
// keystroke, and the margin is then recomputed locally as the price is typed.
//
// The same requestSeq guard the price prefill uses: a response for a
// previously selected article must never be shown against the current one.
export function useArticleSelfCost(articleId: string | null): number | null {
  const [selfCostPerUnit, setSelfCostPerUnit] = useState<number | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!articleId) {
      setSelfCostPerUnit(null);
      return;
    }
    apiFetch<ArticleSelfCost | null>(`/api/v1/articles/${articleId}/self-cost`)
      .then((found) => {
        if (seq !== requestSeq.current) return;
        setSelfCostPerUnit(found?.selfCostPerUnit ?? null);
      })
      .catch(() => {
        // Best-effort: no margin shown rather than an error on a form whose
        // real job is to add a row.
        if (seq === requestSeq.current) setSelfCostPerUnit(null);
      });
  }, [articleId]);

  return selfCostPerUnit;
}

// Konfigurator 4c: a configured draft row's self cost — the förkalkyl of ITS
// derived structure at the row's quantity (POST /configurator/:id/derive),
// not the template's saved calculation. Same requestSeq guard as
// useArticleSelfCost: only the latest selection/quantity's answer is shown.
export function useConfiguredSelfCost(
  templateId: string | null,
  selection: Record<string, unknown> | null,
  quantity: number | null
): number | null {
  const [cost, setCost] = useState<number | null>(null);
  const requestSeq = useRef(0);
  const key =
    templateId && selection && quantity && quantity > 0 ? JSON.stringify([templateId, selection, quantity]) : null;
  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!key) {
      setCost(null);
      return;
    }
    const [id, sel, qty] = JSON.parse(key) as [string, Record<string, unknown>, number];
    apiFetch<{ costing: { selfCostPerUnit: number } | null }>(`/api/v1/configurator/${id}/derive`, {
      method: "POST",
      body: JSON.stringify({ selection: sel, quantity: qty }),
    })
      .then((r) => {
        if (seq !== requestSeq.current) return;
        const v = r.costing?.selfCostPerUnit;
        setCost(v !== undefined && Number.isFinite(v) && v > 0 ? v : null);
      })
      .catch(() => {
        if (seq === requestSeq.current) setCost(null);
      });
  }, [key]);
  return cost;
}

// "TB 1 234,00 kr · TG 32,1 %" for one line being priced, in the article's BASE
// unit — quantity and price are both converted by the caller, so the two agree.
//
// Valuta: the self cost is in SEK, so a price in another currency is converted
// with the order's rate (`exchangeRate`, SEK per 1 unit; omitted = 1) before it
// is measured against it — the figure is then SEK, which the label says.
export function marginLabel(
  selfCostPerUnit: number | null,
  baseQuantity: number | null,
  baseUnitPrice: number,
  discountPercent: number,
  exchangeRate: number | null = 1
): string | null {
  if (baseQuantity === null || !Number.isFinite(baseUnitPrice)) return null;
  // A foreign price without a usable rate cannot be compared with a SEK cost.
  if (exchangeRate === null) return "TB — (kurs saknas)";
  const label = formatMargin(
    computeLineMargin({
      quantity: baseQuantity,
      unitPrice: baseUnitPrice * exchangeRate,
      discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0,
      selfCostPerUnit,
    })
  );
  return exchangeRate === 1 ? label : `${label} · räknat i SEK`;
}

"use client";

import { useEffect, useState } from "react";
import { Select } from "./Field";
import { apiFetch } from "../../lib/api";
import type { Article, ArticleUnit } from "../../lib/types";

// Unit choice on an order/BOM row: the article's base unit plus its
// alternative units. `value` is the unit's register id, "" = the base unit.
// factor = quantity_per_base ("1 base unit = factor of this unit"), 1 for
// the base unit itself.
export interface UnitOption {
  value: string;
  code: string;
  factor: number;
}

// Loads the unit options for a picked article (base unit immediately, the
// alternative units once /articles/:id/units answers).
export function useUnitOptions(article: Pick<Article, "id" | "unit"> | null): UnitOption[] {
  const [options, setOptions] = useState<UnitOption[]>([]);

  const articleId = article?.id ?? null;
  const baseCode = article?.unit ?? null;

  useEffect(() => {
    if (!articleId || !baseCode) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const base: UnitOption = { value: "", code: baseCode, factor: 1 };
    setOptions([base]);
    apiFetch<ArticleUnit[]>(`/api/v1/articles/${articleId}/units`)
      .then((units) => {
        if (cancelled) return;
        setOptions([base, ...units.map((u) => ({ value: u.unitId, code: u.unitCode, factor: Number(u.quantityPerBase) }))]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [articleId, baseCode]);

  return options;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Re-expresses an entered quantity when the row's unit is switched
// (500 kg → 100 st at factors 5 → 1). Empty/invalid input passes through.
export function convertQuantityInput(raw: string, fromFactor: number, toFactor: number): string {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return raw;
  return String(round4((n / fromFactor) * toFactor));
}

// Prices convert in the opposite direction (12 kr/kg → 60 kr/st).
export function convertPriceInput(raw: string, fromFactor: number, toFactor: number): string {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return raw;
  return String(round4((n * fromFactor) / toFactor));
}

export function UnitSelect({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: UnitOption[];
  value: string;
  onChange: (option: UnitOption) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled || options.length === 0}
      onChange={(e) => {
        const option = options.find((o) => o.value === e.target.value);
        if (option) onChange(option);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.code}
        </option>
      ))}
    </Select>
  );
}

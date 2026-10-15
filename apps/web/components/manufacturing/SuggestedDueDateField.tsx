"use client";

import { useEffect, useRef, useState } from "react";
import { Field, Input } from "../ui/Field";
import { FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { DueDateSuggestion } from "../../lib/types";

// Planerat färdigdatum for a new TO, prefilled from
// GET /articles/:id/due-date-suggestion: one working day before the
// article's first firm demand that stock and open IO/TO don't already cover
// (with salesOrderRowId: before that KO row's delivery date, if the row is
// uncovered), today at the earliest. Manual wins — the field is
// only (re)filled while it still holds the last suggestion or is empty, so a
// typed date survives a later article change. A request sequence drops
// answers for an article that is no longer selected.
export function SuggestedDueDateField({
  id,
  label = "Planerat färdigdatum (valfritt)",
  articleId,
  salesOrderRowId,
  value,
  onChange,
}: {
  id: string;
  label?: string;
  articleId: string | null;
  salesOrderRowId?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [suggestion, setSuggestion] = useState<DueDateSuggestion | null>(null);
  const autoValue = useRef("");
  const requestSeq = useRef(0);
  // Read inside the effect without re-running it on every keystroke.
  const current = useRef({ value, onChange });
  current.current = { value, onChange };

  useEffect(() => {
    const seq = ++requestSeq.current;
    const apply = (next: DueDateSuggestion | null) => {
      if (seq !== requestSeq.current) return;
      setSuggestion(next);
      const { value: now, onChange: set } = current.current;
      if (now === "" || now === autoValue.current) {
        autoValue.current = next?.dueDate ?? "";
        set(autoValue.current);
      }
    };
    if (!articleId) {
      apply(null);
      return;
    }
    const query = salesOrderRowId ? `?salesOrderRowId=${salesOrderRowId}` : "";
    apiFetch<{ suggestion: DueDateSuggestion | null }>(`/api/v1/articles/${articleId}/due-date-suggestion${query}`)
      .then((res) => apply(res.suggestion))
      // A failed suggestion just leaves the field as it is — it's optional.
      .catch(() => apply(null));
  }, [articleId, salesOrderRowId]);

  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} type="date" size="sm" value={value} onChange={(e) => onChange(e.target.value)} />
      {suggestion && value === suggestion.dueDate && <FormHint attached>{suggestionText(suggestion)}</FormHint>}
    </Field>
  );
}

export function suggestionText(s: DueDateSuggestion): string {
  if (s.documentNumber === null) return "Saldot är redan negativt — föreslår idag.";
  const what =
    s.source === "sales_order_row"
      ? `kundorderns leveransdatum ${s.demandDate} (${s.documentNumber})`
      : `första bristen ${s.demandDate} (${s.documentNumber})`;
  return s.clampedToToday
    ? `Arbetsdagen före ${what} har redan passerat — idag föreslås.`
    : `Föreslaget: arbetsdagen före ${what}.`;
}

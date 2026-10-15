"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { VariantOf } from "./configurator";

// Fetches GET /articles/:id/variant-of. undefined = loading, null = the
// article is not a stocked variant (the endpoint answers 404 then; any other
// failure also falls back to the plain card).
export function useVariantOf(articleId: string): VariantOf | null | undefined {
  const [state, setState] = useState<{ id: string; value: VariantOf | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<VariantOf>(`/api/v1/articles/${articleId}/variant-of`)
      .then((value) => {
        if (!cancelled) setState({ id: articleId, value });
      })
      .catch(() => {
        if (!cancelled) setState({ id: articleId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  if (!state || state.id !== articleId) return undefined;
  return state.value;
}

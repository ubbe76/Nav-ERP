"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ListPlus } from "lucide-react";
import { ArticlePicker } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Article, LegoOperationOption } from "../../lib/types";

const PICKER_ID = "inquiryRowEntryArticle";
const QUANTITY_ID = "inquiryRowEntryQuantity";

function focusField(id: string, select = false) {
  // After React has drawn the field (a new article shows the inputs). The
  // article picker refills its last search on focus, so the text is selected
  // a frame later — the next article number then replaces it.
  window.setTimeout(() => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    if (select) window.requestAnimationFrame(() => el?.select());
  }, 0);
}

// + Ny rad on the förfrågan card (Programramen steg 3, "Direkt i tabellen"):
// an ordinary row — article, Antal, Enhet (the purchase unit pre-selected)
// and an optional Á-pris (the supplier's answer, often filled in later).
// No revision on an inquiry, so no question. A lego row (the operation and
// its ställpris) is the Lägg till rad dialog's — the row says so when the
// picked article has lego operations.
export function useInquiryRowEntry({
  inquiryId,
  disabled,
  onDialog,
}: {
  inquiryId: string;
  disabled: boolean;
  onDialog: (article: Article | null, quantity: string) => void;
}): {
  article: Article | null;
  error: string | null;
  hasLego: boolean;
  cells: Record<string, ReactNode>;
} {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitId, setUnitId] = useState("");
  const [hasLego, setHasLego] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;

  function clear() {
    setArticle(null);
    setQuantity("1");
    setUnitPrice("");
    setUnitId("");
    setHasLego(false);
  }

  function pick(next: Article | null) {
    setError(null);
    setArticle(next);
    setUnitId(next?.purchaseUnitId ?? "");
    setUnitPrice("");
    setHasLego(false);
    if (next) {
      focusField(QUANTITY_ID, true);
      apiFetch<LegoOperationOption[]>(`/api/v1/articles/${next.id}/lego-operations`)
        .then((options) => setHasLego(options.length > 0))
        .catch(() => setHasLego(false));
    }
  }

  function changeUnit(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  async function submit() {
    if (pending || disabled) return;
    if (!article) {
      setError("Välj en artikel");
      focusField(PICKER_ID);
      return;
    }
    if (!(Number(quantity) > 0)) {
      setError("Ange ett antal större än 0");
      focusField(QUANTITY_ID, true);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/inquiries/${inquiryId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          unitPrice: unitPrice.trim() === "" ? undefined : Number(unitPrice),
          unitId: unitId === "" ? null : unitId,
        }),
      });
      clear();
      router.refresh();
      focusField(PICKER_ID, true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till raden"));
    } finally {
      setPending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clear();
      focusField(PICKER_ID);
    }
  }

  const cells: Record<string, ReactNode> = {
    articleNumber: (
      <div style={{ flex: 1, minWidth: 0 }}>
        <ArticlePicker id={PICKER_ID} orderable value={article} onChange={pick} placeholder="+ Ny rad — sök artikel…" />
      </div>
    ),
  };
  if (article) {
    cells.quantity = (
      <Input
        id={QUANTITY_ID}
        type="number"
        min="0"
        step="any"
        aria-label="Antal"
        value={quantity}
        disabled={disabled}
        onChange={(e) => setQuantity(e.target.value)}
        onKeyDown={onKey}
        style={{ textAlign: "right" }}
      />
    );
    cells.unitCode =
      unitOptions.length > 1 ? (
        <UnitSelect id="inquiryRowEntryUnit" options={unitOptions} value={unitId} onChange={changeUnit} disabled={disabled} />
      ) : (
        unitCode ?? null
      );
    cells.unitPrice = (
      <Input
        type="number"
        min="0"
        step="any"
        aria-label="Á-pris (valfritt)"
        placeholder="Valfritt"
        value={unitPrice}
        disabled={disabled}
        onChange={(e) => setUnitPrice(e.target.value)}
        onKeyDown={onKey}
        style={{ textAlign: "right" }}
      />
    );
  }
  cells.id = (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
      {article && (
        <Button type="button" size="small" variant="primary" disabled={pending || disabled} onClick={() => void submit()}>
          {pending ? "Sparar…" : "Lägg till"}
        </Button>
      )}
      <Button
        type="button"
        size="small"
        variant="ghost"
        disabled={pending || disabled}
        aria-label="Fler fält…"
        title="Fler fält… — legooperation och ställpris"
        icon={<ListPlus size={16} strokeWidth={1.8} aria-hidden="true" />}
        onClick={() => {
          onDialog(article, quantity);
          clear();
        }}
      />
    </span>
  );

  return { article, error, hasLego, cells };
}

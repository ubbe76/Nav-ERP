"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ListPlus } from "lucide-react";
import { ArticlePicker } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { askBumpRevision } from "../../lib/revision";
import { formatMoney } from "../../lib/format";
import { toBaseQuantity, toUnitPrice } from "../../lib/units";
import { useSupplierDeliveryDateSuggestion } from "../../lib/useDeliveryDateSuggestion";
import type { Article, SupplierPriceQuote } from "../../lib/types";

const PICKER_ID = "purchaseRowEntryArticle";
const QUANTITY_ID = "purchaseRowEntryQuantity";

function focusField(id: string, select = false) {
  window.setTimeout(() => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    if (select) el?.select();
  }, 0);
}

// + Ny rad on the inköpsorder card (Programramen steg 3, "Direkt i
// tabellen"), the purchase twin of useSalesRowEntry: the same rules as the
// Lägg till rad dialog — the purchase unit pre-selected, the supplier's
// catalog price (staffel) for the entered quantity until the price is typed
// over (touched flag read when the answer lands, request sequence; another
// currency than the order's leaves the field alone), and the article's
// arrival suggestion as the row's Önskat leveransdatum when it falls after
// the order's date. Own dates and the confirmed date are the dialog's (Fler
// fält…).
export function usePurchaseRowEntry({
  orderId,
  supplierId,
  currency,
  revision,
  orderDeliveryDate,
  disabled,
  onDialog,
}: {
  orderId: string;
  supplierId: string;
  currency: string;
  revision: number;
  orderDeliveryDate: string | null;
  disabled: boolean;
  onDialog: (article: Article | null, quantity: string) => void;
}): {
  article: Article | null;
  error: string | null;
  // The staffel step behind the suggested price (base unit), and the row's
  // own date the suggestion gives — said under the table.
  priceTier: number | null;
  suggestedDate: string | null;
  cells: Record<string, ReactNode>;
  span: Record<string, number>;
} {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [unitId, setUnitId] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [priceTier, setPriceTier] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  const requestSeq = useRef(0);
  const priceTouchedNow = useRef(priceTouched);
  priceTouchedNow.current = priceTouched;
  const submitWhenQuoted = useRef(false);

  const { suggestion } = useSupplierDeliveryDateSuggestion({
    supplierId,
    articleId: article?.id ?? null,
    date: "",
    suggest: article !== null,
  });
  const suggested = suggestion?.date ?? null;
  const suggestedDate = article && suggested && (!orderDeliveryDate || suggested > orderDeliveryDate) ? suggested : null;

  function clear() {
    setArticle(null);
    setQuantity("1");
    setUnitPrice("0");
    setUnitId("");
    setPriceTouched(false);
    setPriceTier(null);
    requestSeq.current++;
  }

  function pick(next: Article | null) {
    setError(null);
    setArticle(next);
    setUnitId(next?.purchaseUnitId ?? "");
    setUnitPrice("0");
    setPriceTouched(false);
    setPriceTier(null);
    if (next) focusField(QUANTITY_ID, true);
  }

  function changeUnit(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  const articleId = article?.id ?? null;
  const entered = Number(quantity);
  const baseQuantity = articleId && Number.isFinite(entered) && entered > 0 ? toBaseQuantity(entered, currentFactor) : null;

  useEffect(() => {
    if (priceTouched || !articleId || baseQuantity === null) {
      setQuoting(false);
      return;
    }
    const seq = ++requestSeq.current;
    setQuoting(true);
    apiFetch<SupplierPriceQuote>(`/api/v1/supplier-price-quote?supplierId=${supplierId}&articleId=${articleId}&quantity=${baseQuantity}`)
      .then((quote) => {
        if (seq !== requestSeq.current || priceTouchedNow.current) return;
        if (!quote.price || quote.price.currency !== currency) {
          setPriceTier(null);
          return;
        }
        setUnitPrice(String(toUnitPrice(quote.price.unitPrice, currentFactor)));
        setPriceTier(quote.price.source === "break" ? quote.price.fromQuantity : null);
      })
      .catch(() => {})
      .finally(() => {
        if (seq === requestSeq.current) setQuoting(false);
      });
  }, [articleId, baseQuantity, supplierId, currency, priceTouched, currentFactor]);

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
    if (quoting) {
      submitWhenQuoted.current = true;
      return;
    }
    const bumpRevision = await askBumpRevision(revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${orderId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          unitPrice: Number(unitPrice),
          unitId: unitId === "" ? null : unitId,
          expectedDeliveryDate: suggestedDate,
          bumpRevision,
        }),
      });
      clear();
      router.refresh();
      focusField(PICKER_ID);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till raden"));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (!quoting && submitWhenQuoted.current) {
      submitWhenQuoted.current = false;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoting]);

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
    cells.quantityOrdered = (
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
        <UnitSelect id="purchaseRowEntryUnit" options={unitOptions} value={unitId} onChange={changeUnit} disabled={disabled} />
      ) : (
        unitCode ?? null
      );
    cells.unitPrice = (
      <Input
        type="number"
        min="0"
        step="any"
        aria-label="Á-pris"
        value={unitPrice}
        disabled={disabled}
        onChange={(e) => {
          setPriceTouched(true);
          setUnitPrice(e.target.value);
        }}
        onKeyDown={onKey}
        style={{ textAlign: "right" }}
      />
    );
    const amount = Number(quantity) * Number(unitPrice);
    cells.lineAmount = Number.isFinite(amount) ? formatMoney(amount) : null;
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
        title="Fler fält… — eget önskat och bekräftat leveransdatum"
        icon={<ListPlus size={16} strokeWidth={1.8} aria-hidden="true" />}
        onClick={() => {
          onDialog(article, quantity);
          clear();
        }}
      />
    </span>
  );

  return { article, error, priceTier: priceTouched ? null : priceTier, suggestedDate, cells, span: { articleNumber: 2 } };
}

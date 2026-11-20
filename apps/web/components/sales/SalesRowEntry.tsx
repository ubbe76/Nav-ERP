"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ListPlus } from "lucide-react";
import { ArticlePicker } from "../ui/ArticlePicker";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { UnitSelect, convertPriceInput, convertQuantityInput, useUnitOptions, type UnitOption } from "../ui/UnitSelect";
import { ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { askBumpRevision } from "../../lib/revision";
import { formatMoney } from "../../lib/format";
import { toBaseQuantity, toUnitPrice } from "../../lib/units";
import { omitUnitPriceOnCreate, priceQuotePath } from "../../lib/priceQuote";
import type { Article, PriceQuote } from "../../lib/types";

export const ENTRY_PICKER_ID = "salesRowEntryArticle";
const QUANTITY_ID = "salesRowEntryQuantity";

function focusField(id: string, select = false) {
  // After React has drawn the field (a new article shows the inputs).
  window.setTimeout(() => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    if (select) el?.select();
  }, 0);
}

// + Ny rad on the kundorder/offert card (Programramen steg 3, the user's
// choice "Direkt i tabellen"): the last row of the rows table is an empty
// one — pick the article, Tab to Antal and À-pris, Enter adds the row and
// the empty row is ready for the next. The price is the price chain's
// suggestion until it is typed over ("manuellt vinner", the same rules as
// Lägg till rad: priceTouchedNow, the request sequence, an untouched chain
// suggestion left for the server to price). A configurable article and Fler
// fält… (rabatt, own delivery date, configuration) go to the Lägg till rad
// dialog with the article chosen.
export function useSalesRowEntry({
  orderId,
  customerId,
  revision,
  disabled,
  onDialog,
}: {
  orderId: string;
  customerId: string;
  revision: number;
  disabled: boolean;
  // Open Lägg till rad with this article (null = none yet) and quantity.
  onDialog: (article: Article | null, quantity: string) => void;
}): {
  article: Article | null;
  error: string | null;
  quote: PriceQuote | null;
  priceTouched: boolean;
  cells: Record<string, ReactNode>;
  span: Record<string, number>;
} {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [unitId, setUnitId] = useState(""); // "" = the article's base unit
  const [priceTouched, setPriceTouched] = useState(false);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unitOptions = useUnitOptions(article);
  const currentFactor = unitOptions.find((o) => o.value === unitId)?.factor ?? 1;
  const unitCode = unitOptions.find((o) => o.value === unitId)?.code;
  const requestSeq = useRef(0);
  const priceTouchedNow = useRef(priceTouched);
  priceTouchedNow.current = priceTouched;
  // Enter while the price suggestion is on its way: add the row once it has
  // landed (otherwise the field's old value went in as a handwritten price).
  const submitWhenQuoted = useRef(false);

  function clear() {
    setArticle(null);
    setQuantity("1");
    setUnitPrice("0");
    setDiscountPercent("0");
    setUnitId("");
    setPriceTouched(false);
    setQuote(null);
    requestSeq.current++;
  }

  function pick(next: Article | null) {
    setError(null);
    setQuote(null);
    if (next && (next.configuratorMode === "variants" || next.configuratorMode === "to_order")) {
      // Konfigurera is the dialog's: hand the article over.
      onDialog(next, quantity);
      clear();
      return;
    }
    // A new article starts over — the previous one's price means nothing here.
    setArticle(next);
    setUnitId(next?.salesUnitId ?? "");
    setUnitPrice("0");
    setDiscountPercent("0");
    setPriceTouched(false);
    if (next) focusField(QUANTITY_ID, true);
  }

  function changeUnit(option: UnitOption) {
    setQuantity((q) => convertQuantityInput(q, currentFactor, option.factor));
    setUnitPrice((p) => convertPriceInput(p, currentFactor, option.factor));
    setUnitId(option.value);
  }

  const articleId = article?.id ?? null;
  const entered = Number(quantity);
  const baseQuantity = Number.isFinite(entered) && entered > 0 ? toBaseQuantity(entered, currentFactor) : null;

  useEffect(() => {
    if (priceTouched || !articleId || baseQuantity === null) {
      setQuoting(false);
      return;
    }
    const seq = ++requestSeq.current;
    setQuoting(true);
    apiFetch<PriceQuote>(priceQuotePath({ customerId, articleId, quantity: baseQuantity, salesOrderId: orderId }))
      .then((answer) => {
        if (seq !== requestSeq.current || priceTouchedNow.current) return;
        setQuote(answer);
        if (!answer.price) return;
        setUnitPrice(String(toUnitPrice(answer.price.unitPrice, currentFactor)));
        setDiscountPercent(String(answer.price.discountPercent));
      })
      .catch(() => {
        // Best-effort prefill, as in Lägg till rad.
      })
      .finally(() => {
        if (seq === requestSeq.current) setQuoting(false);
      });
    // currentFactor too: a unit switch mid-flight must bump seq (see AddRowForm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, baseQuantity, customerId, priceTouched, currentFactor]);

  async function submit() {
    if (pending || disabled) return;
    if (!article) {
      setError("Välj en artikel");
      focusField(ENTRY_PICKER_ID);
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
      await apiFetch(`/api/v1/sales-orders/${orderId}/rows`, {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          ...(omitUnitPriceOnCreate(priceTouched, quote)
            ? {}
            : { unitPrice: Number(unitPrice), discountPercent: Number(discountPercent) }),
          unitId: unitId === "" ? null : unitId,
          bumpRevision,
        }),
      });
      clear();
      router.refresh();
      focusField(ENTRY_PICKER_ID);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte lägga till raden"));
      // The order's påslag changed meanwhile — read the order again.
      if (err instanceof ApiError && err.code === "sales-order-markups-changed") router.refresh();
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

  function onEnter(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clear();
      focusField(ENTRY_PICKER_ID);
    }
  }

  const amount = Number(quantity) * Number(unitPrice) * (1 - Number(discountPercent) / 100);

  const cells: Record<string, ReactNode> = {
    articleNumber: (
      <div style={{ flex: 1, minWidth: 0 }}>
        <ArticlePicker
          id={ENTRY_PICKER_ID}
          orderable
          configurable
          value={article}
          onChange={pick}
          placeholder="+ Ny rad — sök artikel…"
        />
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
        onKeyDown={onEnter}
        style={{ textAlign: "right" }}
      />
    );
    cells.unitCode =
      unitOptions.length > 1 ? (
        <UnitSelect id="salesRowEntryUnit" options={unitOptions} value={unitId} onChange={changeUnit} disabled={disabled} />
      ) : (
        unitCode ?? null
      );
    cells.unitPrice = (
      <Input
        type="number"
        step="any"
        aria-label="À-pris"
        value={unitPrice}
        disabled={disabled}
        onChange={(e) => {
          setPriceTouched(true);
          setUnitPrice(e.target.value);
        }}
        onKeyDown={onEnter}
        style={{ textAlign: "right" }}
      />
    );
    cells.discountPercent = (
      <Input
        type="number"
        min="0"
        max="100"
        step="0.01"
        aria-label="Rabatt (%)"
        value={discountPercent}
        disabled={disabled}
        onChange={(e) => {
          setPriceTouched(true);
          setDiscountPercent(e.target.value);
        }}
        onKeyDown={onEnter}
        style={{ textAlign: "right" }}
      />
    );
    cells.lineAmount = Number.isFinite(amount) ? formatMoney(amount) : null;
  }
  cells.id = (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
      {article && (
        <Button type="button" size="small" variant="primary" disabled={pending || disabled} onClick={() => void submit()}>
          {pending ? "Sparar…" : "Lägg till"}
        </Button>
      )}
      {/* Icon only, so the action column stays as narrow as the rows' Ändra + ⋯. */}
      <Button
        type="button"
        size="small"
        variant="ghost"
        disabled={pending || disabled}
        aria-label="Fler fält…"
        title="Fler fält… — eget leveransdatum, konfiguration"
        icon={<ListPlus size={16} strokeWidth={1.8} aria-hidden="true" />}
        onClick={() => {
          onDialog(article, quantity);
          clear();
        }}
      />
    </span>
  );

  return { article, error, quote, priceTouched, cells, span: { articleNumber: 2 } };
}

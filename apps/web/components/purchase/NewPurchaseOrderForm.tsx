"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useSupplierDeliveryDateSuggestion } from "../../lib/useDeliveryDateSuggestion";
import { DeliveryDateHint } from "../ui/DeliveryDateHint";
import type { Article, PurchaseOrder, Supplier, SupplierPriceQuote } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

// Skapa inköpsorder (Kvalitet): the avvikelse the order is created for. The
// note names the case, deviationId links the order to it in the create call,
// and the claimed article and quantity are added as the order's first row.
export interface NewPurchaseOrderDeviation {
  id: string;
  number: string;
  article: Article | null;
  quantity: number | null;
}

// Pass `lockedSupplier` (e.g. from the supplier card) to skip the supplier
// picker and create the order for that supplier directly.
export function NewPurchaseOrderForm({
  lockedSupplier,
  deviation,
}: {
  lockedSupplier?: Supplier;
  deviation?: NewPurchaseOrderDeviation;
}) {
  const router = useRouter();
  const [supplier, setSupplier] = useState<Supplier | null>(lockedSupplier ?? null);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  // Fasta leveransdagar: the supplier's suggestion prefills the date, but
  // "manuellt vinner" — once the operator has touched the field it is left
  // alone. An untouched field follows the suggestion, also back to empty.
  const [dateTouched, setDateTouched] = useState(false);
  const { suggestion, summary, warning } = useSupplierDeliveryDateSuggestion({
    supplierId: supplier?.id ?? null,
    date: expectedDeliveryDate,
  });
  useEffect(() => {
    if (dateTouched) return;
    setExpectedDeliveryDate(suggestion?.date ?? "");
  }, [suggestion, dateTouched]);
  const [note, setNote] = useState(deviation ? `Ersättning för ${deviation.number}` : "");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [yourReference, setYourReference] = useState("");
  const [ourReference, setOurReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supplier) {
      setError("Välj en leverantör");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const order = await apiFetch<PurchaseOrder>("/api/v1/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplier.id,
          expectedDeliveryDate: expectedDeliveryDate || undefined,
          note: note || undefined,
          exchangeRate: Number(exchangeRate),
          yourReference: yourReference.trim() || undefined,
          ourReference: ourReference.trim() || undefined,
          ...(deviation ? { deviationId: deviation.id } : {}),
        }),
      });
      if (deviation?.article && deviation.quantity != null) {
        // The order exists and is linked; the first row is best effort — a
        // failure here still lands on the order, where the row can be added.
        try {
          const quote = await apiFetch<SupplierPriceQuote>(
            `/api/v1/supplier-price-quote?supplierId=${supplier.id}&articleId=${deviation.article.id}&quantity=${deviation.quantity}`
          ).catch(() => null);
          const catalogPrice = quote?.price && quote.price.currency === order.currency ? quote.price.unitPrice : 0;
          await apiFetch(`/api/v1/purchase-orders/${order.id}/rows`, {
            method: "POST",
            body: JSON.stringify({
              articleId: deviation.article.id,
              quantity: deviation.quantity,
              unitPrice: catalogPrice,
              bumpRevision: false,
            }),
          });
        } catch {
          // keep going to the order
        }
      }
      router.push(`/inkop/ordrar/${order.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa inköpsordern"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {lockedSupplier ? (
        <Field label="Leverantör" htmlFor="supplierId">
          <Input id="supplierId" value={`${lockedSupplier.name} (${lockedSupplier.currency})`} disabled />
        </Field>
      ) : (
        <Field label="Leverantör" htmlFor="supplierId">
          <SearchPicker
            id="supplierId"
            endpoint="/api/v1/suppliers"
            value={supplier}
            onChange={setSupplier}
            formatLabel={(s) => `${s.supplierNumber} — ${s.name} (${s.currency})`}
            placeholder="Sök leverantörnummer eller namn…"
            emptyText="Inga leverantörer matchar sökningen"
          />
        </Field>
      )}

      <FormRow>
        <Field label="Önskat leveransdatum (valfritt)" htmlFor="expectedDeliveryDate">
          <Input
            id="expectedDeliveryDate"
            type="date"
            size="sm"
            value={expectedDeliveryDate}
            onChange={(e) => {
              setDateTouched(true);
              setExpectedDeliveryDate(e.target.value);
            }}
          />
          <DeliveryDateHint summary={summary} warning={warning} />
        </Field>
        <Field label="Växelkurs" htmlFor="exchangeRate">
          <Input
            id="exchangeRate"
            type="number"
            min="0"
            step="any"
            size="xs"
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
          />
        </Field>
      </FormRow>
      {supplier && supplier.currency !== "SEK" && (
        <FormHint attached>
          Leverantören fakturerar i {supplier.currency} — ange växelkursen mot SEK.
        </FormHint>
      )}

      <FormRow>
        <Field label="Er referens (valfritt)" htmlFor="yourReference">
          <Input
            id="yourReference"
            maxLength={100}
            value={yourReference}
            onChange={(e) => setYourReference(e.target.value)}
          />
        </Field>
        <Field label="Vår referens (valfritt)" htmlFor="ourReference">
          <Input
            id="ourReference"
            maxLength={100}
            value={ourReference}
            onChange={(e) => setOurReference(e.target.value)}
          />
        </Field>
      </FormRow>

      <Field label="Anteckning (valfritt)" htmlFor="note">
        <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa inköpsorder"}
        </Button>
      </FormActions>
    </Form>
  );
}

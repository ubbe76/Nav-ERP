"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Toggle } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useSupplierDeliveryDateSuggestion } from "../../lib/useDeliveryDateSuggestion";
import { useExchangeRateLookup } from "../../lib/useExchangeRate";
import { formatRate } from "../../lib/currency";
import { stockholmToday } from "../../lib/date";
import { DeliveryDateHint } from "../ui/DeliveryDateHint";
import type { Article, PartnerContact, PurchaseOrder, Supplier, SupplierPriceQuote } from "../../lib/types";
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
  // Växelkurs: a SEK order is always 1 (the API refuses anything else); for
  // a foreign supplier an empty field means today's rate, looked up by the
  // API when the order is created — shown here as the placeholder. Only a
  // typed rate is sent.
  const [exchangeRate, setExchangeRate] = useState("");
  // A typed rate belongs to the currency it was typed for.
  const pickSupplier = (next: Supplier | null) => {
    if ((next?.currency ?? "SEK") !== supplierCurrency) setExchangeRate("");
    setSupplier(next);
  };
  const supplierCurrency = supplier?.currency ?? "SEK";
  const foreign = supplierCurrency !== "SEK";
  const rateLookup = useExchangeRateLookup(foreign ? supplierCurrency : null, stockholmToday());
  const [yourReference, setYourReference] = useState("");
  const [ourReference, setOurReference] = useState("");
  // Leverantörens förval: Er referens = the huvudkontakt's name, Frakt på
  // vårt konto = the supplier card's förval. "Manuellt vinner" — a touched
  // field is left alone and sent as typed; an untouched one is not sent, so
  // the server applies the same förval. The reference flag is read when the
  // contact lookup LANDS (the ref), not from the effect's closure.
  const [referenceTouched, setReferenceTouched] = useState(false);
  const referenceTouchedNow = useRef(false);
  const [freightPaidByUs, setFreightPaidByUs] = useState(lockedSupplier?.freightPaidByUsDefault ?? false);
  const [freightTouched, setFreightTouched] = useState(false);
  const contactRequest = useRef(0);
  const supplierId = supplier?.id ?? null;
  const supplierFreightDefault = supplier?.freightPaidByUsDefault ?? false;
  useEffect(() => {
    if (!freightTouched) setFreightPaidByUs(supplierFreightDefault);
  }, [supplierId, supplierFreightDefault, freightTouched]);
  useEffect(() => {
    const request = ++contactRequest.current;
    if (!supplierId) {
      if (!referenceTouchedNow.current) setYourReference("");
      return;
    }
    apiFetch<PartnerContact[]>(`/api/v1/suppliers/${supplierId}/contacts`)
      .catch(() => [] as PartnerContact[])
      .then((contacts) => {
        if (request !== contactRequest.current || referenceTouchedNow.current) return;
        setYourReference((contacts.find((c) => c.isPrimary)?.name ?? "").slice(0, 100));
      });
  }, [supplierId]);
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
          ...(foreign && exchangeRate.trim() ? { exchangeRate: Number(exchangeRate) } : {}),
          // Untouched = omitted: the server fills in the supplier's förval.
          ...(referenceTouched ? { yourReference: yourReference.trim() } : {}),
          ...(freightTouched ? { freightPaidByUs } : {}),
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
            onChange={pickSupplier}
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
            disabled={!foreign}
            placeholder={foreign && rateLookup.status === "ok" ? formatRate(rateLookup.lookup.rate) : undefined}
            value={foreign ? exchangeRate : "1"}
            onChange={(e) => setExchangeRate(e.target.value)}
          />
        </Field>
      </FormRow>
      {foreign && (
        <FormHint attached>
          {rateLookup.status === "error"
            ? `Leverantören fakturerar i ${supplierCurrency} och dagens kurs saknas — ange växelkursen mot SEK.`
            : `Leverantören fakturerar i ${supplierCurrency} — lämnas fältet tomt används dagens kurs.`}
        </FormHint>
      )}

      <FormRow>
        <Field label="Er referens (valfritt)" htmlFor="yourReference">
          <Input
            id="yourReference"
            maxLength={100}
            value={yourReference}
            onChange={(e) => {
              referenceTouchedNow.current = true;
              setReferenceTouched(true);
              setYourReference(e.target.value);
            }}
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

      <FormHint attached>Er referens förifylls med leverantörens huvudkontakt.</FormHint>

      <Field label="Frakt på vårt konto" htmlFor="freightPaidByUs">
        <Toggle
          id="freightPaidByUs"
          checked={freightPaidByUs}
          onChange={(e) => {
            setFreightTouched(true);
            setFreightPaidByUs(e.target.checked);
          }}
        />
      </Field>

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

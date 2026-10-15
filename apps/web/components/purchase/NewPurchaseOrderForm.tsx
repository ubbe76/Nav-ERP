"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import type { PurchaseOrder, Supplier } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";

// Pass `lockedSupplier` (e.g. from the supplier card) to skip the supplier
// picker and create the order for that supplier directly.
export function NewPurchaseOrderForm({
  lockedSupplier,
}: {
  lockedSupplier?: Supplier;
}) {
  const router = useRouter();
  const [supplier, setSupplier] = useState<Supplier | null>(lockedSupplier ?? null);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [note, setNote] = useState("");
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
        }),
      });
      router.push(`/inkop/ordrar/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa inköpsordern");
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
            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
          />
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

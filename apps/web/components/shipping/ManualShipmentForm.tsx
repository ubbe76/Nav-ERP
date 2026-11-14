"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { stockholmToday } from "../../lib/date";
import type { RegisterEntry } from "../../lib/types";

// What POST /shipments/manual and PATCH /shipments/:id/manual take.
export interface ManualShipmentPayload {
  carrierId: string;
  trackingNumber: string | null;
  customerPrice: number | null;
  shippedDate: string;
}

export interface ManualShipmentInitial {
  carrierId: string | null;
  trackingNumber: string | null;
  customerPrice: number | null;
  shippedDate: string | null;
}

// Eget fraktsätt — the form shared by registering one (from a följesedel)
// and Ändra on its card: Speditör (the register), Fraktsedelsnummer,
// Kundpris (the invoice's freight row; blank = none) and Skickad.
export function ManualShipmentForm({
  carriers,
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  carriers: RegisterEntry[];
  initial: ManualShipmentInitial;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (payload: ManualShipmentPayload) => void;
  onCancel: () => void;
}) {
  const [carrierId, setCarrierId] = useState(initial.carrierId ?? "");
  const [trackingNumber, setTrackingNumber] = useState(initial.trackingNumber ?? "");
  const [customerPrice, setCustomerPrice] = useState(initial.customerPrice === null ? "" : String(initial.customerPrice));
  const [shippedDate, setShippedDate] = useState(initial.shippedDate ?? stockholmToday());
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!carrierId) {
      setLocalError("Välj speditör.");
      return;
    }
    const price = customerPrice.trim().replace(",", ".");
    if (price !== "" && !(Number(price) >= 0)) {
      setLocalError("Kundpriset måste vara ett tal, 0 eller större.");
      return;
    }
    onSubmit({
      carrierId,
      trackingNumber: trackingNumber.trim() === "" ? null : trackingNumber.trim(),
      customerPrice: price === "" ? null : Number(price),
      shippedDate,
    });
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{localError ?? error}</FormError>
      <Field label="Speditör" htmlFor="manualCarrier">
        <Select id="manualCarrier" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
          <option value="">— Välj —</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {carriers.length === 0 && (
        <FormHint attached>Registret Speditörer är tomt — lägg till till exempel Egen bil eller Kunden hämtar under Grunddata.</FormHint>
      )}
      <FormRow>
        <Field label="Fraktsedelsnummer" htmlFor="manualTracking">
          <Input id="manualTracking" maxLength={100} value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
        </Field>
        <Field label="Skickad" htmlFor="manualShipped">
          <Input id="manualShipped" type="date" required value={shippedDate} onChange={(e) => setShippedDate(e.target.value)} />
        </Field>
      </FormRow>
      <Field label="Kundpris (kr)" htmlFor="manualPrice">
        <Input
          id="manualPrice"
          type="number"
          min="0"
          step="0.01"
          size="md"
          value={customerPrice}
          onChange={(e) => setCustomerPrice(e.target.value)}
        />
      </Field>
      <FormHint attached>Kundpriset blir en fraktrad på fakturan. Lämna fältet tomt om frakten inte ska faktureras.</FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

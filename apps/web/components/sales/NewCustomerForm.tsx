"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";

// Creates a customer — editing happens on the customer card (/kunder/[id]).
export function NewCustomerForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [customerNumber, setCustomerNumber] = useState("");
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("SE");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/customers", {
        method: "POST",
        body: JSON.stringify({
          name,
          customerNumber: customerNumber.trim() || undefined,
          address: address || undefined,
          postalCode: postalCode || undefined,
          city: city || undefined,
          country: country.trim() || undefined,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa kunden");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {/* Same shape as the card's Allmänt tab: number on its own row, the
          name at full width. Contacts are added on the card's Kontakter tab. */}
      <Field label="Kundnummer" htmlFor="customerNumber">
        <Input
          id="customerNumber"
          size="md"
          maxLength={50}
          placeholder="Automatiskt"
          value={customerNumber}
          onChange={(e) => setCustomerNumber(e.target.value)}
        />
      </Field>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Adress" htmlFor="address">
        <Textarea id="address" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>

      <FormRow columns="postal">
        <Field label="Postnummer" htmlFor="postalCode">
          <Input id="postalCode" size="sm" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        </Field>
        <Field label="Postort" htmlFor="city">
          <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Land" htmlFor="country">
          <Input
            id="country"
            size="xs"
            maxLength={2}
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
          />
        </Field>
      </FormRow>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Skapa kund"}
        </Button>
      </FormActions>
    </Form>
  );
}

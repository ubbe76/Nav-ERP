"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";

// Creates a supplier — editing happens on the supplier card (/leverantorer/[id]).
export function NewSupplierForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [supplierNumber, setSupplierNumber] = useState("");
  const [ourCustomerNumber, setOurCustomerNumber] = useState("");
  const [address, setAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("SE");
  const [currency, setCurrency] = useState("SEK");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name,
          supplierNumber: supplierNumber.trim() || undefined,
          ourCustomerNumber: ourCustomerNumber.trim() || undefined,
          address: address || undefined,
          postalCode: postalCode || undefined,
          city: city || undefined,
          country: country.trim() || undefined,
          currency,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa leverantören");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      {/* Same shape as the card's Allmänt tab: number row, the name at full
          width, then our number at the supplier next to the currency.
          Contacts are added on the card's Kontakter tab. */}
      <Field label="Leverantörsnummer" htmlFor="supplierNumber">
        <Input
          id="supplierNumber"
          size="md"
          maxLength={50}
          placeholder="Automatiskt"
          value={supplierNumber}
          onChange={(e) => setSupplierNumber(e.target.value)}
        />
      </Field>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormRow>
        <Field label="Vårt kundnummer" htmlFor="ourCustomerNumber">
          <Input
            id="ourCustomerNumber"
            size="md"
            maxLength={50}
            placeholder="Hos leverantören"
            value={ourCustomerNumber}
            onChange={(e) => setOurCustomerNumber(e.target.value)}
          />
        </Field>
        <Field label="Valuta" htmlFor="currency">
          <Input
            id="currency"
            size="xs"
            required
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
      </FormRow>

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
          {pending ? "Sparar…" : "Skapa leverantör"}
        </Button>
      </FormActions>
    </Form>
  );
}

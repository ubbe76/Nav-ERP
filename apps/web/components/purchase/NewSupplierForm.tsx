"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import type { SupplierPrefill } from "../../lib/invoiceScan";

type NewSupplierPayment = "" | "bankgiro" | "plusgiro" | "iban";

// Creates a supplier — editing happens on the supplier card (/leverantorer/[id]).
// `initial` prefills the fields (Skapa leverantör on a Fakturainkorg scan, read
// from the query string by the supplier list); the payment details it carries
// are saved with a matching Betalningssätt. onSuccess gets the new supplier's id.
export function NewSupplierForm({
  onSuccess,
  initial = {},
}: {
  onSuccess: (supplierId: string) => void;
  initial?: SupplierPrefill;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [orgNumber, setOrgNumber] = useState(initial.orgNumber ?? "");
  const [vatNumber, setVatNumber] = useState(initial.vatNumber ?? "");
  const [paymentMethod, setPaymentMethod] = useState<NewSupplierPayment>(
    initial.bankgiro ? "bankgiro" : initial.plusgiro ? "plusgiro" : initial.iban ? "iban" : ""
  );
  const [bankgiro, setBankgiro] = useState(initial.bankgiro ?? "");
  const [plusgiro, setPlusgiro] = useState(initial.plusgiro ?? "");
  const [iban, setIban] = useState(initial.iban ?? "");
  const [bic, setBic] = useState(initial.bic ?? "");
  const [supplierNumber, setSupplierNumber] = useState("");
  const [ourCustomerNumber, setOurCustomerNumber] = useState("");
  const [address, setAddress] = useState(initial.address ?? "");
  const [postalCode, setPostalCode] = useState(initial.postalCode ?? "");
  const [city, setCity] = useState(initial.city ?? "");
  const [country, setCountry] = useState((initial.country ?? "SE").trim().toUpperCase().slice(0, 2) || "SE");
  const [currency, setCurrency] = useState("SEK");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<{ id: string }>("/api/v1/suppliers", {
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
          orgNumber: orgNumber.trim() || undefined,
          vatNumber: vatNumber.trim() || undefined,
          ...(paymentMethod === "bankgiro" && bankgiro.trim()
            ? { paymentMethod, bankgiro: bankgiro.trim() }
            : paymentMethod === "plusgiro" && plusgiro.trim()
              ? { paymentMethod, plusgiro: plusgiro.trim() }
              : paymentMethod === "iban" && iban.trim()
                ? { paymentMethod, iban: iban.trim(), bic: bic.trim() || undefined }
                : {}),
        }),
      });
      onSuccess(created.id);
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

      <FormRow>
        <Field label="Organisationsnummer" htmlFor="orgNumber">
          <Input id="orgNumber" size="md" maxLength={20} value={orgNumber} onChange={(e) => setOrgNumber(e.target.value)} />
        </Field>
        <Field label="VAT-nummer" htmlFor="vatNumber">
          <Input id="vatNumber" size="md" maxLength={30} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
        </Field>
      </FormRow>

      <Field label="Betalningssätt" htmlFor="paymentMethod">
        <Select
          id="paymentMethod"
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value as NewSupplierPayment)}
        >
          <option value="">Inget (anges på leverantörskortet)</option>
          <option value="bankgiro">Bankgiro</option>
          <option value="plusgiro">Plusgiro</option>
          <option value="iban">IBAN</option>
        </Select>
      </Field>
      {paymentMethod === "bankgiro" && (
        <Field label="Bankgiro" htmlFor="bankgiro">
          <Input id="bankgiro" size="md" value={bankgiro} onChange={(e) => setBankgiro(e.target.value)} placeholder="5050-1055" />
        </Field>
      )}
      {paymentMethod === "plusgiro" && (
        <Field label="Plusgiro" htmlFor="plusgiro">
          <Input id="plusgiro" size="md" value={plusgiro} onChange={(e) => setPlusgiro(e.target.value)} placeholder="489216-2" />
        </Field>
      )}
      {paymentMethod === "iban" && (
        <FormRow>
          <Field label="IBAN" htmlFor="iban">
            <Input id="iban" value={iban} onChange={(e) => setIban(e.target.value)} />
          </Field>
          <Field label="BIC" htmlFor="bic">
            <Input id="bic" size="md" value={bic} onChange={(e) => setBic(e.target.value)} />
          </Field>
        </FormRow>
      )}
      {paymentMethod === "" && (initial.bankgiro || initial.plusgiro || initial.iban) && (
        <FormHint>Betalningsuppgifterna från fakturan sparas bara om du väljer ett betalningssätt.</FormHint>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Skapa leverantör"}
        </Button>
      </FormActions>
    </Form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { SUPPLIER_PAYMENT_METHODS, SUPPLIER_PAYMENT_METHOD_LABELS, type SupplierPaymentMethod } from "../../lib/banking";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Supplier } from "../../lib/types";

// Bankfiler: how the supplier is paid. All numbers may be stored; the method
// picks the one a payment file uses. The server normalizes and checks the
// check digits (InvalidSupplierPaymentDetailsError → field-specific text).
export function SupplierPaymentDetailsSection({
  supplier,
  onSavedChange,
  saved,
}: {
  supplier: Supplier;
  // The parent keeps "Sparat" outside the keyed form, which remounts when the
  // server's normalized numbers come back through router.refresh().
  onSavedChange: (saved: boolean) => void;
  saved: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<SupplierPaymentMethod | "">(supplier.paymentMethod ?? "");
  const [bankgiro, setBankgiro] = useState(supplier.bankgiro ?? "");
  const [plusgiro, setPlusgiro] = useState(supplier.plusgiro ?? "");
  const [clearing, setClearing] = useState(supplier.bankClearing ?? "");
  const [account, setAccount] = useState(supplier.bankAccountNumber ?? "");
  const [iban, setIban] = useState(supplier.iban ?? "");
  const [bic, setBic] = useState(supplier.bic ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    onSavedChange(false);
    try {
      await apiFetch(`/api/v1/suppliers/${supplier.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          paymentMethod: method || null,
          bankgiro: bankgiro.trim() || null,
          plusgiro: plusgiro.trim() || null,
          bankClearing: clearing.trim() || null,
          bankAccountNumber: account.trim() || null,
          iban: iban.trim() || null,
          bic: bic.trim() || null,
        }),
      });
      onSavedChange(true);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Betalningsuppgifterna kunde inte sparas."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <SectionHeading spaced>Betalning</SectionHeading>
      <Card>
        <Form onSubmit={save}>
          <Field label="Betalningssätt" htmlFor="paymentMethod">
            <Select id="paymentMethod" value={method} onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod | "")}>
              <option value="">Inget (kan inte betalas via betalfil)</option>
              {SUPPLIER_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          {method === "bankgiro" && (
            <Field label="Bankgiro" htmlFor="bankgiro">
              <Input id="bankgiro" value={bankgiro} onChange={(e) => setBankgiro(e.target.value)} placeholder="5050-1055" />
            </Field>
          )}
          {method === "plusgiro" && (
            <Field label="Plusgiro" htmlFor="plusgiro">
              <Input id="plusgiro" value={plusgiro} onChange={(e) => setPlusgiro(e.target.value)} placeholder="489216-2" />
            </Field>
          )}
          {method === "bank_account" && (
            <>
              <FormRow>
                <Field label="Clearingnummer" htmlFor="bankClearing">
                  <Input id="bankClearing" value={clearing} onChange={(e) => setClearing(e.target.value)} placeholder="8327-9" />
                </Field>
                <Field label="Kontonummer" htmlFor="bankAccountNumber">
                  <Input id="bankAccountNumber" value={account} onChange={(e) => setAccount(e.target.value)} />
                </Field>
              </FormRow>
              <FormHint>Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror, t.ex. 8327-9. Övriga banker har 4 siffror.</FormHint>
            </>
          )}
          {method === "iban" && (
            <>
              <FormRow>
                <Field label="IBAN" htmlFor="iban">
                  <Input id="iban" value={iban} onChange={(e) => setIban(e.target.value)} />
                </Field>
                <Field label="BIC" htmlFor="bic">
                  <Input id="bic" value={bic} onChange={(e) => setBic(e.target.value)} />
                </Field>
              </FormRow>
              <FormHint>Bara svenska IBAN (SE…) kan betalas via betalfil. Utlandsbetalningar stöds inte.</FormHint>
            </>
          )}
          {error && <FormError>{error}</FormError>}
          <FormActions>
            <Button type="submit" disabled={pending}>
              Spara betalningsuppgifter
            </Button>
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>
    </>
  );
}

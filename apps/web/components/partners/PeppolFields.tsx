"use client";

import { useState } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormHint, FormRow } from "../ui/Form";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { apiFetch } from "../../lib/api";
import { einvoiceErrorText, type PeppolLookupResult } from "../../lib/einvoice";

// Fakturaleverans + Peppol-id on the customer's Villkor & frakt tab. The
// values are saved by the tab's own PATCH; Kontrollera asks the Peppol
// directory about the id as typed (blank = the one derived from the
// organisation number) without saving anything.
export function PeppolFields({
  customerId,
  invoiceDelivery,
  onInvoiceDeliveryChange,
  peppolId,
  onPeppolIdChange,
}: {
  customerId: string;
  invoiceDelivery: "email" | "peppol";
  onInvoiceDeliveryChange: (value: "email" | "peppol") => void;
  peppolId: string;
  onPeppolIdChange: (value: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ text: string; environment: string | null } | null>(null);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const typed = peppolId.trim();
      const r = await apiFetch<PeppolLookupResult>(`/api/v1/customers/${customerId}/peppol-lookup`, {
        method: "POST",
        body: JSON.stringify(typed ? { peppolId: typed } : {}),
      });
      let text: string;
      if (r.found === true) {
        const types = r.documentTypes.map((t) => t.toLowerCase()).join(" och ");
        text = `Finns i Peppol: ${r.name ?? r.peppolId ?? ""}${types ? ` — tar emot ${types}` : ""}`;
      } else if (r.found === false) {
        text = "Finns inte i Peppol";
      } else {
        text = r.message ?? "Kunde inte avgöra om mottagaren finns i Peppol";
      }
      setResult({ text, environment: r.environment === "sandbox" ? "Sandbox" : null });
    } catch (err) {
      setResult({ text: einvoiceErrorText(err, "Kontrollen misslyckades"), environment: null });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <FormRow>
        <Field label="Fakturaleverans">
          <SegmentedToggle
            ariaLabel="Fakturaleverans"
            value={invoiceDelivery}
            onChange={onInvoiceDeliveryChange}
            options={[
              { value: "email", label: "E-post" },
              { value: "peppol", label: "E-faktura (Peppol)" },
            ]}
          />
        </Field>
        <Field label="Peppol-id" htmlFor="peppolId">
          <Input
            id="peppolId"
            size="md"
            value={peppolId}
            placeholder="0007:5560000000"
            onChange={(e) => onPeppolIdChange(e.target.value)}
          />
        </Field>
      </FormRow>
      <FormHint attached>Tomt = 0007:organisationsnumret</FormHint>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Button type="button" variant="secondary" size="small" disabled={checking} onClick={check}>
          {checking ? "Kontrollerar…" : "Kontrollera"}
        </Button>
        {result && (
          <span role="status">
            {result.text}
            {result.environment && ` (${result.environment})`}
          </span>
        )}
      </div>
    </>
  );
}

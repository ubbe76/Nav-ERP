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

// The countries whose Peppol-id the API derives from the organisation number
// (apps/api/src/modules/einvoice/service/peppol-schemes.ts — the API is the
// rule, this is the hint; ubl-foreign.test.ts compares the two lists).
export const DERIVED_PEPPOL_SCHEMES: Record<string, { scheme: string; what: string; example: string }> = {
  SE: { scheme: "0007", what: "organisationsnumret", example: "0007:5560000000" },
  NO: { scheme: "0192", what: "organisationsnumret", example: "0192:987654325" },
  DK: { scheme: "0184", what: "CVR-numret", example: "0184:12345678" },
  BE: { scheme: "0208", what: "företagsnumret", example: "0208:0412345614" },
};
export function PeppolFields({
  customerId,
  country,
  invoiceDelivery,
  onInvoiceDeliveryChange,
  peppolId,
  onPeppolIdChange,
}: {
  customerId: string;
  // The customer's saved country (ISO alpha-2) — which scheme a blank field means.
  country: string;
  invoiceDelivery: "email" | "peppol";
  onInvoiceDeliveryChange: (value: "email" | "peppol") => void;
  peppolId: string;
  onPeppolIdChange: (value: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const derived = DERIVED_PEPPOL_SCHEMES[(country || "SE").toUpperCase()];
  const [result, setResult] = useState<{ text: string; environment: string | null } | null>(null);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const typed = peppolId.trim();
      const r = await apiFetch<PeppolLookupResult>(`/api/v1/customers/${customerId}/peppol-lookup`, {
        method: "POST",
        // An emptied field asks about the id that will apply once saved —
        // the derived one — never the id still stored.
        body: JSON.stringify({ peppolId: typed || null }),
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
            placeholder={derived?.example ?? "schema:värde"}
            onChange={(e) => onPeppolIdChange(e.target.value)}
          />
        </Field>
      </FormRow>
      <FormHint attached>
        {derived
          ? `Tomt = ${derived.scheme}:${derived.what}`
          : "Ange kundens Peppol-id — i kundens land härleds det inte ur organisationsnumret"}
      </FormHint>
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

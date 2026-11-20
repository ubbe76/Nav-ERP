"use client";

import { Field, Select } from "../ui/Field";
import type { DocumentTermsFields, RegisterEntry } from "../../lib/types";
import { FormRow } from "../ui/Form";
import { HeaderCell } from "./HeaderEditor";

export interface TermsRegisters {
  deliveryTerms: RegisterEntry[];
  paymentTerms: RegisterEntry[];
  carriers: RegisterEntry[];
}

export interface TermsValue {
  deliveryTermId: string;
  paymentTermId: string;
  carrierId: string;
}

// Villkoren (leveransvillkor / betalningsvillkor / speditör) as they appear
// inside the header edit form on the inquiry, purchase order and sales order
// cards. Snapshotted from the partner at creation; saved through the
// document's header PATCH together with the rest of the header.
export function TermsFields({
  registers,
  value,
  onChange,
  cells = false,
}: {
  registers: TermsRegisters;
  value: TermsValue;
  onChange: (next: TermsValue) => void;
  // In the header edited on the card (HeaderEditor): one grid cell each.
  cells?: boolean;
}) {
  const select = (key: keyof TermsValue, label: string, id: string, entries: RegisterEntry[]) => (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>
        <option value="">— Inget —</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </Select>
    </Field>
  );
  const delivery = select("deliveryTermId", "Leveransvillkor", "termsDeliveryTermId", registers.deliveryTerms);
  const payment = select("paymentTermId", "Betalningsvillkor", "termsPaymentTermId", registers.paymentTerms);
  const carrier = select("carrierId", "Speditör", "termsCarrierId", registers.carriers);
  if (cells) {
    return (
      <>
        <HeaderCell>{delivery}</HeaderCell>
        <HeaderCell>{payment}</HeaderCell>
        <HeaderCell>{carrier}</HeaderCell>
      </>
    );
  }
  // In a modal (~496px body): two terms per row is as narrow as names like
  // "Kostnad, försäkring och frakt" tolerate, so the carrier gets a row of
  // its own rather than a squeezed third column.
  return (
    <>
      <FormRow>
        {delivery}
        {payment}
      </FormRow>
      {carrier}
    </>
  );
}

// The three terms as they're initialised from a document, and as the header
// PATCH wants them back ("" = cleared → null).
export function termsFrom(document: DocumentTermsFields): TermsValue {
  return {
    deliveryTermId: document.deliveryTermId ?? "",
    paymentTermId: document.paymentTermId ?? "",
    carrierId: document.carrierId ?? "",
  };
}

export function termsPayload(value: TermsValue) {
  return {
    deliveryTermId: value.deliveryTermId || null,
    paymentTermId: value.paymentTermId || null,
    carrierId: value.carrierId || null,
  };
}

// The term's name ("Fritt fabrik") for the header card's read view — the
// code only stands in when the name is missing, matching the selects above.
export function termsLabel(code?: string | null, name?: string | null): string | null {
  return name || code || null;
}

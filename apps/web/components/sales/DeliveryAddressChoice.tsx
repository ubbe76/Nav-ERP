"use client";

import { Checkbox, Field, Input, Select, Textarea } from "../ui/Field";
import { FormRow } from "../ui/Form";
import type { CustomerDeliveryAddress } from "../../lib/types";

// The order's delivery address: one of the customer's saved addresses, or a
// Ny leveransadress typed in on the order. Without Spara på kunden the new
// address is an engångsadress — it belongs to this order only and is not
// listed among the customer's addresses (the server hides it and deletes it
// when the order switches to another address).

export const NEW_DELIVERY_ADDRESS = "__new";

export interface DeliveryAddressDraft {
  label: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
  saveToCustomer: boolean;
}

export function emptyDeliveryAddressDraft(): DeliveryAddressDraft {
  return { label: "", address: "", postalCode: "", city: "", country: "SE", saveToCustomer: false };
}

// The order's current engångsadress, which the customer's list does not carry.
export interface OneOffDeliveryAddress {
  id: string;
  label: string;
  address: string;
  postalCode: string | null;
  city: string | null;
}

function summary(a: { label: string; address: string; postalCode: string | null; city: string | null }): string {
  return `${a.label} — ${[a.address, [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}`;
}

// The request fields for the choice. `none` is what an empty choice sends:
// undefined on create (no address), null on the header PATCH (clears it).
export function deliveryAddressPayload(
  value: string,
  draft: DeliveryAddressDraft,
  none: null | undefined
): { deliveryAddressId?: string | null; newDeliveryAddress?: Record<string, unknown> } {
  if (value === NEW_DELIVERY_ADDRESS) {
    return {
      newDeliveryAddress: {
        label: draft.label.trim(),
        address: draft.address.trim(),
        postalCode: draft.postalCode.trim() || undefined,
        city: draft.city.trim() || undefined,
        country: draft.country.trim().toUpperCase() || "SE",
        saveToCustomer: draft.saveToCustomer,
      },
    };
  }
  return { deliveryAddressId: value || none };
}

export function DeliveryAddressChoice({
  idPrefix,
  addresses,
  oneOff,
  value,
  onChange,
  draft,
  onDraftChange,
}: {
  idPrefix: string;
  addresses: CustomerDeliveryAddress[];
  oneOff?: OneOffDeliveryAddress | null;
  value: string;
  onChange: (value: string) => void;
  draft: DeliveryAddressDraft;
  onDraftChange: (draft: DeliveryAddressDraft) => void;
}) {
  const isNew = value === NEW_DELIVERY_ADDRESS;
  const set = (patch: Partial<DeliveryAddressDraft>) => onDraftChange({ ...draft, ...patch });

  return (
    <>
      <Field label="Leveransadress" htmlFor={`${idPrefix}DeliveryAddressId`}>
        <Select id={`${idPrefix}DeliveryAddressId`} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Ingen</option>
          {addresses.map((a) => (
            <option key={a.id} value={a.id}>
              {summary(a)}
            </option>
          ))}
          {oneOff && <option value={oneOff.id}>{summary(oneOff)} (bara den här ordern)</option>}
          <option value={NEW_DELIVERY_ADDRESS}>+ Ny leveransadress…</option>
        </Select>
      </Field>

      {isNew && (
        <>
          <Field label="Benämning" htmlFor={`${idPrefix}NewAddressLabel`}>
            <Input
              id={`${idPrefix}NewAddressLabel`}
              required
              maxLength={100}
              placeholder="t.ex. Bygget Solna"
              value={draft.label}
              onChange={(e) => set({ label: e.target.value })}
            />
          </Field>
          <Field label="Adress" htmlFor={`${idPrefix}NewAddressStreet`}>
            <Textarea
              id={`${idPrefix}NewAddressStreet`}
              rows={2}
              required
              value={draft.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </Field>
          <FormRow columns="postal">
            <Field label="Postnummer" htmlFor={`${idPrefix}NewAddressPostalCode`}>
              <Input
                id={`${idPrefix}NewAddressPostalCode`}
                size="sm"
                maxLength={20}
                value={draft.postalCode}
                onChange={(e) => set({ postalCode: e.target.value })}
              />
            </Field>
            <Field label="Postort" htmlFor={`${idPrefix}NewAddressCity`}>
              <Input
                id={`${idPrefix}NewAddressCity`}
                maxLength={100}
                value={draft.city}
                onChange={(e) => set({ city: e.target.value })}
              />
            </Field>
            <Field label="Land" htmlFor={`${idPrefix}NewAddressCountry`}>
              <Input
                id={`${idPrefix}NewAddressCountry`}
                size="xs"
                maxLength={2}
                value={draft.country}
                onChange={(e) => set({ country: e.target.value.toUpperCase() })}
              />
            </Field>
          </FormRow>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Checkbox checked={draft.saveToCustomer} onChange={(e) => set({ saveToCustomer: e.target.checked })} />
            <span>Spara på kunden</span>
          </label>
        </>
      )}
    </>
  );
}

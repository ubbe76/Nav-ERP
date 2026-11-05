"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { askBumpRevision } from "../../lib/revision";
import type {
  Customer,
  CustomerDeliveryAddress,
  PurchaseOrder,
  PurchaseOrderDeliveryAddress,
} from "../../lib/types";

// The order's Leveransadress as shown in the header card: the chosen snapshot
// (name, street lines, postal code + city, country when not Sweden) or the
// fallback text — PDF and pallet card then use the company's godsadress.
export function formatDeliveryAddress(
  address: PurchaseOrderDeliveryAddress | null | undefined,
) {
  if (!address) return <em>Företagets leveransadress</em>;
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(" ");
  const lines = [
    address.name,
    address.address,
    cityLine,
    address.country !== "SE" ? address.country : "",
  ].filter(Boolean);
  return <span style={{ whiteSpace: "pre-line" }}>{lines.join("\n")}</span>;
}

// Ändra Leveransadress: type the fields or fill them from a linked kundorder
// (Hämta från kundorder (KO-…)) or a customer's leveransadresser (Hämta från
// kund…); Använd företagets adress clears the snapshot. Saved with the same
// PATCH + revision question as the other header fields.
export function DeliveryAddressForm({
  order,
  onDone,
  onCancel,
}: {
  order: PurchaseOrder;
  onDone: () => void;
  onCancel: () => void;
}) {
  const current = order.deliveryAddress ?? null;
  const [name, setName] = useState(current?.name ?? "");
  const [address, setAddress] = useState(current?.address ?? "");
  const [postalCode, setPostalCode] = useState(current?.postalCode ?? "");
  const [city, setCity] = useState(current?.city ?? "");
  const [country, setCountry] = useState(current?.country ?? "SE");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerAddresses, setCustomerAddresses] = useState<
    CustomerDeliveryAddress[] | null
  >(null);

  const linked = (order.linkedSalesOrders ?? []).filter(
    (so) => so.deliveryAddress !== null,
  );

  function fill(next: {
    name: string;
    address: string;
    postalCode: string | null;
    city: string | null;
    country: string | null;
  }) {
    setName(next.name);
    setAddress(next.address);
    setPostalCode(next.postalCode ?? "");
    setCity(next.city ?? "");
    setCountry(next.country || "SE");
  }

  async function chooseCustomer(c: Customer | null) {
    setCustomer(c);
    setCustomerAddresses(null);
    if (!c) return;
    try {
      setCustomerAddresses(
        await apiFetch<CustomerDeliveryAddress[]>(
          `/api/v1/customers/${c.id}/delivery-addresses`,
        ),
      );
    } catch (err) {
      setError(
        apiErrorMessage(err, "Kunde inte hämta kundens leveransadresser"),
      );
    }
  }

  async function patch(deliveryAddress: PurchaseOrderDeliveryAddress | null) {
    const bumpRevision = await askBumpRevision(order.revision);
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/purchase-orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({ deliveryAddress, bumpRevision }),
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara leveransadressen"));
    } finally {
      setPending(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void patch({
      name: name.trim(),
      address: address.trim(),
      postalCode: postalCode.trim() || null,
      city: city.trim() || null,
      country: country.trim().toUpperCase() || "SE",
    });
  }

  return (
    <Form onSubmit={save}>
      <FormError>{error}</FormError>
      <FormHint>
        Dit leverantören levererar (legoleverantörens färdiga gods, till exempel
        direkt till kund). Utan egen adress används företagets leveransadress.
      </FormHint>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {linked.map((so) => (
          <Button
            key={so.salesOrderId}
            type="button"
            size="small"
            variant="secondary"
            onClick={() =>
              fill({ name: so.customerName, ...so.deliveryAddress! })
            }
          >
            Hämta från kundorder ({so.orderNumber})
          </Button>
        ))}
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={() => setPickCustomer((v) => !v)}
        >
          Hämta från kund…
        </Button>
        <Button
          type="button"
          size="small"
          variant="secondary"
          disabled={pending || current === null}
          onClick={() => void patch(null)}
        >
          Använd företagets adress
        </Button>
      </div>

      {pickCustomer && (
        <div style={{ display: "grid", gap: 8 }}>
          <Field label="Kund" htmlFor="deliveryAddressCustomer">
            <SearchPicker
              id="deliveryAddressCustomer"
              endpoint="/api/v1/customers"
              value={customer}
              onChange={(c) => void chooseCustomer(c)}
              formatLabel={(c) => `${c.customerNumber} — ${c.name}`}
              placeholder="Sök kundnummer eller namn…"
              emptyText="Inga kunder matchar sökningen"
            />
          </Field>
          {customer && customerAddresses?.length === 0 && (
            <FormHint>Kunden har inga leveransadresser.</FormHint>
          )}
          {customer && customerAddresses && customerAddresses.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {customerAddresses.map((a) => (
                <Button
                  key={a.id}
                  type="button"
                  size="small"
                  variant="ghost"
                  onClick={() => fill({ ...a, name: customer.name })}
                >
                  {a.label} — {a.address}
                  {a.city ? `, ${a.city}` : ""}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <Field label="Namn" htmlFor="deliveryAddressName">
        <Input
          id="deliveryAddressName"
          required
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Adress" htmlFor="deliveryAddressStreet">
        <Textarea
          id="deliveryAddressStreet"
          required
          rows={3}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </Field>
      <FormRow columns="postal">
        <Field label="Postnummer" htmlFor="deliveryAddressPostal">
          <Input
            id="deliveryAddressPostal"
            maxLength={20}
            size="sm"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
          />
        </Field>
        <Field label="Ort" htmlFor="deliveryAddressCity">
          <Input
            id="deliveryAddressCity"
            maxLength={100}
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </Field>
        <Field label="Land" htmlFor="deliveryAddressCountry">
          <Input
            id="deliveryAddressCountry"
            maxLength={2}
            size="xs"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
        </Field>
      </FormRow>

      <FormActions>
        <Button
          type="submit"
          disabled={pending || !name.trim() || !address.trim()}
        >
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

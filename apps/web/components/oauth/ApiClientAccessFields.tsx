"use client";

import { API_CLIENT_PRESETS, API_CLIENT_SCOPE_LABELS, API_CLIENT_SCOPES, type ApiClientScope } from "../../lib/apiClientScopes";
import { Button } from "../ui/Button";
import { Checkbox, Field, Select } from "../ui/Field";
import { FormHint } from "../ui/Form";

export interface ApiClientAccess {
  scopes: ApiClientScope[];
  customerId: string | null;
}

export interface CustomerOption {
  id: string;
  customerNumber: string;
  name: string;
}

// What an API client may do: presets, one checkbox per right and the customer
// it acts for. Shared by Ny API-klient and Ändra.
export function ApiClientAccessFields({
  value,
  customers,
  onChange,
}: {
  value: ApiClientAccess;
  customers: CustomerOption[];
  onChange: (next: ApiClientAccess) => void;
}) {
  const selected = new Set(value.scopes);
  const toggle = (scope: ApiClientScope, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(scope);
    else next.delete(scope);
    onChange({ ...value, scopes: API_CLIENT_SCOPES.filter((s) => next.has(s)) });
  };
  const preset = API_CLIENT_PRESETS.find(
    (p) => p.scopes.length === value.scopes.length && p.scopes.every((s) => selected.has(s))
  );

  return (
    <>
      <Field label="Förval" htmlFor="apiClientPreset">
        <div id="apiClientPreset" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {API_CLIENT_PRESETS.map((p) => (
            <Button
              key={p.key}
              type="button"
              variant={preset?.key === p.key ? "primary" : "secondary"}
              size="small"
              onClick={() => onChange({ scopes: [...p.scopes], customerId: p.needsCustomer ? value.customerId : null })}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </Field>

      <Field label="Rättigheter" htmlFor="apiClientScopes">
        <div id="apiClientScopes" style={{ display: "grid", gap: "var(--space-2)" }}>
          {API_CLIENT_SCOPES.map((scope) => (
            <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 13 }}>
              <Checkbox checked={selected.has(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
              {API_CLIENT_SCOPE_LABELS[scope]}
            </label>
          ))}
        </div>
      </Field>
      {value.scopes.length === 0 && <FormHint attached>Välj minst en rättighet.</FormHint>}

      <Field label="Kund" htmlFor="apiClientCustomer">
        <Select
          id="apiClientCustomer"
          value={value.customerId ?? ""}
          onChange={(e) => onChange({ ...value, customerId: e.target.value || null })}
        >
          <option value="">Ingen — alla kunder</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customerNumber} · {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <FormHint attached>
        {value.customerId
          ? "Klienten får bara skapa offert, fråga pris och bekräfta order för den här kunden."
          : preset?.needsCustomer
            ? "Välj kunden klienten ska agera för."
            : "Utan kund får klienten agera för alla kunder."}
      </FormHint>
    </>
  );
}

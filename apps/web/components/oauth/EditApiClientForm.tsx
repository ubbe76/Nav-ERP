"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ApiClient, Paged } from "../../lib/types";
import { Button } from "../ui/Button";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { ApiClientAccessFields, missingRequiredCustomer, type ApiClientAccess, type CustomerOption } from "./ApiClientAccessFields";

// Ändra on Integrationer: rights and customer of an existing client. Applies
// at once, also to tokens the client already holds.
export function EditApiClientForm({ client, onSuccess }: { client: ApiClient; onSuccess: () => void }) {
  const [access, setAccess] = useState<ApiClientAccess>({ scopes: client.scopes, customerId: client.customerId });
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    apiFetch<Paged<CustomerOption>>("/api/v1/customers?limit=1000")
      .then((page) => setCustomers(page.rows))
      .catch(() => setCustomers([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/api-clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scopes: access.scopes, customerId: access.customerId }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara klienten"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <ApiClientAccessFields value={access} customers={customers} onChange={setAccess} />
      <FormHint attached>Ändringen gäller direkt, även för token klienten redan har hämtat.</FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || access.scopes.length === 0 || missingRequiredCustomer(access)}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}

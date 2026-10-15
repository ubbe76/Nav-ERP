"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { ApiClient } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormNotice, FormStack } from "../ui/Form";

interface CreateApiClientResponse {
  client: ApiClient;
  clientSecret: string;
}

// Unlike the other "Ny X" forms, onSuccess is NOT called right after the
// POST resolves — the secret is only shown once, so the modal must stay
// open until the user explicitly confirms they've copied it via "Klar".
export function NewApiClientForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreateApiClientResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<CreateApiClientResponse>("/api/v1/api-clients", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setCreated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa klienten");
    } finally {
      setPending(false);
    }
  }

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.clientSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Kunde inte kopiera automatiskt — markera och kopiera secreten manuellt.");
    }
  }

  if (created) {
    return (
      <FormStack>
        <strong>{created.client.name} skapad</strong>

        <FormError>{error}</FormError>

        <FormNotice>
          Det här secreten visas bara en gång — det går inte att hämta igen. Kopiera det nu och spara det säkert.
        </FormNotice>

        <Field label="Client ID" htmlFor="clientId">
          <Input id="clientId" readOnly value={created.client.id} style={{ fontFamily: "monospace" }} />
        </Field>

        <Field label="Client secret" htmlFor="clientSecret">
          <Input id="clientSecret" readOnly value={created.clientSecret} style={{ fontFamily: "monospace" }} />
        </Field>

        <FormActions>
          <Button type="button" variant="secondary" onClick={copySecret}>
            {copied ? "Kopierat!" : "Kopiera secret"}
          </Button>
          <Button type="button" variant="primary" onClick={onSuccess}>
            Klar
          </Button>
        </FormActions>

        <FormHint attached>
          Klienten autentiserar genom att posta client-id och client-secret som JSON till{" "}
          <code>/api/v1/oauth/token</code>:
        </FormHint>
        <pre
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-control-sm)",
            padding: 12,
            overflowX: "auto",
          }}
        >
{`POST /api/v1/oauth/token
Content-Type: application/json

{"clientId": "${created.client.id}", "clientSecret": "<secret>"}`}
        </pre>
        <FormHint attached>
          Svaret innehåller en Bearer-token (giltig i 1 timme) som skickas som{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> i efterföljande anrop.
        </FormHint>
      </FormStack>
    );
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa klient"}
        </Button>
      </FormActions>
    </Form>
  );
}

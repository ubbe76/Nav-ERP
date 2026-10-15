"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { Form, FormActions, FormError } from "../ui/Form";

export function NewEmployeeForm({ onSuccess }: { onSuccess: () => void }) {
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [name, setName] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/employees", {
        method: "POST",
        body: JSON.stringify({ employeeNumber, name, active }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa den anställda");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Anställningsnummer" htmlFor="employeeNumber">
        <Input id="employeeNumber" required size="md" value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} />
      </Field>

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Aktiv" htmlFor="active">
        <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa anställd"}
        </Button>
      </FormActions>
    </Form>
  );
}

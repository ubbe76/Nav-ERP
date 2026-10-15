"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import fieldStyles from "../ui/Field.module.css";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";

export function UnlockPeriodForm({ periodId, onDone }: { periodId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/accounting-periods/${periodId}/unlock`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte låsa upp perioden");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>
      <FormHint>Motiveringen sparas i granskningsloggen tillsammans med vem som låste upp perioden.</FormHint>

      <Field label="Motivering" htmlFor="unlockReason">
        <textarea
          id="unlockReason"
          className={fieldStyles.input}
          required
          minLength={5}
          maxLength={255}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="danger" disabled={pending || reason.trim().length < 5}>
          {pending ? "Låser upp…" : "Lås upp period"}
        </Button>
      </FormActions>
    </Form>
  );
}

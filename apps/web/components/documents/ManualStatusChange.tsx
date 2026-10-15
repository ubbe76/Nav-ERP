"use client";

import { confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, Select } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";

// Manual status override (any status → any status), shared by the purchase
// and sales order cards. Bypasses the state machine on purpose
// (Monitor-style) — the API endpoint has no transition guard, never books
// stock and never assigns an invoice number; the user takes responsibility.
// Kept out of the flow-action group and behind a confirm for that reason.
export function ManualStatusChange({
  endpoint,
  statuses,
  current,
  onDone,
}: {
  // e.g. "/api/v1/purchase-orders/<id>" — POSTed to {endpoint}/set-status.
  endpoint: string;
  statuses: Record<string, { label: string }>;
  current: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" size="small" variant="ghost" onClick={() => setOpen(true)}>
        Ändra status manuellt
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Ändra status manuellt">
        <StatusForm
          endpoint={endpoint}
          statuses={statuses}
          current={current}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
          onCancel={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

function StatusForm({
  endpoint,
  statuses,
  current,
  onDone,
  onCancel,
}: {
  endpoint: string;
  statuses: Record<string, { label: string }>;
  current: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (status === current) return;
    const label = statuses[status]?.label ?? status;
    if (
      !(await confirmDialog(
        `Byt status till ${label}? Manuell statusändring hoppar över orderflödets regler och bokför inget lager.`
      ))
    )
      return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`${endpoint}/set-status`, { method: "POST", body: JSON.stringify({ status }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte byta status");
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <FormHint>
        Statusen sätts direkt, utan orderflödets kontroller. Inget lager bokförs och inget fakturanummer delas ut.
      </FormHint>
      <Field label="Status" htmlFor="manualStatus">
        <Select id="manualStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(statuses).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <FormActions>
        <Button type="submit" variant="secondary" disabled={pending || status === current}>
          {pending ? "Byter…" : "Byt status"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

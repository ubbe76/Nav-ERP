"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";

export function BankEntryIgnoreButton({ fileId, direction, entryId, ignored }: { fileId: string; direction: "incoming" | "outgoing"; entryId: string; ignored: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const url = `/api/v1/bank-files/${fileId}/${direction}/entries/${entryId}/ignore`;

  async function send(init: RequestInit) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch(url, init);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades."));
    } finally {
      setPending(false);
    }
  }

  if (ignored) {
    return (
      <>
        <Button size="small" variant="ghost" disabled={pending} onClick={() => send({ method: "DELETE" })}>
          Ångra
        </Button>
        {error && <FormError>{error}</FormError>}
      </>
    );
  }
  return (
    <>
      <Button size="small" variant="ghost" onClick={() => setOpen(true)}>
        Hanterad utanför Nav
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Hanterad utanför Nav">
        <Form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (reason.trim()) send({ method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
          }}
        >
          <Field label="Orsak" htmlFor="ignoreReason">
            <Input id="ignoreReason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="t.ex. överföring mellan egna konton" />
          </Field>
          {error && <FormError>{error}</FormError>}
          <FormActions>
            <Button type="submit" disabled={!reason.trim() || pending}>Spara</Button>
          </FormActions>
        </Form>
      </Modal>
    </>
  );
}

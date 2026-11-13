"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Paged, StockBatchListRow } from "../../lib/types";

// Lager → Spårbarhet: rätta en batch — Utgångsdatum, Batchdatum och
// Batchnummer (PATCH /stock/batches/:id; empty date = cleared). The batch
// date is not on the trace, so the dialog reads it from the batch list.
export function BatchEditDialog({
  open,
  onClose,
  batchId,
  batchNumber,
  expiresOn,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
  expiresOn: string | null;
}) {
  const router = useRouter();
  const [number, setNumber] = useState(batchNumber);
  const [expires, setExpires] = useState(expiresOn ?? "");
  const [batchDate, setBatchDate] = useState("");
  const [originalBatchDate, setOriginalBatchDate] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNumber(batchNumber);
    setExpires(expiresOn ?? "");
    setError(null);
    setLoaded(false);
    let cancelled = false;
    apiFetch<Paged<StockBatchListRow>>(`/api/v1/stock/batches?search=${encodeURIComponent(batchNumber)}&limit=100`)
      .then((r) => {
        if (cancelled) return;
        const d = r.rows.find((x) => x.id === batchId)?.batchDate ?? "";
        setBatchDate(d);
        setOriginalBatchDate(d);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, batchId, batchNumber, expiresOn]);

  async function save() {
    setError(null);
    const trimmed = number.trim();
    if (trimmed === "") {
      setError("Batchnumret får inte vara tomt");
      return;
    }
    const body: { expiresOn?: string | null; batchDate?: string | null; batchNumber?: string } = {};
    if (expires !== (expiresOn ?? "")) body.expiresOn = expires === "" ? null : expires;
    if (batchDate !== originalBatchDate) body.batchDate = batchDate === "" ? null : batchDate;
    if (trimmed !== batchNumber) body.batchNumber = trimmed;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock/batches/${batchId}`, { method: "PATCH", body: JSON.stringify(body) });
      onClose();
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ändra batchen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Ändra batch ${batchNumber}`}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Utgångsdatum" htmlFor="batchEditExpires">
          <Input id="batchEditExpires" type="date" size="sm" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label="Batchdatum" htmlFor="batchEditDate">
          <Input
            id="batchEditDate"
            type="date"
            size="sm"
            value={batchDate}
            disabled={!loaded}
            onChange={(e) => setBatchDate(e.target.value)}
          />
        </Field>
        <FormHint attached>Tomt batchdatum betyder dagen batchen skapades. Tomt utgångsdatum tar bort datumet.</FormHint>
        <Field label="Batchnummer" htmlFor="batchEditNumber">
          <Input id="batchEditNumber" size="sm" value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        <FormActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !loaded}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

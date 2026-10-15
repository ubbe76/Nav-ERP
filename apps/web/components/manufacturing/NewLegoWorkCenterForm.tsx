"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import type { Supplier, WorkCenter } from "../../lib/types";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { findCodeClash, WorkCenterCodeField, WorkCenterCodeHint } from "./WorkCenterCodeField";

// Creates a legoresurs (work center of type "subcontract"), or edits one
// when `workCenter` is passed. Shares the 3-digit code series with the
// ordinary resources; production group/hourly rate/schedule do not apply.
export function NewLegoWorkCenterForm({
  workCenter,
  allWorkCenters,
  suppliers,
  onSuccess,
}: {
  workCenter?: WorkCenter;
  // Every work center regardless of type — the code series is shared, so the
  // number hint has to show machines and personnel too.
  allWorkCenters: WorkCenter[];
  suppliers: Supplier[];
  onSuccess: () => void;
}) {
  const [code, setCode] = useState(workCenter?.code ?? "");
  const [name, setName] = useState(workCenter?.name ?? "");
  const [supplierId, setSupplierId] = useState(workCenter?.supplierId ?? "");
  const [active, setActive] = useState(workCenter?.active ?? true);
  // Monitor G5 import fields (Produktionsgruppslista Lego) — manually
  // editable too, not just importable.
  const [leadTimeDays, setLeadTimeDays] = useState(
    workCenter?.leadTimeDays != null ? String(Number(workCenter.leadTimeDays)) : ""
  );
  const [queueTimeDays, setQueueTimeDays] = useState(
    workCenter?.queueTimeDays != null ? String(Number(workCenter.queueTimeDays)) : ""
  );
  const [orderLeadTimeDays, setOrderLeadTimeDays] = useState(
    workCenter?.orderLeadTimeDays != null ? String(Number(workCenter.orderLeadTimeDays)) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Active suppliers, plus whichever one is currently selected even if it's
  // since been deactivated — same rationale as the week-schedule select on
  // the ordinary resource form.
  const selectableSuppliers = suppliers.filter((s) => s.active || s.id === supplierId);
  // Caught here rather than as the server's 409 after submit.
  const codeClash = findCodeClash(allWorkCenters, code, workCenter?.id);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const payload = {
        code,
        name,
        type: "subcontract" as const,
        supplierId: supplierId === "" ? null : supplierId,
        active,
        leadTimeDays: leadTimeDays.trim() === "" ? null : Number(leadTimeDays),
        queueTimeDays: queueTimeDays.trim() === "" ? null : Number(queueTimeDays),
        orderLeadTimeDays: orderLeadTimeDays.trim() === "" ? null : Number(orderLeadTimeDays),
      };
      if (workCenter) {
        await apiFetch(`/api/v1/work-centers/${workCenter.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/work-centers", { method: "POST", body: JSON.stringify(payload) });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara legoresursen");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <WorkCenterCodeField value={code} onChange={setCode} clash={codeClash} />
        <Field label="Aktiv" htmlFor="active">
          <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </Field>
      </FormRow>
      <WorkCenterCodeHint existing={allWorkCenters} clash={codeClash} />

      <Field label="Namn" htmlFor="name">
        <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Standardleverantör" htmlFor="supplierId">
        <Select id="supplierId" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">— Ingen —</option>
          {selectableSuppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
              {!supplier.active ? " (inaktiv)" : ""}
            </option>
          ))}
        </Select>
      </Field>
      <FormHint attached>
        Förifylls som leverantör när resursen väljs på en operation i beredningen — kan ändras per operation.
      </FormHint>

      <FormRow>
        <Field label="Ledtid (dagar)" htmlFor="leadTimeDays">
          <Input
            id="leadTimeDays"
            type="number"
            min="0"
            step="any"
            size="sm"
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
          />
        </Field>
        <Field label="Kötid (dagar)" htmlFor="queueTimeDays">
          <Input
            id="queueTimeDays"
            type="number"
            min="0"
            step="any"
            size="sm"
            value={queueTimeDays}
            onChange={(e) => setQueueTimeDays(e.target.value)}
          />
        </Field>
      </FormRow>

      <Field label="Ledtid beställning (dagar)" htmlFor="orderLeadTimeDays">
        <Input
          id="orderLeadTimeDays"
          type="number"
          min="0"
          step="any"
          size="sm"
          value={orderLeadTimeDays}
          onChange={(e) => setOrderLeadTimeDays(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || codeClash !== null}>
          {pending ? "Sparar…" : workCenter ? "Spara legoresurs" : "Skapa legoresurs"}
        </Button>
      </FormActions>
    </Form>
  );
}

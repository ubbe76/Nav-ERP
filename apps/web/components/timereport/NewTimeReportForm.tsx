"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { stockholmToday } from "../../lib/date";
import type { EmployeeDirectoryEntry, ManufacturingOrder, MOOperation } from "../../lib/types";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";
import { useCanOpenPersonal } from "../PermissionsProvider";

function today() {
  return stockholmToday();
}

// Only released (or further) orders have snapshotted mo_operations to report
// time against — "planned" orders don't yet, so the picker excludes them.
const REPORTABLE_MO_STATUSES = "released,in_progress,done,closed";

export function NewTimeReportForm({
  employees,
  onSuccess,
}: {
  employees: EmployeeDirectoryEntry[];
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [order, setOrder] = useState<ManufacturingOrder | null>(null);
  const [operations, setOperations] = useState<MOOperation[]>([]);
  const [operationId, setOperationId] = useState("");
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canOpenPersonal = useCanOpenPersonal();

  if (employees.length === 0) {
    return (
      <div>
        <p>
          Det finns inga anställda än.{" "}
          {canOpenPersonal
            ? "Skapa en anställd innan du kan skapa en tidrapport."
            : "Be en administratör eller arbetsledare att lägga upp personal."}
        </p>
        {canOpenPersonal && (
          <FormActions>
            <Link href="/personal/anstallda">
              <Button type="button" variant="primary">
                Till anställda
              </Button>
            </Link>
          </FormActions>
        )}
      </div>
    );
  }

  async function handleOrderChange(next: ManufacturingOrder | null) {
    setOrder(next);
    setOperationId("");
    if (!next) {
      setOperations([]);
      return;
    }
    setOperationsLoading(true);
    try {
      const ops = await apiFetch<MOOperation[]>(`/api/v1/manufacturing-orders/${next.id}/operations`);
      setOperations(ops);
      setOperationId(ops[0]?.id ?? "");
    } finally {
      setOperationsLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/time-reports", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          moOperationId: operationId,
          date,
          hours: Number(hours),
          note: note || undefined,
        }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa tidrapporten");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Anställd" htmlFor="employeeId">
        <Select id="employeeId" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.employeeNumber} — {emp.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Tillverkningsorder" htmlFor="manufacturingOrderId">
        <SearchPicker
          id="manufacturingOrderId"
          endpoint={`/api/v1/manufacturing-orders?status=${REPORTABLE_MO_STATUSES}`}
          value={order}
          onChange={handleOrderChange}
          formatLabel={(o) => `${o.orderNumber} — ${o.articleNumber}`}
          placeholder="Sök ordernummer eller artikel…"
          emptyText="Inga tillverkningsordrar matchar sökningen"
        />
      </Field>

      <Field label="Operation" htmlFor="operationId">
        <Select id="operationId" value={operationId} onChange={(e) => setOperationId(e.target.value)} disabled={operationsLoading || operations.length === 0}>
          {operations.length === 0 ? (
            <option value="">{order ? "Inga operationer på denna order" : "Välj tillverkningsorder först"}</option>
          ) : (
            operations.map((op) => (
              <option key={op.id} value={op.id}>
                {op.sequenceNo} — {op.workCenterName}
              </option>
            ))
          )}
        </Select>
      </Field>

      <FormRow>
        <Field label="Datum" htmlFor="date">
          <Input id="date" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Timmar" htmlFor="hours">
          <Input id="hours" type="number" min="0.01" step="0.01" required size="sm" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </FormRow>

      <Field label="Anteckning (valfritt)" htmlFor="note">
        <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || !operationId}>
          {pending ? "Skapar…" : "Skapa tidrapport"}
        </Button>
      </FormActions>
    </Form>
  );
}

"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { stockholmToday } from "../../lib/date";
import { defaultReportKind } from "../../lib/moSuggestions";
import type { TimeKind, EmployeeDirectoryEntry, ManufacturingOrder, MOOperation } from "../../lib/types";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";
import { useCanOpenPersonal } from "../PermissionsProvider";
import { apiErrorMessage } from "../../lib/errorMessages";

function today() {
  return stockholmToday();
}

// Only released (or further) orders have snapshotted mo_operations to report
// time against — "planned" orders don't yet, and the API refuses Stängd.
const REPORTABLE_MO_STATUSES = "released,in_progress,done";

export function NewTimeReportForm({
  employees,
  timeKindSplit = false,
  onSuccess,
}: {
  employees: EmployeeDirectoryEntry[];
  timeKindSplit?: boolean;
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [order, setOrder] = useState<ManufacturingOrder | null>(null);
  const [operations, setOperations] = useState<MOOperation[]>([]);
  const [operationId, setOperationId] = useState("");
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState("1");
  // Typ: förval Produktion with Dela tid i ställ och produktion on.
  const [kind, setKind] = useState<TimeKind | "">(defaultReportKind(timeKindSplit));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canOpenPersonal = useCanOpenPersonal();
  const opsSeq = useRef(0);
  const activeEmployees = employees.filter((emp) => emp.active);

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
    // A late answer for a previously picked order must not overwrite the list.
    const seq = ++opsSeq.current;
    setOrder(next);
    setOperationId("");
    setOperations([]);
    if (!next) {
      setOperationsLoading(false);
      return;
    }
    setOperationsLoading(true);
    try {
      const ops = await apiFetch<MOOperation[]>(`/api/v1/manufacturing-orders/${next.id}/operations`);
      if (seq !== opsSeq.current) return;
      setOperations(ops);
      setOperationId(ops[0]?.id ?? "");
    } catch (err) {
      if (seq !== opsSeq.current) return;
      setError(apiErrorMessage(err, "Kunde inte hämta operationerna"));
    } finally {
      if (seq === opsSeq.current) setOperationsLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (employeeId === "") {
      setError("Välj anställd");
      return;
    }
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
          ...(timeKindSplit && kind ? { kind } : {}),
        }),
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa tidrapporten"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Anställd" htmlFor="employeeId">
        <Select id="employeeId" required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Välj anställd…</option>
          {activeEmployees.map((emp) => (
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
          <Input id="hours" type="number" min="0" step="any" required size="sm" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </FormRow>

      {timeKindSplit && (
        <Field label="Typ" htmlFor="kind">
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as TimeKind | "")}>
            <option value="">Ej uppdelad</option>
            <option value="setup">Ställ</option>
            <option value="run">Produktion</option>
          </Select>
        </Field>
      )}

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

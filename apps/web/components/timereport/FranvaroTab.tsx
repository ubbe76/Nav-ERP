"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Absence, AbsenceType, ResolvedCalendarDay, UserRole } from "../../lib/types";
import { formatHours } from "./SchedulesPageClient";
import styles from "./EmployeeTabs.module.css";

interface FranvaroTabProps {
  employeeId: string;
  absenceTypes: AbsenceType[];
  initialAbsences: Absence[];
  userRole: UserRole;
}

// Converts net minutes (from a resolved day schedule) to a comma-decimal
// hours string for the Timmar field — the reverse of addAbsence's
// `.replace(",", ".")` parse below.
function minutesToHoursInput(minutes: number): string {
  return (minutes / 60).toLocaleString("sv-SE", { maximumFractionDigits: 2 });
}

// DuplicateAbsenceError/PayrollPeriodLockedError are mapped to Swedish copy
// by the shared error-code dictionary.
function absenceErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

export function FranvaroTab({ employeeId, absenceTypes, initialAbsences: absences, userRole }: FranvaroTabProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [absenceTypeId, setAbsenceTypeId] = useState("");
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE"));
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");

  const canManage = userRole !== "user";

  async function fetchFromSchedule() {
    setError(null);
    if (date === "") {
      setError("Välj ett datum först");
      return;
    }
    try {
      const days = await apiFetch<ResolvedCalendarDay[]>(
        `/api/v1/employees/${employeeId}/schedule-calendar?from=${date}&to=${date}`
      );
      const day = days[0];
      if (!day?.daySchedule) {
        setError("Ingen schemalagd tid på valt datum");
        return;
      }
      setHours(minutesToHoursInput(day.daySchedule.netMinutes));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta schemat");
    }
  }

  async function addAbsence(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (absenceTypeId === "") {
      setError("Välj en frånvarokod");
      return;
    }
    const parsedHours = Number(hours.replace(",", "."));
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Ange antal timmar (t.ex. 8 eller 4,5)");
      return;
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employeeId}/absences`, {
        method: "POST",
        body: JSON.stringify({
          absenceTypeId,
          date,
          minutes: Math.round(parsedHours * 60),
          note: note.trim() === "" ? undefined : note.trim(),
        }),
      });
      setAbsenceTypeId("");
      setDate(new Date().toLocaleDateString("sv-SE"));
      setHours("");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(absenceErrorMessage(err, "Kunde inte registrera frånvaron"));
    } finally {
      setPending(false);
    }
  }

  async function deleteAbsence(id: string) {
    setError(null);
    try {
      await apiFetch(`/api/v1/absences/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(absenceErrorMessage(err, "Kunde inte ta bort frånvaron"));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FormError>{error}</FormError>

      {canManage ? (
        <Card>
          <Form onSubmit={addAbsence}>
            <strong>Registrera frånvaro</strong>
            <FormRow>
              <Field label="Frånvarokod" htmlFor="absenceTypeId">
                <Select
                  id="absenceTypeId"
                  required
                  value={absenceTypeId}
                  onChange={(e) => setAbsenceTypeId(e.target.value)}
                >
                  <option value="">Välj kod…</option>
                  {absenceTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code} — {type.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Datum" htmlFor="absenceDate">
                <Input id="absenceDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </FormRow>
            <FormRow>
              <Field label="Timmar" htmlFor="absenceHours">
                <Input
                  id="absenceHours"
                  required
                  placeholder="t.ex. 8 eller 4,5"
                  size="sm"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </Field>
              <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}>
                <Button type="button" variant="ghost" onClick={fetchFromSchedule}>
                  Hämta ur schema
                </Button>
              </div>
            </FormRow>
            <Field label="Anteckning" htmlFor="absenceNote">
              <Input id="absenceNote" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <FormActions>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? "Registrerar…" : "Registrera"}
              </Button>
            </FormActions>
          </Form>
        </Card>
      ) : (
        <Card>
          <FormHint>Endast arbetsledare och administratörer kan registrera frånvaro.</FormHint>
        </Card>
      )}

      <Card>
        <strong>Registrerad frånvaro</strong>
        {absences.length === 0 ? (
          <FormHint>Ingen frånvaro registrerad de senaste tre månaderna.</FormHint>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {absences.map((a) => (
              <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    <span className="num">{a.date}</span> · {a.absenceTypeName} ·{" "}
                    <span className="num">{formatHours(a.minutes)}</span>
                  </span>
                  {canManage && (
                    <Button type="button" variant="ghost" onClick={() => deleteAbsence(a.id)}>
                      Ta bort
                    </Button>
                  )}
                </div>
                {a.note && <span className={styles.inlineNote}>{a.note}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { DurationInput } from "../ui/DurationInput";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { GatedLink } from "../ui/GatedLink";
import type { Absence, AbsenceType, ResolvedCalendarDay, StampSession, UserRole } from "../../lib/types";
import { formatHours } from "./SchedulesPageClient";
import styles from "./EmployeeTabs.module.css";
import { stockholmToday } from "../../lib/date";
import { formatDuration, readAbsenceMinutes } from "../../lib/duration";

interface FranvaroTabProps {
  employeeId: string;
  employeeName: string;
  absenceTypes: AbsenceType[];
  initialAbsences: Absence[];
  userRole: UserRole;
}

// DuplicateAbsenceError/PayrollPeriodLockedError are mapped to Swedish copy
// by the shared error-code dictionary.
function absenceErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

export function FranvaroTab({ employeeId, employeeName, absenceTypes, initialAbsences: absences, userRole }: FranvaroTabProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [absenceTypeId, setAbsenceTypeId] = useState("");
  const [date, setDate] = useState(stockholmToday());
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  // Ändra frånvaro (2026-11-22): the row being changed fills the form above.
  const [editing, setEditing] = useState<Absence | null>(null);

  function startEdit(a: Absence) {
    setError(null);
    setEditing(a);
    setAbsenceTypeId(a.absenceTypeId);
    setDate(a.date);
    setHours(formatDuration(a.minutes));
    setNote(a.note ?? "");
  }

  function resetForm() {
    setEditing(null);
    setAbsenceTypeId("");
    setDate(stockholmToday());
    setHours("");
    setNote("");
  }

  const [openStamps, setOpenStamps] = useState<StampSession[]>([]);
  useEffect(() => {
    apiFetch<StampSession[]>(`/api/v1/stamp-sessions?open=true&employeeId=${employeeId}`)
      .then(setOpenStamps)
      .catch(() => setOpenStamps([]));
  }, [employeeId]);
  const pausedCount = openStamps.filter((s) => s.pausedAt !== null).length;

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
      setHours(formatDuration(day.daySchedule.netMinutes));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta schemat"));
    }
  }

  async function addAbsence(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (absenceTypeId === "") {
      setError("Välj en frånvarokod");
      return;
    }
    // Tid is tt:mm (lib/duration.ts); the API keeps minutes.
    const minutes = readAbsenceMinutes(hours);
    if (typeof minutes === "string") {
      setError(minutes);
      return;
    }
    setPending(true);
    try {
      if (editing) {
        // Only what changed.
        const body: Record<string, unknown> = {};
        if (absenceTypeId !== editing.absenceTypeId) body.absenceTypeId = absenceTypeId;
        if (date !== editing.date) body.date = date;
        if (minutes !== editing.minutes) body.minutes = minutes;
        if (note.trim() !== (editing.note ?? "")) body.note = note.trim() || null;
        if (Object.keys(body).length > 0) {
          await apiFetch(`/api/v1/absences/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        }
      } else {
        await apiFetch(`/api/v1/employees/${employeeId}/absences`, {
          method: "POST",
          body: JSON.stringify({
            absenceTypeId,
            date,
            minutes,
            note: note.trim() === "" ? undefined : note.trim(),
          }),
        });
      }
      resetForm();
      router.refresh();
    } catch (err) {
      setError(absenceErrorMessage(err, editing ? "Kunde inte ändra frånvaron" : "Kunde inte registrera frånvaron"));
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

      {openStamps.length > 0 && (
        <Card>
          <FormHint>
            {employeeName} har {openStamps.length === 1 ? "1 öppet arbete" : `${openStamps.length} öppna arbeten`}
            {pausedCount > 0 && ` (${pausedCount} ${pausedCount === 1 ? "pausat" : "pausade"})`}.{" "}
            <GatedLink href="/tillverkning/pagaende">Pågående arbete</GatedLink>
          </FormHint>
        </Card>
      )}

      {canManage ? (
        <Card>
          <Form onSubmit={addAbsence}>
            <strong>{editing ? "Ändra frånvaro" : "Registrera frånvaro"}</strong>
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
              <Field label="Tid (tt:mm)" htmlFor="absenceHours">
                <DurationInput id="absenceHours" required placeholder="t.ex. 8:00" size="sm" value={hours} onValueChange={setHours} />
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
              {editing && (
                <Button type="button" variant="ghost" onClick={resetForm}>
                  Avbryt
                </Button>
              )}
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? "Sparar…" : editing ? "Spara ändringen" : "Registrera"}
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
          <FormHint>Ingen frånvaro registrerad från tre månader bakåt till tolv månader framåt.</FormHint>
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
                    <span>
                      <Button type="button" variant="ghost" onClick={() => startEdit(a)}>
                        Ändra
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => deleteAbsence(a.id)}>
                        Ta bort
                      </Button>
                    </span>
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

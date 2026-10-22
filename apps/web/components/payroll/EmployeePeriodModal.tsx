"use client";

import { confirmDelete } from "../../lib/confirm";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { toDateTimeLocalValue } from "../../lib/date";
import {
  MONTH_NAMES_SV,
  OVERTIME_COMPENSATION_LABELS,
  type AbsenceType,
  type AttendanceDeviationReason,
  type DayComputation,
  type EmployeePeriodDays,
  type OvertimeCompensation,
  type PeriodAbsenceRow,
  type PeriodAttendanceSession,
  type PeriodEmployeeSummary,
} from "../../lib/types";
import { formatHours } from "../timereport/SchedulesPageClient";

function toClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function weekdayShort(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("sv-SE", { weekday: "short" });
}

// Minutes → comma-decimal hours for the Timmar field (same as the
// personalkort's Frånvaro form).
function minutesToHoursInput(minutes: number): string {
  return (minutes / 60).toLocaleString("sv-SE", { maximumFractionDigits: 2 });
}

// A day is rendered when it carries any value at all — all-zero days (weekends
// without work) are skipped to keep the list compact.
function dayHasContent(day: DayComputation, sessions: number, absences: number): boolean {
  return (
    day.scheduledMinutes > 0 ||
    day.workedMinutes > 0 ||
    day.atfMinutes > 0 ||
    day.overtimeMinutes > 0 ||
    day.overtimeOffScheduleMinutes > 0 ||
    day.unaccountedMinutes > 0 ||
    day.absences.length > 0 ||
    day.ob.length > 0 ||
    sessions > 0 ||
    absences > 0
  );
}

// The correction endpoints' conflicts (InvalidAttendanceInterval/
// AlreadyPresent/DuplicateAbsence/PayrollPeriodLocked) are mapped to Swedish
// copy by the shared error-code dictionary.
function correctionErrorMessage(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

// Fluid columns (min widths for readability, fr for the rest) instead of a
// fixed 520px+gap total — that overflowed the modal body (≈496px usable).
// Header row and data rows share this constant, so they stay aligned however
// it's tuned.
const HOUR_COLUMNS = "minmax(60px,1.4fr) minmax(44px,1fr) minmax(44px,1fr) minmax(44px,1fr) minmax(40px,1fr) minmax(48px,1.1fr)";

const headerCellStyle = { fontSize: 12, color: "var(--color-text-secondary)" } as const;
const mutedStyle = { fontSize: 12, color: "var(--color-text-secondary)" } as const;

// Dagvy per medarbetare — the day-by-day basis behind the period summary, with
// the corrections a supervisor needs before attesting: edit/remove attendance
// sessions and register absence for unaccounted time.
export function EmployeePeriodModal({
  employee,
  year,
  month,
  periodLocked,
  onClose,
}: {
  employee: PeriodEmployeeSummary | null;
  year: number;
  month: number;
  periodLocked: boolean;
  onClose: () => void;
}) {
  const monthName = MONTH_NAMES_SV[month - 1]!;
  return (
    <Modal
      open={employee !== null}
      onClose={onClose}
      title={employee ? `${employee.name} · ${monthName} ${year}` : ""}
    >
      {employee && (
        <PeriodDetail
          key={employee.employeeId}
          employeeId={employee.employeeId}
          year={year}
          month={month}
          periodLocked={periodLocked}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

// "Kom 07:12 (12 min sent) — Trafik/resa: kö på E4" / "Gick 15:20 (40 min
// tidigt) — Läkar-/tandläkarbesök". The server says which stamp the day's
// minutes were measured on (the first/last session overlapping the
// schedule); a reason is shown wherever it is stored, even without minutes.
function sessionDeviationLines(
  session: PeriodAttendanceSession,
  day: DayComputation,
  daySessions: PeriodAttendanceSession[]
) {
  const reasonText = (reason: { name: string } | null, note: string | null) => {
    const parts = [reason?.name, note].filter((part): part is string => !!part);
    return parts.length === 0 ? "" : ` — ${reason && note ? `${reason.name}: ${note}` : parts[0]}`;
  };
  const lines: { key: string; text: string }[] = [];
  // Older API responses lack the per-session minutes: first/last of the day.
  const isFirst = daySessions[0]?.id === session.id;
  const isLast = daySessions[daySessions.length - 1]?.id === session.id;
  const late = session.lateMinutes ?? (isFirst ? (day.lateMinutes ?? 0) : 0);
  const early = session.stoppedAt ? (session.earlyLeaveMinutes ?? (isLast ? (day.earlyLeaveMinutes ?? 0) : 0)) : 0;
  if (late > 0 || session.startReason || session.startNote) {
    lines.push({
      key: "start",
      text: `Kom ${toClock(session.startedAt)}${late > 0 ? ` (${late} min sent)` : ""}${reasonText(session.startReason, session.startNote)}`,
    });
  }
  if (session.stoppedAt && (early > 0 || session.stopReason || session.stopNote)) {
    lines.push({
      key: "stop",
      text: `Gick ${toClock(session.stoppedAt)}${early > 0 ? ` (${early} min tidigt)` : ""}${reasonText(session.stopReason, session.stopNote)}`,
    });
  }
  return lines;
}

function PeriodDetail({
  employeeId,
  year,
  month,
  periodLocked,
  onClose,
}: {
  employeeId: string;
  year: number;
  month: number;
  periodLocked: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<EmployeePeriodDays | null>(null);
  const [absenceTypes, setAbsenceTypes] = useState<AbsenceType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The session being corrected. The `initial*` values are the same strings
  // the inputs were opened with, so saveSession can send only what actually
  // changed (and tell "cleared the Sluttid" apart from "never had one").
  const [editing, setEditing] = useState<{
    id: string;
    startedAt: string;
    stoppedAt: string;
    initialStartedAt: string;
    initialStoppedAt: string;
    // Avvikelseorsaker on the stamps ("" = ingen).
    startReasonId: string;
    startNote: string;
    stopReasonId: string;
    stopNote: string;
    initialStartReasonId: string;
    initialStartNote: string;
    initialStopReasonId: string;
    initialStopNote: string;
  } | null>(null);
  const [reasons, setReasons] = useState<AttendanceDeviationReason[]>([]);

  // Quick-add frånvaro (open period only) — prefilled from the first day with
  // unaccounted time on every (re)load.
  const [absenceTypeId, setAbsenceTypeId] = useState("");
  const [absenceDate, setAbsenceDate] = useState("");
  const [absenceHours, setAbsenceHours] = useState("");
  const [absenceNote, setAbsenceNote] = useState("");

  const load = useCallback(async () => {
    const [detail, types, reasonList] = await Promise.all([
      apiFetch<EmployeePeriodDays>(`/api/v1/periods/${year}/${month}/employees/${employeeId}/days`),
      periodLocked ? Promise.resolve<AbsenceType[]>([]) : apiFetch<AbsenceType[]>("/api/v1/absence-types"),
      periodLocked
        ? Promise.resolve<AttendanceDeviationReason[]>([])
        : apiFetch<AttendanceDeviationReason[]>("/api/v1/attendance-deviation-reasons?includeInactive=true"),
    ]);
    setData(detail);
    setAbsenceTypes(types);
    setReasons(reasonList);
    setEditing(null);
    const firstUnaccounted = detail.days.find((day) => day.unaccountedMinutes > 0);
    setAbsenceDate(firstUnaccounted?.date ?? detail.days[0]?.date ?? "");
    setAbsenceHours(firstUnaccounted ? minutesToHoursInput(firstUnaccounted.unaccountedMinutes) : "");
    setAbsenceNote("");
  }, [employeeId, year, month, periodLocked]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Kunde inte hämta dagvyn"));
  }, [load]);

  // Every mutation reloads the modal's own data and the server-rendered
  // summary behind it, so neither can show a stale number.
  async function afterMutation() {
    // (notice is cleared by each mutation before it runs)
    await load();
    router.refresh();
  }

  const sessionsByDate = useMemo(() => {
    const map = new Map<string, PeriodAttendanceSession[]>();
    for (const session of data?.sessions ?? []) {
      const list = map.get(session.date) ?? [];
      list.push(session);
      map.set(session.date, list);
    }
    return map;
  }, [data]);

  const absencesByDate = useMemo(() => {
    const map = new Map<string, PeriodAbsenceRow[]>();
    for (const absence of data?.absences ?? []) {
      const list = map.get(absence.date) ?? [];
      list.push(absence);
      map.set(absence.date, list);
    }
    return map;
  }, [data]);

  async function saveSession() {
    if (!editing) return;
    setError(null);
    setNotice(null);

    // Only changed fields are sent: the inputs are minute-resolution, so
    // resending an untouched startedAt would silently truncate the stored
    // seconds.
    const body: {
      startedAt?: string;
      stoppedAt?: string | null;
      startReasonId?: string | null;
      startNote?: string | null;
      stopReasonId?: string | null;
      stopNote?: string | null;
    } = {};

    if (editing.startReasonId !== editing.initialStartReasonId) body.startReasonId = editing.startReasonId || null;
    if (editing.startNote.trim() !== editing.initialStartNote.trim()) body.startNote = editing.startNote.trim() || null;
    if (editing.stopReasonId !== editing.initialStopReasonId) body.stopReasonId = editing.stopReasonId || null;
    if (editing.stopNote.trim() !== editing.initialStopNote.trim()) body.stopNote = editing.stopNote.trim() || null;

    if (editing.startedAt !== editing.initialStartedAt) {
      const startedAt = new Date(editing.startedAt);
      if (editing.startedAt === "" || Number.isNaN(startedAt.getTime())) {
        setError("Fyll i starttiden");
        return;
      }
      body.startedAt = startedAt.toISOString();
    }

    if (editing.stoppedAt !== editing.initialStoppedAt) {
      if (editing.stoppedAt === "") {
        // Cleared Sluttid on a stopped session re-opens it (the API's
        // documented `stoppedAt: null`) — the row then shows as "Öppen
        // närvaro" again after the reload.
        body.stoppedAt = null;
      } else {
        const stoppedAt = new Date(editing.stoppedAt);
        if (Number.isNaN(stoppedAt.getTime())) {
          setError("Ogiltig sluttid");
          return;
        }
        body.stoppedAt = stoppedAt.toISOString();
      }
    }

    // Nothing edited — the API rejects an empty body, and there is nothing to
    // report either way.
    if (Object.keys(body).length === 0) {
      setEditing(null);
      return;
    }

    setPending(true);
    try {
      const result = await apiFetch<{ pausedWorkSessions?: number; movedPauses?: number }>(
        `/api/v1/attendance-sessions/${editing.id}`,
        { method: "PATCH", body: JSON.stringify(body) }
      );
      await afterMutation();
      const stop = body.stoppedAt ? toClock(body.stoppedAt) : "";
      if ((result.pausedWorkSessions ?? 0) > 0) {
        setNotice(
          `${result.pausedWorkSessions === 1 ? "1 arbete pausades" : `${result.pausedWorkSessions} arbeten pausades`} kl. ${stop}.`
        );
      } else if ((result.movedPauses ?? 0) > 0) {
        setNotice(`Pausen flyttades på ${result.movedPauses === 1 ? "1 arbete" : `${result.movedPauses} arbeten`}.`);
      }
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte spara närvarostämplingen"));
    } finally {
      setPending(false);
    }
  }

  async function setDisposition(date: string, disposition: OvertimeCompensation) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employeeId}/overtime-disposition/${date}`, {
        method: "PUT",
        body: JSON.stringify({ disposition }),
      });
      await afterMutation();
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte spara övertidsvalet"));
    } finally {
      setPending(false);
    }
  }

  async function clearDisposition(date: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/employees/${employeeId}/overtime-disposition/${date}`, { method: "DELETE" });
      await afterMutation();
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte återställa övertidsvalet"));
    } finally {
      setPending(false);
    }
  }

  async function deleteSession(id: string) {
    if (!(await confirmDelete("Tar bort närvarostämplingen. Fortsätt?"))) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/attendance-sessions/${id}`, { method: "DELETE" });
      await afterMutation();
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte ta bort närvarostämplingen"));
    } finally {
      setPending(false);
    }
  }

  async function deleteAbsence(id: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/absences/${id}`, { method: "DELETE" });
      await afterMutation();
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte ta bort frånvaron"));
    } finally {
      setPending(false);
    }
  }

  async function addAbsence(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (absenceTypeId === "") {
      setError("Välj en frånvarokod");
      return;
    }
    const parsedHours = Number(absenceHours.replace(",", "."));
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
          date: absenceDate,
          minutes: Math.round(parsedHours * 60),
          note: absenceNote.trim() === "" ? undefined : absenceNote.trim(),
        }),
      });
      setAbsenceTypeId("");
      await afterMutation();
    } catch (err) {
      setError(correctionErrorMessage(err, "Kunde inte registrera frånvaron"));
    } finally {
      setPending(false);
    }
  }

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <FormError>{error}</FormError>
        {!error && <FormHint>Hämtar dagvyn…</FormHint>}
      </div>
    );
  }

  const visibleDays = data.days.filter((day) =>
    dayHasContent(day, sessionsByDate.get(day.date)?.length ?? 0, absencesByDate.get(day.date)?.length ?? 0)
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <FormError>{error}</FormError>
      {notice && <FormHint>{notice}</FormHint>}

      <div>
        <div style={{ display: "grid", gridTemplateColumns: HOUR_COLUMNS, gap: 8 }}>
          <span style={headerCellStyle}>Datum</span>
          <span style={headerCellStyle}>Schema</span>
          <span style={headerCellStyle}>Arbetat</span>
          <span style={headerCellStyle}>Frånvaro</span>
          <span style={headerCellStyle}>ÖT</span>
          <span style={headerCellStyle}>Ofördelat</span>
        </div>

        {visibleDays.length === 0 && <FormHint>Inga dagar med tid i perioden.</FormHint>}

        {visibleDays.map((day) => {
          const daySessions = sessionsByDate.get(day.date) ?? [];
          const dayAbsences = absencesByDate.get(day.date) ?? [];
          const absenceMinutes = day.absences.reduce((total, absence) => total + absence.minutes, 0);
          return (
            <div key={day.date} style={{ borderTop: "1px solid var(--color-divider)", padding: "6px 0" }}>
              <div style={{ display: "grid", gridTemplateColumns: HOUR_COLUMNS, gap: 8, alignItems: "baseline" }}>
                <span className="num">
                  {day.date.slice(8)} {weekdayShort(day.date)}
                </span>
                <span className="num">{formatHours(day.scheduledMinutes)}</span>
                <span className="num">{formatHours(day.workedMinutes)}</span>
                <span className="num">{formatHours(absenceMinutes)}</span>
                <span className="num">
                  {formatHours(day.overtimeMinutes + day.overtimeOffScheduleMinutes)}
                </span>
                <span
                  className="num"
                  style={
                    day.unaccountedMinutes > 0
                      ? { color: "var(--status-stopped-text)", fontWeight: 600 }
                      : undefined
                  }
                >
                  {formatHours(day.unaccountedMinutes)}
                </span>
              </div>

              {!periodLocked && day.overtimeMinutes + day.overtimeOffScheduleMinutes > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, paddingLeft: 8 }}>
                  <span style={mutedStyle}>Övertid ersätts som</span>
                  <Select
                    aria-label="Övertid ersätts som"
                    value={day.overtimeDisposition ?? "payout"}
                    onChange={(e) => setDisposition(day.date, e.target.value as OvertimeCompensation)}
                    disabled={pending}
                  >
                    {(Object.keys(OVERTIME_COMPENSATION_LABELS) as OvertimeCompensation[]).map((value) => (
                      <option key={value} value={value}>
                        {OVERTIME_COMPENSATION_LABELS[value]}
                      </option>
                    ))}
                  </Select>
                  {day.overtimeDispositionSource === "override" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={pending}
                      onClick={() => clearDisposition(day.date)}
                    >
                      Återställ till standard
                    </Button>
                  )}
                </div>
              )}

              {daySessions.map((session) => (
                <div
                  key={session.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginTop: 4,
                    paddingLeft: 8,
                  }}
                >
                  {editing?.id === session.id ? (
                    <>
                      <Input
                        type="datetime-local"
                        aria-label="Starttid"
                        value={editing.startedAt}
                        onChange={(e) => setEditing({ ...editing, startedAt: e.target.value })}
                        style={{ maxWidth: 210 }}
                      />
                      <Input
                        type="datetime-local"
                        aria-label="Sluttid"
                        value={editing.stoppedAt}
                        onChange={(e) => setEditing({ ...editing, stoppedAt: e.target.value })}
                        style={{ maxWidth: 210 }}
                      />
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexBasis: "100%" }}>
                        {(
                          [
                            ["start", "Anledning vid ankomst", editing.startReasonId, editing.startNote],
                            ["stop", "Anledning vid hemgång", editing.stopReasonId, editing.stopNote],
                          ] as const
                        ).map(([which, label, reasonId, note]) => (
                          <div key={which} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <Select
                              aria-label={label}
                              value={reasonId}
                              onChange={(e) =>
                                setEditing({
                                  ...editing,
                                  ...(which === "start"
                                    ? { startReasonId: e.target.value }
                                    : { stopReasonId: e.target.value }),
                                })
                              }
                            >
                              <option value="">{`${label}: — Ingen —`}</option>
                              {reasons
                                .filter((r) => r.active || r.id === reasonId)
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}
                                    {r.active ? "" : " (inaktiv)"}
                                  </option>
                                ))}
                            </Select>
                            <Input
                              type="text"
                              maxLength={500}
                              aria-label={`Kommentar, ${label.toLowerCase()}`}
                              placeholder="Kommentar"
                              value={note}
                              onChange={(e) =>
                                setEditing({
                                  ...editing,
                                  ...(which === "start" ? { startNote: e.target.value } : { stopNote: e.target.value }),
                                })
                              }
                              style={{ maxWidth: 260 }}
                            />
                          </div>
                        ))}
                      </div>
                      <Button type="button" variant="secondary" size="small" disabled={pending} onClick={saveSession}>
                        Spara
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="num">
                        {toClock(session.startedAt)}–{session.stoppedAt ? toClock(session.stoppedAt) : ""}
                      </span>
                      {session.stoppedAt === null && <span style={mutedStyle}>Öppen närvaro</span>}
                      {sessionDeviationLines(session, day, daySessions).map((line) => (
                        <span key={line.key} style={mutedStyle}>
                          {line.text}
                        </span>
                      ))}
                      {!periodLocked && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          onClick={() => {
                            const startedAt = toDateTimeLocalValue(session.startedAt);
                            const stoppedAt = session.stoppedAt ? toDateTimeLocalValue(session.stoppedAt) : "";
                            setEditing({
                              id: session.id,
                              startedAt,
                              stoppedAt,
                              initialStartedAt: startedAt,
                              initialStoppedAt: stoppedAt,
                              startReasonId: session.startReason?.id ?? "",
                              startNote: session.startNote ?? "",
                              stopReasonId: session.stopReason?.id ?? "",
                              stopNote: session.stopNote ?? "",
                              initialStartReasonId: session.startReason?.id ?? "",
                              initialStartNote: session.startNote ?? "",
                              initialStopReasonId: session.stopReason?.id ?? "",
                              initialStopNote: session.stopNote ?? "",
                            });
                          }}
                        >
                          Ändra
                        </Button>
                      )}
                    </>
                  )}
                  {!periodLocked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={pending}
                      onClick={() => deleteSession(session.id)}
                    >
                      Ta bort
                    </Button>
                  )}
                </div>
              ))}

              {dayAbsences.map((absence) => (
                <div
                  key={absence.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginTop: 4,
                    paddingLeft: 8,
                  }}
                >
                  <span>
                    {absence.name} · <span className="num">{formatHours(absence.minutes)}</span>
                  </span>
                  {absence.note && <span style={mutedStyle}>{absence.note}</span>}
                  {!periodLocked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={pending}
                      onClick={() => deleteAbsence(absence.id)}
                    >
                      Ta bort
                    </Button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {periodLocked ? (
        <FormHint>Perioden är låst — inga korrigeringar kan göras.</FormHint>
      ) : (
        <Card maxWidth="none">
          <Form onSubmit={addAbsence}>
            <strong>Registrera frånvaro</strong>
            <FormRow>
              <Field label="Frånvarokod" htmlFor="detailAbsenceType">
                <Select
                  id="detailAbsenceType"
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
              <Field label="Datum" htmlFor="detailAbsenceDate">
                <Input
                  id="detailAbsenceDate"
                  type="date"
                  required
                  size="sm"
                  value={absenceDate}
                  onChange={(e) => setAbsenceDate(e.target.value)}
                />
              </Field>
            </FormRow>
            <FormRow>
              <Field label="Timmar" htmlFor="detailAbsenceHours">
                <Input
                  id="detailAbsenceHours"
                  required
                  placeholder="t.ex. 8 eller 4,5"
                  size="sm"
                  value={absenceHours}
                  onChange={(e) => setAbsenceHours(e.target.value)}
                />
              </Field>
              <Field label="Anteckning" htmlFor="detailAbsenceNote">
                <Input
                  id="detailAbsenceNote"
                  value={absenceNote}
                  onChange={(e) => setAbsenceNote(e.target.value)}
                />
              </Field>
            </FormRow>
            <FormActions>
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? "Registrerar…" : "Registrera"}
              </Button>
            </FormActions>
          </Form>
        </Card>
      )}

      <FormActions>
        <Button type="button" variant="ghost" onClick={onClose}>
          Stäng
        </Button>
      </FormActions>
    </div>
  );
}

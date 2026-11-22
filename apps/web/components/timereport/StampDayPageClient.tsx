"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { DurationInput } from "../ui/DurationInput";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { SearchPicker } from "../ui/SearchPicker";
import { SectionHeading } from "../ui/SectionHeading";
import { ScrapReasonFields } from "../quality/ScrapReasonFields";
import { apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { addDaysIso, stockholmToday, toDateTimeLocalValue } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { DURATION_HINT, durationFromHours, formatDuration, hoursFromDuration, parseDuration, readAbsenceMinutes } from "../../lib/duration";
import { formatQuantity } from "../../lib/format";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { instantFromField, STAMP_DAY_PATH, stampDayHref, stampHours, stampRange } from "../../lib/stampDay";
import { useScrapReasons } from "../../lib/useScrapReasons";
import {
  TIME_KIND_LABELS,
  type AbsenceType,
  type AttendanceDeviationReason,
  type DayComputation,
  type EmployeeDirectoryEntry,
  type EmployeePeriodDays,
  type ManufacturingOrder,
  type MOOperation,
  type StampDay,
  type StampDayAbsence,
  type StampDayAttendance,
  type StampDayManualReport,
  type StampDayStamp,
  type TimeKind,
} from "../../lib/types";
import styles from "./StampDayPageClient.module.css";

// Stämplingar (Personal & lön → Stämplingar, 2026-11-22): one employee's day
// — närvaro, frånvaro and arbete — with Ändra, Lägg till and Ta bort on each.
// Spec: private/superpowers/specs/2026-11-22-stamplingar-design.md.

type Dialog =
  | { kind: "attendance"; row: StampDayAttendance | null }
  | { kind: "absence"; row: StampDayAbsence | null }
  | { kind: "stamp"; row: StampDayStamp | null }
  | { kind: "manual"; row: StampDayManualReport };

const DIALOG_TITLES: Record<Dialog["kind"], [string, string]> = {
  attendance: ["Lägg till närvaro", "Ändra närvaro"],
  absence: ["Registrera frånvaro", "Ändra frånvaro"],
  stamp: ["Lägg till arbete", "Ändra arbete"],
  manual: ["Ändra tidrapport", "Ändra tidrapport"],
};

// Only released (or further) orders take reports; Stängd is refused.
const REPORTABLE_MO_STATUSES = "released,in_progress,done";

function hoursText(hours: number): string {
  return `${hours.toLocaleString("sv-SE", { maximumFractionDigits: 2 })} h`;
}

function minutesText(minutes: number): string {
  return hoursText(minutes / 60);
}

function operationLabel(row: { orderNumber: string; sequenceNo: number; operationDescription: string | null }, workCenterName?: string | null) {
  const what = workCenterName ?? row.operationDescription;
  return `op ${row.sequenceNo}${what ? ` ${what}` : ""}`;
}

export function StampDayPageClient({
  employees,
  employeeId,
  date,
  timeKindSplit,
}: {
  employees: EmployeeDirectoryEntry[];
  employeeId: string | null;
  date: string;
  timeKindSplit: boolean;
}) {
  const router = useRouter();
  const [day, setDay] = useState<StampDay | null>(null);
  const [summary, setSummary] = useState<DayComputation | null>(null);
  const [absenceTypes, setAbsenceTypes] = useState<AbsenceType[]>([]);
  const [reasons, setReasons] = useState<AttendanceDeviationReason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!employeeId) return;
    const [year, month] = date.split("-").map(Number);
    const [stampDay, period, types, reasonList] = await Promise.all([
      apiFetch<StampDay>(`/api/v1/employees/${employeeId}/stamp-day?date=${date}`),
      // The day's sums from the payroll's own engine (Attestering's dagvy).
      apiFetch<EmployeePeriodDays>(`/api/v1/periods/${year}/${month}/employees/${employeeId}/days`).catch(() => null),
      apiFetch<AbsenceType[]>("/api/v1/absence-types"),
      apiFetch<AttendanceDeviationReason[]>("/api/v1/attendance-deviation-reasons?includeInactive=true"),
    ]);
    setDay(stampDay);
    setSummary(period?.days.find((d) => d.date === date) ?? null);
    setAbsenceTypes(types);
    setReasons(reasonList);
  }, [employeeId, date]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, "Kunde inte hämta dagen")));
  }, [load]);

  function go(nextEmployee: string | null, nextDate: string) {
    router.push(nextEmployee ? stampDayHref(nextEmployee, nextDate) : `${STAMP_DAY_PATH}?date=${nextDate}`);
  }

  async function afterChange(message: string) {
    setDialog(null);
    setError(null);
    setNotice(message);
    await load().catch((err) => setError(apiErrorMessage(err, "Kunde inte hämta dagen")));
  }

  async function remove(question: string, url: string, done: string) {
    if (!(await confirmDelete(question))) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch(url, { method: "DELETE" });
      await afterChange(done);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort"));
    } finally {
      setBusy(false);
    }
  }

  const reasonName = (id: string | null) => (id ? (reasons.find((r) => r.id === id)?.name ?? null) : null);
  const listed = employees.filter((e) => e.active || e.id === employeeId);
  const locked = day?.periodLocked ?? false;
  const absenceMinutes = summary?.absences.reduce((sum, a) => sum + a.minutes, 0) ?? 0;

  return (
    <>
      <div className={styles.controls}>
        <Field label="Anställd" htmlFor="sd-employee">
          <Select id="sd-employee" value={employeeId ?? ""} onChange={(e) => go(e.target.value || null, date)}>
            <option value="">Välj anställd…</option>
            {listed.map((e) => (
              <option key={e.id} value={e.id}>
                {e.employeeNumber} — {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Dag" htmlFor="sd-date">
          <div className={styles.dayNav}>
            <Button type="button" variant="secondary" aria-label="Föregående dag" onClick={() => go(employeeId, addDaysIso(date, -1))}>
              ◀
            </Button>
            <Input id="sd-date" type="date" value={date} onChange={(e) => e.target.value && go(employeeId, e.target.value)} />
            <Button type="button" variant="secondary" aria-label="Nästa dag" onClick={() => go(employeeId, addDaysIso(date, 1))}>
              ▶
            </Button>
            {date !== stockholmToday() && (
              <Button type="button" variant="ghost" onClick={() => go(employeeId, stockholmToday())}>
                I dag
              </Button>
            )}
          </div>
        </Field>
      </div>

      {!employeeId ? (
        <p className={styles.empty}>Välj en anställd för att se och rätta dagens stämplingar.</p>
      ) : (
        <>
          {summary && (
            <p className={styles.summary}>
              Schema <span className="num">{minutesText(summary.scheduledMinutes)}</span> · Arbetat{" "}
              <span className="num">{minutesText(summary.workedMinutes)}</span> · Frånvaro{" "}
              <span className="num">{minutesText(absenceMinutes)}</span>
              {summary.unaccountedMinutes > 0 && (
                <>
                  {" "}
                  · <strong>Ofördelat <span className="num">{minutesText(summary.unaccountedMinutes)}</span></strong>
                </>
              )}
            </p>
          )}
          {locked && (
            <p className={styles.locked}>
              Löneperioden är låst. Närvaro och frånvaro kan inte ändras, och på arbetet går bara typen att ändra.
            </p>
          )}
          <FormError>{error}</FormError>
          {notice && <p className={styles.notice}>{notice}</p>}

          {day && (
            <div className={styles.cards}>
              <Card maxWidth="none">
                <SectionHeading
                  actions={
                    !locked && (
                      <Button size="small" variant="secondary" onClick={() => setDialog({ kind: "attendance", row: null })}>
                        + Lägg till närvaro
                      </Button>
                    )
                  }
                >
                  Närvaro
                </SectionHeading>
                {day.attendance.length === 0 ? (
                  <p className={styles.empty}>Ingen närvaro stämplad.</p>
                ) : (
                  <ul className={styles.rows}>
                    {day.attendance.map((a) => {
                      const lines = [
                        reasonName(a.startReasonId) || a.startNote
                          ? `Kom: ${[reasonName(a.startReasonId), a.startNote].filter(Boolean).join(" — ")}`
                          : null,
                        reasonName(a.stopReasonId) || a.stopNote
                          ? `Gick: ${[reasonName(a.stopReasonId), a.stopNote].filter(Boolean).join(" — ")}`
                          : null,
                      ].filter((line): line is string => line !== null);
                      return (
                        <li key={a.id} className={styles.row}>
                          <div className={styles.rowMain}>
                            <span className={styles.time}>{stampRange(a.startedAt, a.stoppedAt, date)}</span>
                            {lines.map((line) => (
                              <span key={line} className={styles.meta}>
                                {line}
                              </span>
                            ))}
                          </div>
                          {!locked && (
                            <div className={styles.actions}>
                              <Button size="small" variant="ghost" onClick={() => setDialog({ kind: "attendance", row: a })}>
                                Ändra
                              </Button>
                              {a.stoppedAt && (
                                <Button
                                  size="small"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void remove(
                                      `Ta bort närvaron ${stampRange(a.startedAt, a.stoppedAt, date)}?`,
                                      `/api/v1/attendance-sessions/${a.id}`,
                                      "Närvaron är borttagen."
                                    )
                                  }
                                >
                                  Ta bort
                                </Button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card maxWidth="none">
                <SectionHeading
                  actions={
                    !locked && (
                      <Button size="small" variant="secondary" onClick={() => setDialog({ kind: "absence", row: null })}>
                        + Registrera frånvaro
                      </Button>
                    )
                  }
                >
                  Frånvaro
                </SectionHeading>
                {day.absences.length === 0 ? (
                  <p className={styles.empty}>Ingen frånvaro registrerad.</p>
                ) : (
                  <ul className={styles.rows}>
                    {day.absences.map((a) => (
                      <li key={a.id} className={styles.row}>
                        <div className={styles.rowMain}>
                          <span>
                            {a.code} · {a.name} · <span className="num">{minutesText(a.minutes)}</span>
                          </span>
                          {a.note && <span className={styles.meta}>{a.note}</span>}
                        </div>
                        {!locked && (
                          <div className={styles.actions}>
                            <Button size="small" variant="ghost" onClick={() => setDialog({ kind: "absence", row: a })}>
                              Ändra
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void remove(`Ta bort frånvaron ${a.code} ${a.name}?`, `/api/v1/absences/${a.id}`, "Frånvaron är borttagen.")}
                            >
                              Ta bort
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card maxWidth="none">
                <SectionHeading
                  actions={
                    <Button size="small" variant="secondary" onClick={() => setDialog({ kind: "stamp", row: null })}>
                      + Lägg till arbete
                    </Button>
                  }
                >
                  Arbete
                </SectionHeading>
                {day.stamps.length === 0 && day.manualReports.length === 0 ? (
                  <p className={styles.empty}>Inget arbete stämplat.</p>
                ) : (
                  <ul className={styles.rows}>
                    {day.stamps.map((s) => (
                      <StampRow
                        key={s.id}
                        stamp={s}
                        date={date}
                        busy={busy}
                        onEdit={() => setDialog({ kind: "stamp", row: s })}
                        onRemove={() =>
                          void remove(
                            `Ta bort arbetet ${stampRange(s.startedAt, s.stoppedAt, date)} på ${s.orderNumber}? Rapporten ångras: antalet dras av och materialet läggs tillbaka i lager.`,
                            `/api/v1/stamp-sessions/${s.id}`,
                            "Arbetet är borttaget."
                          )
                        }
                      />
                    ))}
                    {day.manualReports.map((r) => (
                      <li key={r.id} className={styles.row}>
                        <div className={styles.rowMain}>
                          <span className={styles.time}>Manuell tidrapport</span>
                          <span>
                            <Link href={`/tillverkning/ordrar/${r.manufacturingOrderId}`}>{r.orderNumber}</Link> · {operationLabel(r)} ·{" "}
                            {r.articleNumber} {r.articleName}
                          </span>
                          <span className={styles.meta}>
                            <span className="num">{hoursText(r.hours)}</span>
                            {r.kind && ` · ${TIME_KIND_LABELS[r.kind]}`}
                            {r.note && ` · ${r.note}`}
                          </span>
                        </div>
                        <div className={styles.actions}>
                          <Button size="small" variant="ghost" onClick={() => setDialog({ kind: "manual", row: r })}>
                            Ändra
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void remove(`Ta bort tidrapporten på ${r.orderNumber}?`, `/api/v1/time-reports/${r.id}`, "Tidrapporten är borttagen.")}
                          >
                            Ta bort
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </>
      )}

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog ? DIALOG_TITLES[dialog.kind][dialog.row ? 1 : 0] : ""}
      >
        {dialog?.kind === "attendance" && employeeId && (
          <AttendanceForm
            employeeId={employeeId}
            date={date}
            row={dialog.row}
            reasons={reasons}
            onDone={(message) => void afterChange(message)}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "absence" && employeeId && (
          <AbsenceForm
            employeeId={employeeId}
            date={date}
            row={dialog.row}
            types={absenceTypes}
            onDone={(message) => void afterChange(message)}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "stamp" && employeeId && (
          <WorkStampForm
            employeeId={employeeId}
            date={date}
            row={dialog.row}
            timeKindSplit={timeKindSplit}
            onDone={(message) => void afterChange(message)}
            onCancel={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "manual" && (
          <ManualReportForm
            row={dialog.row}
            timeKindSplit={timeKindSplit}
            onDone={(message) => void afterChange(message)}
            onCancel={() => setDialog(null)}
          />
        )}
      </Modal>
    </>
  );
}

function StampRow({
  stamp,
  date,
  busy,
  onEdit,
  onRemove,
}: {
  stamp: StampDayStamp;
  date: string;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const report = stamp.report;
  const facts = [
    stamp.hours !== null ? hoursText(stamp.hours) : null,
    stamp.pauseMinutes > 0 ? `paus ${stamp.pauseMinutes} min` : null,
    stamp.kind ? TIME_KIND_LABELS[stamp.kind] : null,
    report && report.quantityOk > 0 ? `OK ${formatQuantity(report.quantityOk)}` : null,
    report && report.quantityScrapped > 0
      ? `Kasserat ${formatQuantity(report.quantityScrapped)}${
          report.scrapReasonName || report.scrapReason ? ` (${[report.scrapReasonName, report.scrapReason].filter(Boolean).join(": ")})` : ""
        }`
      : null,
    report?.markedDone ? "Operationen klar" : null,
    stamp.note,
  ].filter((fact): fact is string => !!fact);
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.time}>{stampRange(stamp.startedAt, stamp.stoppedAt, date)}</span>
        <span>
          <Link href={`/tillverkning/ordrar/${stamp.manufacturingOrderId}`}>{stamp.orderNumber}</Link> ·{" "}
          {operationLabel(stamp, stamp.workCenterName)} · {stamp.articleNumber} {stamp.articleName}
        </span>
        {facts.length > 0 && <span className={styles.meta}>{facts.join(" · ")}</span>}
        {stamp.legacy && <span className={styles.meta}>Rapporterad före rapportloggen — här går bara tiderna att ändra.</span>}
        {stamp.stoppedAt && !stamp.legacy && !report && (
          <span className={styles.meta}>Rapporten är ångrad på tillverkningsordern — Ändra rapporterar arbetet igen.</span>
        )}
      </div>
      <div className={styles.actions}>
        {stamp.stoppedAt ? (
          <>
            <Button size="small" variant="ghost" onClick={onEdit}>
              Ändra
            </Button>
            {!stamp.legacy && (
              <Button size="small" variant="ghost" disabled={busy} onClick={onRemove}>
                Ta bort
              </Button>
            )}
          </>
        ) : (
          <Link href="/tillverkning/pagaende" className={styles.meta}>
            {stamp.pausedAt ? "Pausad" : "Pågår"} — stämpla ut under Pågående arbete
          </Link>
        )}
      </div>
    </li>
  );
}

function ReasonSelect({
  id,
  label,
  value,
  reasons,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  reasons: AttendanceDeviationReason[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Ingen —</option>
        {reasons
          .filter((r) => r.active || r.id === value)
          .map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function AttendanceForm({
  employeeId,
  date,
  row,
  reasons,
  onDone,
  onCancel,
}: {
  employeeId: string;
  date: string;
  row: StampDayAttendance | null;
  reasons: AttendanceDeviationReason[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(row ? toDateTimeLocalValue(row.startedAt) : `${date}T07:00`);
  const [stop, setStop] = useState(row ? (row.stoppedAt ? toDateTimeLocalValue(row.stoppedAt) : "") : `${date}T16:00`);
  const [startReasonId, setStartReasonId] = useState(row?.startReasonId ?? "");
  const [startNote, setStartNote] = useState(row?.startNote ?? "");
  const [stopReasonId, setStopReasonId] = useState(row?.stopReasonId ?? "");
  const [stopNote, setStopNote] = useState(row?.stopNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const startedAt = instantFromField(start, row?.startedAt ?? null);
    if (!startedAt) {
      setError("Fyll i starttiden");
      return;
    }
    const stoppedAt = stop === "" ? null : instantFromField(stop, row?.stoppedAt ?? null);
    if (stop !== "" && !stoppedAt) {
      setError("Ogiltig sluttid");
      return;
    }
    let body: Record<string, unknown>;
    if (!row) {
      if (!stoppedAt) {
        setError("Fyll i sluttiden — en närvaro som läggs till i efterhand är avslutad");
        return;
      }
      body = {
        startedAt,
        stoppedAt,
        startReasonId: startReasonId || null,
        startNote: startNote.trim() || null,
        stopReasonId: stopReasonId || null,
        stopNote: stopNote.trim() || null,
      };
    } else {
      // Only what changed (the attestation's correction, same route).
      body = {};
      if (startedAt !== row.startedAt) body.startedAt = startedAt;
      if (stoppedAt !== row.stoppedAt) body.stoppedAt = stoppedAt;
      if (startReasonId !== (row.startReasonId ?? "")) body.startReasonId = startReasonId || null;
      if (startNote.trim() !== (row.startNote ?? "")) body.startNote = startNote.trim() || null;
      if (stopReasonId !== (row.stopReasonId ?? "")) body.stopReasonId = stopReasonId || null;
      if (stopNote.trim() !== (row.stopNote ?? "")) body.stopNote = stopNote.trim() || null;
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
    }
    setPending(true);
    try {
      await apiFetch(row ? `/api/v1/attendance-sessions/${row.id}` : `/api/v1/employees/${employeeId}/attendance-sessions`, {
        method: row ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onDone(row ? "Närvaron är ändrad." : "Närvaron är tillagd.");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara närvaron"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormRow>
        <Field label="Kom" htmlFor="sd-att-start">
          <Input id="sd-att-start" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Gick" htmlFor="sd-att-stop">
          <Input id="sd-att-stop" type="datetime-local" required={!row} value={stop} onChange={(e) => setStop(e.target.value)} />
        </Field>
      </FormRow>
      {row && (
        <FormHint>
          Flyttas sluttiden följer den anställdes arbeten med: de pausas vid den nya sluttiden. Töms sluttiden öppnas närvaron igen.
        </FormHint>
      )}
      <FormRow>
        <ReasonSelect id="sd-att-start-reason" label="Anledning vid ankomst" value={startReasonId} reasons={reasons} onChange={setStartReasonId} />
        <Field label="Kommentar" htmlFor="sd-att-start-note">
          <Input id="sd-att-start-note" value={startNote} onChange={(e) => setStartNote(e.target.value)} />
        </Field>
      </FormRow>
      <FormRow>
        <ReasonSelect id="sd-att-stop-reason" label="Anledning vid hemgång" value={stopReasonId} reasons={reasons} onChange={setStopReasonId} />
        <Field label="Kommentar" htmlFor="sd-att-stop-note">
          <Input id="sd-att-stop-note" value={stopNote} onChange={(e) => setStopNote(e.target.value)} />
        </Field>
      </FormRow>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}

function AbsenceForm({
  employeeId,
  date,
  row,
  types,
  onDone,
  onCancel,
}: {
  employeeId: string;
  date: string;
  row: StampDayAbsence | null;
  types: AbsenceType[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [typeId, setTypeId] = useState(row?.absenceTypeId ?? "");
  const [day, setDay] = useState(row?.date ?? date);
  const [hours, setHours] = useState(row ? formatDuration(row.minutes) : "");
  const [note, setNote] = useState(row?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!typeId) {
      setError("Välj en frånvarokod");
      return;
    }
    // Tid is tt:mm (lib/duration.ts); the API keeps minutes.
    const minutes = readAbsenceMinutes(hours);
    if (typeof minutes === "string") {
      setError(minutes);
      return;
    }
    let body: Record<string, unknown>;
    if (!row) {
      body = { absenceTypeId: typeId, date: day, minutes, note: note.trim() || undefined };
    } else {
      body = {};
      if (typeId !== row.absenceTypeId) body.absenceTypeId = typeId;
      if (day !== row.date) body.date = day;
      if (minutes !== row.minutes) body.minutes = minutes;
      if (note.trim() !== (row.note ?? "")) body.note = note.trim() || null;
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
    }
    setPending(true);
    try {
      await apiFetch(row ? `/api/v1/absences/${row.id}` : `/api/v1/employees/${employeeId}/absences`, {
        method: row ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onDone(row ? "Frånvaron är ändrad." : "Frånvaron är registrerad.");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara frånvaron"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <Field label="Frånvarokod" htmlFor="sd-abs-type">
        <Select id="sd-abs-type" required value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">Välj frånvarokod…</option>
          {types
            .filter((t) => t.active || t.id === typeId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · {t.name}
              </option>
            ))}
        </Select>
      </Field>
      <FormRow>
        <Field label="Datum" htmlFor="sd-abs-date">
          <Input id="sd-abs-date" type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Tid (tt:mm)" htmlFor="sd-abs-hours">
          <DurationInput id="sd-abs-hours" required placeholder="t.ex. 8:00" value={hours} onValueChange={setHours} />
        </Field>
      </FormRow>
      <Field label="Anteckning (valfritt)" htmlFor="sd-abs-note">
        <Input id="sd-abs-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : row ? "Spara" : "Registrera"}
        </Button>
      </FormActions>
    </Form>
  );
}

function WorkStampForm({
  employeeId,
  date,
  row,
  timeKindSplit,
  onDone,
  onCancel,
}: {
  employeeId: string;
  date: string;
  row: StampDayStamp | null;
  timeKindSplit: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [order, setOrder] = useState<ManufacturingOrder | null>(
    row
      ? ({ id: row.manufacturingOrderId, orderNumber: row.orderNumber, articleNumber: row.articleNumber, articleName: row.articleName } as ManufacturingOrder)
      : null
  );
  const [operations, setOperations] = useState<MOOperation[]>([]);
  const [operationId, setOperationId] = useState(row?.moOperationId ?? "");
  const [start, setStart] = useState(row ? toDateTimeLocalValue(row.startedAt) : `${date}T07:00`);
  const [stop, setStop] = useState(row?.stoppedAt ? toDateTimeLocalValue(row.stoppedAt) : `${date}T16:00`);
  // Paus as tt:mm; the API takes whole minutes.
  const [pause, setPause] = useState(formatDuration(row?.pauseMinutes ?? 0));
  const [kind, setKind] = useState<TimeKind | "">(row ? (row.kind ?? "") : timeKindSplit ? "run" : "");
  const [quantityOk, setQuantityOk] = useState(row?.report ? String(row.report.quantityOk) : "0");
  const [quantityScrapped, setQuantityScrapped] = useState(row?.report ? String(row.report.quantityScrapped) : "0");
  const [scrapReasonId, setScrapReasonId] = useState(row?.report?.scrapReasonId ?? "");
  const [scrapReason, setScrapReason] = useState(row?.report?.scrapReason ?? "");
  const [markDone, setMarkDone] = useState(row?.report?.markedDone ?? false);
  const [note, setNote] = useState(row?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scrapReasonOptions = useScrapReasons();
  const reasonRegister = scrapReasonOptions !== null && scrapReasonOptions.length > 0;
  const legacy = row?.legacy ?? false;
  const opsSeq = useRef(0);

  const loadOperations = useCallback(async (orderId: string, keep: string | null) => {
    // A late answer for an earlier order must not overwrite the list.
    const seq = ++opsSeq.current;
    try {
      const ops = await apiFetch<MOOperation[]>(`/api/v1/manufacturing-orders/${orderId}/operations`);
      if (seq !== opsSeq.current) return;
      // A lego operation is reported on its purchase order, never stamped.
      const usable = ops.filter((op) => op.workCenterType !== "subcontract" || op.id === keep);
      setOperations(usable);
      setOperationId(keep && usable.some((op) => op.id === keep) ? keep : (usable[0]?.id ?? ""));
    } catch (err) {
      if (seq === opsSeq.current) setError(apiErrorMessage(err, "Kunde inte hämta operationerna"));
    }
  }, []);

  useEffect(() => {
    if (row) void loadOperations(row.manufacturingOrderId, row.moOperationId);
  }, [row, loadOperations]);

  const startedAt = instantFromField(start, row?.startedAt ?? null);
  const stoppedAt = instantFromField(stop, row?.stoppedAt ?? null);
  const pauseMinutes = pause.trim() === "" ? 0 : parseDuration(pause);
  const preview = pauseMinutes === null ? null : stampHours(startedAt, stoppedAt, pauseMinutes);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!operationId) {
      setError("Välj tillverkningsorder och operation");
      return;
    }
    if (pauseMinutes === null) {
      setError(`Paus: ${DURATION_HINT}`);
      return;
    }
    if (!startedAt || !stoppedAt || preview === null) {
      setError("Sluttiden måste vara efter starttiden, och pausen kortare än tiden mellan dem");
      return;
    }
    const scrapped = Number(quantityScrapped) || 0;
    if (scrapped > 0 && reasonRegister && !scrapReasonId) {
      setError("Välj en orsak när kasserat antal är större än 0");
      return;
    }
    if (scrapped > 0 && !reasonRegister && !scrapReason.trim()) {
      setError("Ange en kassationsorsak när kasserat antal är större än 0");
      return;
    }
    setPending(true);
    try {
      const result = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(row ? `/api/v1/stamp-sessions/${row.id}` : `/api/v1/employees/${employeeId}/stamp-sessions`, {
          method: row ? "PATCH" : "POST",
          body: JSON.stringify({
            moOperationId: operationId,
            startedAt,
            stoppedAt,
            pauseMinutes,
            // Without the setting the type is kept as it is.
            ...(timeKindSplit ? { kind: kind || null } : {}),
            note: note.trim() || null,
            quantityOk: legacy ? 0 : Number(quantityOk) || 0,
            quantityScrapped: legacy ? 0 : scrapped,
            ...(scrapped > 0 && reasonRegister ? { scrapReasonId } : {}),
            ...(scrapped > 0 && scrapReason.trim() ? { scrapReason: scrapReason.trim() } : {}),
            markOperationDone: legacy ? false : markDone,
            allowMaterialShortage,
          }),
        })
      );
      if (result === null) {
        setPending(false);
        return;
      }
      onDone(row ? "Arbetet är ändrat." : "Arbetet är tillagt.");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara arbetet"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <Field label="Tillverkningsorder" htmlFor="sd-ws-order">
        <SearchPicker
          id="sd-ws-order"
          endpoint={`/api/v1/manufacturing-orders?status=${REPORTABLE_MO_STATUSES}`}
          value={order}
          onChange={(next) => {
            setOrder(next);
            setOperations([]);
            setOperationId("");
            if (next) void loadOperations(next.id, null);
          }}
          formatLabel={(o) => `${o.orderNumber} — ${o.articleNumber}`}
          placeholder="Sök ordernummer eller artikel…"
          emptyText="Inga tillverkningsordrar matchar sökningen"
        />
      </Field>
      <Field label="Operation" htmlFor="sd-ws-op">
        <Select id="sd-ws-op" value={operationId} onChange={(e) => setOperationId(e.target.value)} disabled={operations.length === 0}>
          {operations.length === 0 ? (
            <option value="">{order ? "Hämtar operationer…" : "Välj tillverkningsorder först"}</option>
          ) : (
            operations.map((op) => (
              <option key={op.id} value={op.id}>
                {op.sequenceNo} — {op.workCenterName}
              </option>
            ))
          )}
        </Select>
      </Field>
      <FormRow columns={3}>
        <Field label="Start" htmlFor="sd-ws-start">
          <Input id="sd-ws-start" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Slut" htmlFor="sd-ws-stop">
          <Input id="sd-ws-stop" type="datetime-local" required value={stop} onChange={(e) => setStop(e.target.value)} />
        </Field>
        <Field label="Paus (tt:mm)" htmlFor="sd-ws-pause">
          <DurationInput id="sd-ws-pause" placeholder="t.ex. 0:30" value={pause} onValueChange={setPause} />
        </Field>
      </FormRow>
      <FormHint>
        Tid som rapporteras: <span className="num">{preview === null ? "–" : durationFromHours(preview)}</span>
      </FormHint>
      {timeKindSplit && (
        <Field label="Typ" htmlFor="sd-ws-kind">
          <Select id="sd-ws-kind" value={kind} onChange={(e) => setKind(e.target.value as TimeKind | "")}>
            <option value="">Ej uppdelad</option>
            <option value="setup">Ställ</option>
            <option value="run">Produktion</option>
          </Select>
        </Field>
      )}
      {legacy ? (
        <FormHint>
          Arbetet rapporterades innan rapportloggen fanns. Här går bara tiderna, typen och anteckningen att ändra — rätta antalet på
          tillverkningsordern.
        </FormHint>
      ) : (
        <>
          <FormRow>
            <Field label="Antal OK" htmlFor="sd-ws-ok">
              <Input id="sd-ws-ok" type="number" min="0" step="any" value={quantityOk} onChange={(e) => setQuantityOk(e.target.value)} />
            </Field>
            <Field label="Kasserat" htmlFor="sd-ws-scrap">
              <Input
                id="sd-ws-scrap"
                type="number"
                min="0"
                step="any"
                value={quantityScrapped}
                onChange={(e) => setQuantityScrapped(e.target.value)}
              />
            </Field>
          </FormRow>
          {(Number(quantityScrapped) || 0) > 0 && (
            <ScrapReasonFields
              idPrefix="sd-ws"
              reasons={scrapReasonOptions}
              reasonId={scrapReasonId}
              text={scrapReason}
              onReasonId={setScrapReasonId}
              onText={setScrapReason}
            />
          )}
          <label className={styles.checkRow}>
            <Checkbox checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
            Operationen är klar
          </label>
          {row && (
            <FormHint>
              Ändras operationen eller antalet ångras arbetets rapport och görs om: antal, material och färdiga varor följer med.
            </FormHint>
          )}
        </>
      )}
      <Field label="Anteckning (valfritt)" htmlFor="sd-ws-note">
        <Input id="sd-ws-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : row ? "Spara" : "Lägg till"}
        </Button>
      </FormActions>
    </Form>
  );
}

function ManualReportForm({
  row,
  timeKindSplit,
  onDone,
  onCancel,
}: {
  row: StampDayManualReport;
  timeKindSplit: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [day, setDay] = useState(row.date);
  // Tid as tt:mm; the time report keeps hours with two decimals.
  const [hours, setHours] = useState(durationFromHours(row.hours));
  const [kind, setKind] = useState<TimeKind | "">(row.kind ?? "");
  const [note, setNote] = useState(row.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = hoursFromDuration(hours, row.hours);
    if (parsed === null || parsed <= 0) {
      setError(parsed === null ? DURATION_HINT : "Ange en tid större än 0:00.");
      return;
    }
    const body: Record<string, unknown> = {};
    if (day !== row.date) body.date = day;
    if (parsed !== row.hours) body.hours = parsed;
    if (timeKindSplit && (kind || null) !== row.kind) body.kind = kind || null;
    if (note.trim() !== (row.note ?? "")) body.note = note.trim() || null;
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    setPending(true);
    try {
      await apiFetch(`/api/v1/time-reports/${row.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onDone("Tidrapporten är ändrad.");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara tidrapporten"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormHint>
        {row.orderNumber} · {operationLabel(row)} · {row.articleNumber} {row.articleName}
      </FormHint>
      <FormRow>
        <Field label="Datum" htmlFor="sd-tr-date">
          <Input id="sd-tr-date" type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Tid (tt:mm)" htmlFor="sd-tr-hours">
          <DurationInput id="sd-tr-hours" required value={hours} onValueChange={setHours} />
        </Field>
      </FormRow>
      {timeKindSplit && (
        <Field label="Typ" htmlFor="sd-tr-kind">
          <Select id="sd-tr-kind" value={kind} onChange={(e) => setKind(e.target.value as TimeKind | "")}>
            <option value="">Ej uppdelad</option>
            <option value="setup">Ställ</option>
            <option value="run">Produktion</option>
          </Select>
        </Field>
      )}
      <Field label="Anteckning (valfritt)" htmlFor="sd-tr-note">
        <Input id="sd-tr-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
      </FormActions>
    </Form>
  );
}

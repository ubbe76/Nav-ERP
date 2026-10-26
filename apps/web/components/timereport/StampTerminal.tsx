"use client";

import { useScrapReasons } from "../../lib/useScrapReasons";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Wordmark } from "../ui/Wordmark";
import { ApiError, apiFetch } from "../../lib/api";
import { formatStockholmDate, stockholmToday, toDateTimeLocalValue } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import type {
  AtfStatus,
  AttendanceInputRequiredBody,
  AttendanceOutInput,
  AttendanceReasonInput,
  AttendanceSession,
  AttendanceDeviationReason,
  OvertimeCompensation,
  EmployeeDirectoryEntry,
  ResolvedCalendarDay,
  StampSession,
  TerminalMaterial,
  TerminalOperation,
  TerminalStation,
} from "../../lib/types";
import { StatusPill, type Status } from "../ui/StatusPill";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import {
  filterTerminalOperations,
  readinessLabel,
  sortTerminalOperations,
  type TerminalSort,
} from "../../lib/terminalOperations";
import { plannedWeekLabel } from "../../lib/planning";
import { formatElapsed, formatQuantity, operationProgress, type OperationProgress } from "../../lib/stampSessions";
import { formatHours } from "./SchedulesPageClient";
import styles from "./StampTerminal.module.css";

type Step =
  | { name: "keypad" }
  | { name: "home"; employee: EmployeeDirectoryEntry }
  | { name: "pickOperations"; employee: EmployeeDirectoryEntry }
  | { name: "stampOut"; employee: EmployeeDirectoryEntry; session: StampSession }
  | { name: "atf"; employee: EmployeeDirectoryEntry; atf: AtfStatus; scheduledMinutes: number | null }
  | { name: "forgotten"; employee: EmployeeDirectoryEntry; attendanceId: string; startedAt: string }
  | {
      name: "deviation";
      employee: EmployeeDirectoryEntry;
      body: AttendanceInputRequiredBody;
      pending: PendingAttendanceAction;
      // Answers already given to an earlier 409 of the same request: they
      // are kept (pre-selected) and always sent again, so a second question
      // never drops the first answer.
      answers: DeviationAnswers;
    };

// The request the server answered with 409 attendance-input-required, sent
// again with the person's answers (the terminal never computes deviations).
type PendingAttendanceAction =
  // forgottenStoppedAt: Spara och stämpla in after a forgotten Gå hem — the
  // server closes yesterday's attendance and opens today's in one request.
  | { kind: "attendanceIn"; forgottenStoppedAt?: string }
  // earlierFailed: operations of the same batch that already failed for
  // another reason before the question came — they stay checked afterwards.
  | { kind: "stampIn"; operations: TerminalOperation[]; earlierFailed: TerminalOperation[] }
  | { kind: "goHome"; attendanceId: string }
  | { kind: "atf"; attendanceId: string; atfTransactionId: string; hours: number };

type DeviationAnswers = { reason?: AttendanceReasonInput; overtimeDisposition?: OvertimeCompensation };

function inputRequiredBody(err: unknown): AttendanceInputRequiredBody | null {
  if (err instanceof ApiError && err.code === "attendance-input-required" && err.body) {
    return err.body as AttendanceInputRequiredBody;
  }
  return null;
}

// The chosen reason was inactivated (or removed) since the list was loaded.
function isReasonInvalid(err: unknown) {
  return err instanceof ApiError && err.code === "attendance-reason-invalid";
}

function minutesText(minutes: number) {
  return minutes === 1 ? "1 minut" : `${minutes} minuter`;
}

function durationText(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return minutesText(m);
  return m === 0 ? `${h} tim` : `${h} tim ${m} min`;
}

const IDLE_RESET_MS = 60_000;

// Stockholm calendar day (YYYY-MM-DD), same as dayKey in InProgressPageClient.
function stockholmDay(iso: string | number) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function StampTerminal({
  employees,
  initialOpenSessions,
  initialOpenAttendance,
  stations,
  allowMultipleStamps,
}: {
  employees: EmployeeDirectoryEntry[];
  initialOpenSessions: StampSession[];
  initialOpenAttendance: AttendanceSession[];
  stations: TerminalStation[];
  allowMultipleStamps: boolean;
}) {
  const [step, setStep] = useState<Step>({ name: "keypad" });
  const [entry, setEntry] = useState("");
  const [openSessions, setOpenSessions] = useState(initialOpenSessions);
  const [openAttendance, setOpenAttendance] = useState(initialOpenAttendance);
  const [error, setError] = useState<string | null>(null);
  // Friendly confirmation shown on the keypad after e.g. going home.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [markDone, setMarkDone] = useState(false);
  // pickOperations: operations checked for the next "Starta valda" batch.
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  // Per-stint quantity report: OK units, scrapped units + mandatory reason.
  const [quantityOk, setQuantityOk] = useState("");
  const [quantityScrapped, setQuantityScrapped] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  // Kassationsorsaker from Kvalitetsorsaker: Orsak is chosen, scrapReason holds the Kommentar.
  const [scrapReasonId, setScrapReasonId] = useState("");
  const scrapReasonOptions = useScrapReasons(step.name === "stampOut");
  const scrapReasonRegister = scrapReasonOptions !== null && scrapReasonOptions.length > 0;
  const [atfHours, setAtfHours] = useState("");
  const [forgottenStop, setForgottenStop] = useState("");
  // Avvikelseorsaker for the deviation step: fetched again every time the
  // step opens, so a reason an administrator just added or inactivated shows.
  const [reasons, setReasons] = useState<AttendanceDeviationReason[] | null>(null);
  const [devReasonId, setDevReasonId] = useState("");
  const [devNote, setDevNote] = useState("");
  const [devOvertime, setDevOvertime] = useState<OvertimeCompensation>("payout");
  // pickOperations: the operation list and its station/material/sort/search state.
  const [stationIds, setStationIds] = useState<string[]>([]);
  const [materialId, setMaterialId] = useState("");
  const [sort, setSort] = useState<TerminalSort>("planned");
  const [onlyReady, setOnlyReady] = useState(false);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<TerminalOperation[]>([]);
  const [materials, setMaterials] = useState<TerminalMaterial[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const listRequest = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // Live clock + elapsed tickers.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Shared terminal: any pause mid-flow returns to the keypad so the next
  // person never acts as someone else.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetToKeypad = useCallback(() => {
    setStep({ name: "keypad" });
    setEntry("");
    setError(null);
    setNote("");
    setMarkDone(false);
    setAtfHours("");
    setForgottenStop("");
    setDevReasonId("");
    setDevNote("");
    setDevOvertime("payout");
    setSelectedOperationIds(new Set());
    setStationIds([]);
    setMaterialId("");
    setSort("planned");
    setOnlyReady(false);
    setSearch("");
    setRows([]);
    setMaterials([]);
    setListError(null);
  }, []);
  // What the idle timeout does — normally back to the keypad, but after Ta
  // ut ATF the withdrawal is already registered, so the deviation step
  // finishes the stop with the defaults first (set further down, where the
  // request functions exist; read through a ref so the timer sees the
  // latest state).
  const onIdleRef = useRef<() => void>(resetToKeypad);
  const onIdle = useCallback(() => onIdleRef.current(), []);
  useEffect(() => {
    if (step.name === "keypad") return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(onIdle, IDLE_RESET_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [
    step,
    entry,
    note,
    markDone,
    search,
    stationIds,
    materialId,
    sort,
    onlyReady,
    selectedOperationIds,
    devReasonId,
    devNote,
    devOvertime,
    onIdle,
  ]);

  // Browsing a long operation list (scroll/touch) counts as activity, so the
  // operator isn't sent back to the keypad mid-scroll.
  const listActive = step.name === "pickOperations";
  useEffect(() => {
    if (!listActive) return;
    const bump = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(onIdle, IDLE_RESET_MS);
    };
    const events = ["scroll", "pointerdown", "touchmove", "wheel", "keydown"] as const;
    events.forEach((name) => window.addEventListener(name, bump, { passive: true, capture: true }));
    return () => events.forEach((name) => window.removeEventListener(name, bump, { capture: true }));
  }, [listActive, onIdle]);

  const refresh = useCallback(async () => {
    const [sessions, attendance] = await Promise.all([
      apiFetch<StampSession[]>("/api/v1/stamp-sessions?open=true"),
      apiFetch<AttendanceSession[]>("/api/v1/attendance-sessions?open=true"),
    ]);
    setOpenSessions(sessions);
    setOpenAttendance(attendance);
    return { sessions, attendance };
  }, []);

  // Load the operation list when the view opens and when station/material
  // change. A sequence number makes a late response harmless.
  const inOperationList = step.name === "pickOperations";
  useEffect(() => {
    if (!inOperationList) return;
    const seq = ++listRequest.current;
    const params = new URLSearchParams();
    if (stationIds.length > 0) params.set("workCenterIds", stationIds.join(","));
    if (materialId) params.set("materialArticleId", materialId);
    const query = params.toString();
    setListLoading(true);
    setListError(null);
    apiFetch<{ rows: TerminalOperation[]; materials: TerminalMaterial[] }>(
      `/api/v1/terminal/operations${query ? `?${query}` : ""}`
    )
      .then((res) => {
        if (seq !== listRequest.current) return;
        setRows(res.rows);
        setMaterials(res.materials);
        // The material list follows the station filter: a chosen material
        // that dropped out would otherwise stay applied with no option shown.
        if (materialId && !res.materials.some((m) => m.articleId === materialId)) setMaterialId("");
        // Drop selections that are no longer listed.
        const listed = new Set(res.rows.map((r) => r.operationId));
        setSelectedOperationIds((prev) => new Set([...prev].filter((id) => listed.has(id))));
      })
      .catch((err) => {
        if (seq !== listRequest.current) return;
        setListError(apiErrorMessage(err, "Kunde inte hämta operationer."));
      })
      .finally(() => {
        if (seq === listRequest.current) setListLoading(false);
      });
  }, [inOperationList, stationIds, materialId, reloadKey]);

  // Badge scanners type the employee number and send Enter — accept hardware
  // keyboard input on the keypad step.
  useEffect(() => {
    if (step.name !== "keypad") return;
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) setEntry((v) => (v + e.key).slice(0, 10));
      else if (e.key === "Backspace") setEntry((v) => v.slice(0, -1));
      else if (e.key === "Enter") confirmEntry();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function confirmEntry() {
    if (busy) return;
    const employee = employees.find(
      (e) => e.employeeNumber === entry || e.employeeNumber.replace(/\D/g, "") === entry
    );
    if (!employee) {
      setError(entry ? `Inget anställningsnummer matchar ${entry}.` : "Knappa in ditt anställningsnummer.");
      setEntry("");
      return;
    }
    setError(null);
    setEntry("");
    // Fresh lists before deciding: stamps closed elsewhere (an operation
    // turning done stamps everyone out, regel 10) or attendance fixed in
    // Attestering must not show up stale. On failure the cached lists do.
    let attendance = openAttendance;
    setBusy(true);
    try {
      attendance = (await refresh()).attendance;
    } catch {
      // keep the cached lists
    } finally {
      setBusy(false);
    }
    const open = attendance.find((a) => a.employeeId === employee.id);
    if (open && stockholmDay(open.startedAt) < stockholmDay(Date.now())) {
      void openForgotten(employee, open.id, open.startedAt);
      return;
    }
    setStep({ name: "home", employee });
  }

  // Rule 8: the attendance has been open since an earlier day — ask when
  // the person went home, prefilled with that day's scheduled end.
  async function openForgotten(employee: EmployeeDirectoryEntry, attendanceId: string, startedAt: string) {
    setBusy(true);
    try {
      const day = stockholmDay(startedAt);
      const calendar = await apiFetch<ResolvedCalendarDay[]>(
        `/api/v1/employees/${employee.id}/schedule-calendar?from=${day}&to=${day}`
      );
      const end = calendar[0]?.daySchedule?.endTime;
      setForgottenStop(end ? `${day}T${end.slice(0, 5)}` : "");
      setError(null);
      setStep({ name: "forgotten", employee, attendanceId, startedAt });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta schemat."));
    } finally {
      setBusy(false);
    }
  }

  async function saveForgotten(employee: EmployeeDirectoryEntry) {
    const stop = new Date(forgottenStop);
    if (forgottenStop === "" || Number.isNaN(stop.getTime())) {
      setError("Ange när du gick hem.");
      return;
    }
    // Closes yesterday's attendance and opens today's in one request — which
    // can need today's sen ankomst reason (attendanceIn asks and resends).
    return attendanceIn(employee, { forgottenStoppedAt: stop.toISOString() });
  }

  // Open the operation list: the employee's own default stations (only those
  // that are real stations — an inactive or lego id is dropped) are
  // preselected; none left means Alla stationer.
  function openOperationList(employee: EmployeeDirectoryEntry) {
    const known = new Set(stations.map((st) => st.id));
    setStationIds((employee.defaultWorkCenterIds ?? []).filter((id) => known.has(id)));
    setMaterialId("");
    setSort("planned");
    setOnlyReady(false);
    setSearch("");
    setSelectedOperationIds(new Set());
    setRows([]);
    setMaterials([]);
    setListError(null);
    setError(null);
    setStep({ name: "pickOperations", employee });
  }

  function toggleOperationSelected(operationId: string) {
    setSelectedOperationIds((prev) => {
      const next = new Set(prev);
      if (next.has(operationId)) next.delete(operationId);
      else next.add(operationId);
      return next;
    });
  }

  // The active Avvikelseorsaker, fetched again on every need. A chosen
  // reason that is no longer offered is unselected.
  async function loadReasons() {
    try {
      const list = await apiFetch<AttendanceDeviationReason[]>("/api/v1/attendance-deviation-reasons");
      setReasons(list);
      setDevReasonId((id) => (list.some((r) => r.id === id) ? id : ""));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta anledningarna."));
    }
  }

  // Open the deviation step from a 409 attendance-input-required body.
  // `answers` are what this request already sent: kept and sent again.
  async function openDeviation(
    employee: EmployeeDirectoryEntry,
    body: AttendanceInputRequiredBody,
    pending: PendingAttendanceAction,
    answers: DeviationAnswers = {},
    errorMessage: string | null = null
  ) {
    setDevReasonId(answers.reason?.reasonId ?? "");
    setDevNote(answers.reason?.note ?? "");
    setDevOvertime(answers.overtimeDisposition ?? body.overtime?.current ?? "payout");
    setError(errorMessage);
    setStep({ name: "deviation", employee, body, pending, answers });
    if (body.reason || answers.reason) await loadReasons();
  }

  // A resend refused because the chosen reason is gone: fresh list, no
  // reason selected, and the message on the deviation step.
  async function reasonInvalid(err: unknown) {
    setDevReasonId("");
    await loadReasons();
    setError(apiErrorMessage(err, "Anledningen finns inte längre — välj en annan."));
  }

  // Send the pending request again with the answers from the deviation step
  // — and the answers given to an earlier question of the same request.
  async function submitDeviation(
    employee: EmployeeDirectoryEntry,
    body: AttendanceInputRequiredBody,
    pending: PendingAttendanceAction,
    answers: DeviationAnswers
  ) {
    if (body.reason && !devReasonId) return;
    const reason: AttendanceReasonInput | undefined = devReasonId
      ? { reasonId: devReasonId, ...(devNote.trim() ? { note: devNote.trim() } : {}) }
      : undefined;
    const overtimeDisposition = body.overtime ? devOvertime : answers.overtimeDisposition;
    if (pending.kind === "attendanceIn") {
      return attendanceIn(employee, { reason, forgottenStoppedAt: pending.forgottenStoppedAt });
    }
    if (pending.kind === "stampIn") {
      return startSelectedOperations(employee, pending.operations, reason, pending.earlierFailed);
    }
    if (pending.kind === "goHome") {
      return goHome(employee, pending.attendanceId, { reason, overtimeDisposition });
    }
    return finishAtf(employee, pending, { reason, overtimeDisposition });
  }

  // "Starta valda": stamps in every checked operation, one POST per
  // operation. A failure on one doesn't roll back the others — those stay
  // stamped in, and the failed ones stay checked in the operation list so
  // the row can be retried. `earlierFailed` are the batch's failures from
  // before a deviation question interrupted it.
  async function startSelectedOperations(
    employee: EmployeeDirectoryEntry,
    operations: TerminalOperation[],
    attendanceReason?: AttendanceReasonInput,
    earlierFailed: TerminalOperation[] = []
  ) {
    if (operations.length === 0) return;
    setBusy(true);
    const failed: TerminalOperation[] = [...earlierFailed];
    let attendanceStarted = false;
    let reasonPending = attendanceReason;
    try {
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i]!;
        try {
          const res = await apiFetch<{ attendanceStarted?: boolean }>("/api/v1/stamp-sessions", {
            method: "POST",
            body: JSON.stringify({
              employeeId: employee.id,
              moOperationId: operation.operationId,
              ...(reasonPending ? { attendanceReason: reasonPending } : {}),
            }),
          });
          reasonPending = undefined;
          if (res?.attendanceStarted === true) attendanceStarted = true;
        } catch (err) {
          // The stamp would start the attendance and the server wants an
          // answer first: ask, then send this and the remaining ones again.
          const required = inputRequiredBody(err);
          if (required) {
            await refresh();
            return void (await openDeviation(
              employee,
              required,
              { kind: "stampIn", operations: operations.slice(i), earlierFailed: failed },
              { reason: reasonPending }
            ));
          }
          // The reason sent with the stamp that opens the attendance is gone:
          // ask again for this and the remaining operations.
          // (Only a resend from the deviation step carries a reason.)
          if (reasonPending && isReasonInvalid(err) && step.name === "deviation") {
            return void (await openDeviation(
              employee,
              step.body,
              { kind: "stampIn", operations: operations.slice(i), earlierFailed: failed },
              {},
              apiErrorMessage(err, "Anledningen finns inte längre — välj en annan.")
            ));
          }
          failed.push(operation);
        }
      }
      await refresh();
      if (failed.length === 0) {
        setSelectedOperationIds(new Set());
        setError(null);
        if (attendanceStarted) setNotice("Närvaron stämplades in.");
        setStep({ name: "home", employee });
      } else {
        // Back to the operation list (also from the deviation step, whose
        // button would otherwise resend operations already started) with
        // only the failed ones checked.
        setSelectedOperationIds(new Set(failed.map((op) => op.operationId)));
        const names = failed.map((op) => `${op.orderNumber} op ${op.sequenceNo}`).join(", ");
        setError(
          failed.length === earlierFailed.length + operations.length
            ? `Instämpling misslyckades: ${names}.`
            : `Instämpling misslyckades för: ${names}. Övriga är instämplade.`
        );
        setStep({ name: "pickOperations", employee });
      }
    } finally {
      setBusy(false);
    }
  }

  async function attendanceIn(
    employee: EmployeeDirectoryEntry,
    answers: { reason?: AttendanceReasonInput; forgottenStoppedAt?: string } = {}
  ) {
    const { reason, forgottenStoppedAt } = answers;
    setBusy(true);
    try {
      await apiFetch("/api/v1/attendance-sessions", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employee.id,
          ...(reason ? { reason } : {}),
          ...(forgottenStoppedAt ? { forgottenStoppedAt } : {}),
        }),
      });
      await refresh();
      setError(null);
      if (forgottenStoppedAt) {
        setNotice(`Närvaron är rättad och du är instämplad igen, ${employee.name.split(" ")[0]}.`);
        setStep({ name: "home", employee });
      } else if (reason) {
        setNotice(`Välkommen ${employee.name.split(" ")[0]} — närvaron är instämplad.`);
        resetToKeypad();
      }
    } catch (err) {
      const required = inputRequiredBody(err);
      if (required) {
        return void (await openDeviation(employee, required, { kind: "attendanceIn", forgottenStoppedAt }, { reason }));
      }
      if (reason && isReasonInvalid(err)) return void (await reasonInvalid(err));
      if (err instanceof ApiError && err.code === "attendance-open-from-earlier-day") {
        const body = err.body as { attendanceSessionId?: string; startedAt?: string } | undefined;
        if (body?.attendanceSessionId && body.startedAt) {
          return void openForgotten(employee, body.attendanceSessionId, body.startedAt);
        }
      }
      setError(
        forgottenStoppedAt && err instanceof ApiError && err.code === "invalid-attendance-interval"
          ? "Ange en tid den dagen du glömde stämpla ut — efter att du kom och före midnatt."
          : apiErrorMessage(err, forgottenStoppedAt ? "Kunde inte spara tiden." : "Närvarostämplingen misslyckades.")
      );
    } finally {
      setBusy(false);
    }
  }

  // Gå hem: stops the attendance session; open work stays stamped in but
  // pauses — the away time is excluded from reported hours, and the work
  // resumes at the next attendance-in. Also the forgotten view's Gå hem nu:
  // worked past midnight, so the attendance open since yesterday stops now.
  async function goHome(employee: EmployeeDirectoryEntry, attendanceId: string, answers?: AttendanceOutInput) {
    setBusy(true);
    try {
      const result = await apiFetch<{ pausedWorkSessions: number }>(
        `/api/v1/attendance-sessions/${attendanceId}/stop`,
        { method: "POST", ...(answers ? { body: JSON.stringify(answers) } : {}) }
      );
      await refresh();
      setError(null);
      setNotice(
        result.pausedWorkSessions === 0
          ? `Hej då ${employee.name.split(" ")[0]} — närvaron är utstämplad.`
          : `Hej då ${employee.name.split(" ")[0]} — närvaron är utstämplad och ${
              result.pausedWorkSessions === 1 ? "1 pågående arbete pausades" : `${result.pausedWorkSessions} pågående arbeten pausades`
            } tills du stämplar in igen.`
      );
      resetToKeypad();
    } catch (err) {
      const required = inputRequiredBody(err);
      if (required) return void (await openDeviation(employee, required, { kind: "goHome", attendanceId }, answers ?? {}));
      if (answers?.reason && isReasonInvalid(err)) return void (await reasonInvalid(err));
      setError(apiErrorMessage(err, "Utstämplingen misslyckades."));
    } finally {
      setBusy(false);
    }
  }

  // ATF-uttag från terminalen: fetch the balance and today's scheduled net
  // time (prefill), then register the withdrawal — and stop the attendance
  // session if one is open ("går hem på ATF").
  async function openAtf(employee: EmployeeDirectoryEntry) {
    setBusy(true);
    try {
      const today = new Date().toLocaleDateString("sv-SE");
      const [atf, calendar] = await Promise.all([
        apiFetch<AtfStatus>(`/api/v1/employees/${employee.id}/atf`),
        apiFetch<ResolvedCalendarDay[]>(
          `/api/v1/employees/${employee.id}/schedule-calendar?from=${today}&to=${today}`
        ),
      ]);
      const scheduledMinutes = calendar[0]?.daySchedule?.netMinutes ?? null;
      setAtfHours(scheduledMinutes ? String(scheduledMinutes / 60).replace(".", ",") : "");
      setError(null);
      setStep({ name: "atf", employee, atf, scheduledMinutes });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta ATF-saldot."));
    } finally {
      setBusy(false);
    }
  }

  async function takeAtf(employee: EmployeeDirectoryEntry, attendance: AttendanceSession | undefined) {
    const hours = Number(atfHours.replace(",", "."));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setError("Ange antal ATF-timmar, t.ex. 2 eller 8,5.");
      return;
    }
    setBusy(true);
    try {
      const transaction = await apiFetch<{ id: string }>(`/api/v1/employees/${employee.id}/atf-transactions`, {
        method: "POST",
        body: JSON.stringify({
          date: new Date().toLocaleDateString("sv-SE"),
          type: "withdrawal",
          minutes: Math.round(hours * 60),
          note: "ATF via stämpelterminalen",
        }),
      });
      if (!attendance) {
        await refresh();
        setNotice(`${formatHours(Math.round(hours * 60))} ATF uttaget för ${employee.name.split(" ")[0]}.`);
        resetToKeypad();
        return;
      }
      await finishAtf(employee, { kind: "atf", attendanceId: attendance.id, atfTransactionId: transaction.id, hours });
    } catch (err) {
      setError(apiErrorMessage(err, "ATF-uttaget misslyckades."));
    } finally {
      setBusy(false);
    }
  }

  // Second half of Ta ut ATF: stop the attendance. The withdrawal explains
  // leaving early (the server never asks for a reason on a day with one;
  // the id is still sent for older servers), but overtime can be asked.
  async function finishAtf(
    employee: EmployeeDirectoryEntry,
    pending: Extract<PendingAttendanceAction, { kind: "atf" }>,
    answers?: DeviationAnswers
  ) {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/attendance-sessions/${pending.attendanceId}/stop`, {
        method: "POST",
        body: JSON.stringify({ ...answers, atfTransactionId: pending.atfTransactionId }),
      });
      await refresh();
      setNotice(
        `${formatHours(Math.round(pending.hours * 60))} ATF uttaget för ${employee.name.split(" ")[0]} — närvaron är utstämplad.`
      );
      resetToKeypad();
    } catch (err) {
      const required = inputRequiredBody(err);
      if (required) return void (await openDeviation(employee, required, pending, answers ?? {}));
      if (answers?.reason && isReasonInvalid(err)) return void (await reasonInvalid(err));
      setError(apiErrorMessage(err, "ATF-uttaget misslyckades."));
    } finally {
      setBusy(false);
    }
  }

  // Avbryt — or the idle timeout — on the deviation step after Ta ut ATF:
  // the withdrawal is already registered, so the attendance must not stay
  // open. The stop is completed with the day's current overtime choice (the
  // pre-selected one, not an unsaved toggle) and any reason already given.
  async function completeAtfWithDefaults(
    employee: EmployeeDirectoryEntry,
    body: AttendanceInputRequiredBody,
    pending: Extract<PendingAttendanceAction, { kind: "atf" }>,
    answers: DeviationAnswers
  ) {
    const reason: AttendanceReasonInput | undefined = devReasonId
      ? { reasonId: devReasonId, ...(devNote.trim() ? { note: devNote.trim() } : {}) }
      : answers.reason;
    const overtimeDisposition = body.overtime?.current ?? answers.overtimeDisposition;
    const first = employee.name.split(" ")[0];
    if (busy) return; // a double tap on Avbryt must not stop twice
    setBusy(true);
    try {
      await apiFetch(`/api/v1/attendance-sessions/${pending.attendanceId}/stop`, {
        method: "POST",
        body: JSON.stringify({
          ...(reason ? { reason } : {}),
          ...(overtimeDisposition ? { overtimeDisposition } : {}),
          atfTransactionId: pending.atfTransactionId,
        }),
      });
      try {
        await refresh();
      } catch {
        // keep the cached lists
      }
      resetToKeypad();
      setNotice(`${formatHours(Math.round(pending.hours * 60))} ATF uttaget för ${first} — närvaron är utstämplad.`);
    } catch (err) {
      resetToKeypad();
      setNotice(
        `ATF-uttaget är registrerat, men närvaron kunde inte stämplas ut (${apiErrorMessage(err, "okänt fel")}). Tryck Gå hem.`
      );
    } finally {
      setBusy(false);
    }
  }

  // Every render: the idle timer must act on the latest step and answers.
  useEffect(() => {
    onIdleRef.current = () => {
      if (step.name === "deviation" && step.pending.kind === "atf") {
        void completeAtfWithDefaults(step.employee, step.body, step.pending, step.answers);
      } else {
        resetToKeypad();
      }
    };
  });

  async function stampOut(employee: EmployeeDirectoryEntry, session: StampSession) {
    if (Number(quantityScrapped) > 0 && scrapReasonRegister && scrapReasonId === "") {
      setError("Välj en orsak när kasserat antal är större än 0.");
      return;
    }
    if (Number(quantityScrapped) > 0 && !scrapReasonRegister && scrapReason.trim() === "") {
      setError("Ange en kassationsorsak när kasserat antal är större än 0.");
      return;
    }
    setBusy(true);
    try {
      const stopped = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(`/api/v1/stamp-sessions/${session.id}/stop`, {
          method: "POST",
          body: JSON.stringify({
            note: note.trim() || undefined,
            quantityOk: Number(quantityOk) || 0,
            quantityScrapped: Number(quantityScrapped) || 0,
            ...(Number(quantityScrapped) > 0 && scrapReasonRegister ? { scrapReasonId } : {}),
            scrapReason: scrapReason.trim() || undefined,
            markOperationDone: markDone,
            allowMaterialShortage,
          }),
        })
      );
      // Declined "Rapportera ändå?": stay on the stamp-out step, nothing sent.
      if (stopped === null) return;
      // Pallkort: a stamp-out that reported a quantity auto-opens the pallet
      // card for exactly that quantity (best effort — a popup blocker may
      // stop it). A stamp-out without a quantity opens nothing.
      const reportedOk = Number(quantityOk) || 0;
      if (reportedOk > 0) {
        const reportId = (stopped as { reportId?: string | null } | undefined)?.reportId ?? null;
        window.open(
          reportId
            ? `/api/v1/manufacturing-orders/${session.manufacturingOrderId}/reports/${reportId}/pallet-card`
            : `/api/v1/manufacturing-orders/${session.manufacturingOrderId}/operations/${session.moOperationId}/pallet-card?quantity=${reportedOk}`,
          "_blank",
          "noopener"
        );
      }
      await refresh();
      setNote("");
      setMarkDone(false);
      setQuantityOk("");
      setQuantityScrapped("");
      setScrapReason("");
      setScrapReasonId("");
      setError(null);
      setStep({ name: "home", employee });
    } catch (err) {
      if (err instanceof ApiError && err.code === "stamp-session-already-stopped") {
        // Stamped out elsewhere (regel 10) while this view was open: show
        // the current stamps instead of the stale one.
        try {
          await refresh();
        } catch {
          // keep the cached lists
        }
        setNote("");
        setMarkDone(false);
        setQuantityOk("");
        setQuantityScrapped("");
        setScrapReason("");
        setScrapReasonId("");
        setStep({ name: "home", employee });
      }
      setError(apiErrorMessage(err, "Utstämplingen misslyckades."));
    } finally {
      setBusy(false);
    }
  }

  const clock = new Date(now).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const visibleRows =
    step.name === "pickOperations"
      ? sortTerminalOperations(filterTerminalOperations(rows, { onlyReady, search }), sort)
      : [];

  return (
    <div className={styles.terminal}>
      <header className={styles.header}>
        <Wordmark height={26} />
        <span className={styles.headerTitle}>Stämpelterminal</span>
        <span className={`${styles.clock} num`}>{clock}</span>
        <Link href="/tillverkning" className={styles.exitLink}>
          Till systemet
        </Link>
      </header>

      {error && step.name !== "pickOperations" && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}

      <main className={styles.stage}>
        {step.name === "keypad" && (
          <section className={styles.keypadStep} aria-label="Ange anställningsnummer">
            <div className={styles.prompt}>Knappa in ditt anställningsnummer</div>
            <div className={`${styles.entry} num`} aria-live="polite">
              {entry || <span className={styles.entryPlaceholder}>—</span>}
            </div>
            <div className={styles.keypad}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.key} ${key === "OK" ? styles.keyOk : ""}`}
                  onClick={() => {
                    setNotice(null);
                    if (key === "OK") confirmEntry();
                    else if (key === "⌫") setEntry((v) => v.slice(0, -1));
                    else setEntry((v) => (v + key).slice(0, 10));
                  }}
                >
                  {key}
                </button>
              ))}
            </div>
            <p className={styles.hint}>
              {openAttendance.length === 0
                ? "Ingen är närvarostämplad just nu."
                : `${openAttendance.length} närvarande: ${openAttendance.map((s) => s.employeeName).join(", ")}`}
            </p>
          </section>
        )}

        {step.name === "home" && (
          <HomeStep
            employee={step.employee}
            sessions={openSessions.filter((s) => s.employeeId === step.employee.id)}
            attendance={openAttendance.find((s) => s.employeeId === step.employee.id)}
            now={now}
            allowMultipleStamps={allowMultipleStamps}
            busy={busy}
            onStampOut={(session) => setStep({ name: "stampOut", employee: step.employee, session })}
            onNewStamp={() => openOperationList(step.employee)}
            onAttendanceIn={() => attendanceIn(step.employee)}
            onGoHome={(attendance) => goHome(step.employee, attendance.id)}
            onAtf={() => openAtf(step.employee)}
            onDone={resetToKeypad}
          />
        )}

        {step.name === "atf" && (
          <section className={styles.listStep} aria-label="ATF-uttag">
            <div className={styles.prompt}>
              ATF-uttag <span className={`${styles.promptMeta} num`}>({step.employee.name})</span>
            </div>
            <div className={styles.summary}>
              <div className={styles.summaryLine}>
                Saldo: <span className="num">{formatHours(step.atf.balanceMinutes)}</span>
              </div>
              <div className={styles.summarySecondary}>
                {step.atf.mode === "weekly"
                  ? "Veckouttag — intjäningen kvittas löpande via schemat."
                  : step.scheduledMinutes !== null
                    ? `Schemalagd tid idag: ${formatHours(step.scheduledMinutes)} (förifyllt).`
                    : "Ingen schemalagd tid idag."}
              </div>
            </div>
            <input
              className={styles.note}
              type="text"
              inputMode="decimal"
              aria-label="ATF-timmar"
              placeholder="Antal timmar, t.ex. 2 eller 8,5"
              value={atfHours}
              onChange={(e) => setAtfHours(e.target.value)}
            />
            <p className={styles.hint}>
              {openAttendance.some((s) => s.employeeId === step.employee.id)
                ? "Din närvarostämpling stämplas ut samtidigt."
                : "Uttaget registreras på dagens datum."}
            </p>
            <button
              type="button"
              className={styles.bigAction}
              disabled={busy}
              onClick={() => takeAtf(step.employee, openAttendance.find((s) => s.employeeId === step.employee.id))}
            >
              Ta ut ATF
            </button>
            <BackRow onBack={() => setStep({ name: "home", employee: step.employee })} />
          </section>
        )}

        {step.name === "forgotten" && (
          <section className={styles.listStep} aria-label="Glömd utstämpling">
            <div className={styles.prompt}>
              Du stämplade aldrig ut{" "}
              {new Date(step.startedAt).toLocaleDateString("sv-SE", {
                weekday: "long",
                day: "numeric",
                month: "long",
                timeZone: "Europe/Stockholm",
              })}
              . När gick du hem?
            </div>
            <input
              type="datetime-local"
              className={styles.note}
              value={forgottenStop}
              min={toDateTimeLocalValue(step.startedAt)}
              max={`${stockholmDay(step.startedAt)}T23:59`}
              onChange={(e) => setForgottenStop(e.target.value)}
              aria-label="När du gick hem"
            />
            <button type="button" className={styles.bigAction} disabled={busy} onClick={() => saveForgotten(step.employee)}>
              Spara och stämpla in
            </button>
            <button
              type="button"
              className={styles.attendanceButton}
              disabled={busy}
              onClick={() => goHome(step.employee, step.attendanceId)}
            >
              Gå hem nu
            </button>
            <BackRow label="Avbryt" onBack={resetToKeypad} />
          </section>
        )}

        {step.name === "deviation" && (
          <DeviationStep
            body={step.body}
            pending={step.pending}
            reasons={reasons}
            reasonId={devReasonId}
            onReasonId={setDevReasonId}
            note={devNote}
            onNote={setDevNote}
            overtime={devOvertime}
            onOvertime={setDevOvertime}
            busy={busy}
            onSubmit={() => submitDeviation(step.employee, step.body, step.pending, step.answers)}
            onCancel={() => {
              if (step.pending.kind === "atf") {
                void completeAtfWithDefaults(step.employee, step.body, step.pending, step.answers);
              } else {
                resetToKeypad();
              }
            }}
          />
        )}

        {step.name === "pickOperations" && (
          <OperationListView
            employee={step.employee}
            stations={stations}
            stationIds={stationIds}
            onStationIds={setStationIds}
            materials={materials}
            materialId={materialId}
            onMaterialId={setMaterialId}
            sort={sort}
            onSort={setSort}
            onlyReady={onlyReady}
            onOnlyReady={setOnlyReady}
            search={search}
            onSearch={setSearch}
            rows={visibleRows}
            totalRows={rows.length}
            loading={listLoading}
            listError={listError}
            onRetry={() => setReloadKey((k) => k + 1)}
            stampedOperationIds={new Set(openSessions.filter((s) => s.employeeId === step.employee.id).map((s) => s.moOperationId))}
            selected={selectedOperationIds}
            onToggle={toggleOperationSelected}
            busy={busy}
            error={error}
            onStart={() =>
              startSelectedOperations(
                step.employee,
                rows.filter((r) => selectedOperationIds.has(r.operationId))
              )
            }
            onBack={() => setStep({ name: "home", employee: step.employee })}
          />
        )}

        {step.name === "stampOut" && (
          <section className={styles.listStep} aria-label="Stämpla ut">
            <div className={styles.prompt}>Stämpla ut</div>
            <div className={styles.summary}>
              <div className={styles.summaryLine}>
                <span className="num">{step.session.manufacturingOrderNumber}</span> · {step.session.articleName}
              </div>
              <div className={styles.summarySecondary}>
                Op <span className="num">{step.session.operationSequenceNo}</span> · {step.session.workCenterName} —{" "}
                <span className="num">{formatElapsed(step.session, now)}</span>
              </div>
              {step.session.packingInstructions && (
                <div className={styles.packingNote}>📦 {step.session.packingInstructions}</div>
              )}
            </div>
            <OperationProgressTiles
              progress={operationProgress(
                step.session.orderQuantity,
                step.session.operationQuantityCompleted,
                step.session.operationQuantityScrapped
              )}
            />
            <div className={styles.quantityRow}>
              <label className={styles.quantityField}>
                Antal OK
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={quantityOk}
                  onChange={(e) => setQuantityOk(e.target.value)}
                  placeholder="0"
                />
              </label>
              <label className={styles.quantityField}>
                Kasserat
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={quantityScrapped}
                  onChange={(e) => setQuantityScrapped(e.target.value)}
                  placeholder="0"
                />
              </label>
            </div>
            {Number(quantityScrapped) > 0 && scrapReasonRegister && (
              <>
                <select
                  className={styles.select}
                  aria-label="Orsak"
                  value={scrapReasonId}
                  onChange={(e) => setScrapReasonId(e.target.value)}
                >
                  <option value="">Orsak (obligatorisk)</option>
                  {scrapReasonOptions!.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <textarea
                  className={styles.note}
                  placeholder="Kommentar (valfritt)"
                  value={scrapReason}
                  onChange={(e) => setScrapReason(e.target.value)}
                  rows={2}
                />
              </>
            )}
            {Number(quantityScrapped) > 0 && !scrapReasonRegister && (
              <textarea
                className={styles.note}
                placeholder="Kassationsorsak (obligatorisk)"
                value={scrapReason}
                onChange={(e) => setScrapReason(e.target.value)}
                rows={2}
              />
            )}
            <textarea
              className={styles.note}
              placeholder="Anteckning (valfritt)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
            <button
              type="button"
              className={styles.toggle}
              data-on={markDone}
              onClick={() => setMarkDone((v) => !v)}
              aria-pressed={markDone}
            >
              <span className={styles.toggleBox} aria-hidden="true" />
              Operationen är klar
            </button>
            <button
              type="button"
              className={styles.bigAction}
              disabled={busy}
              onClick={() => stampOut(step.employee, step.session)}
            >
              Stämpla ut
            </button>
            <BackRow onBack={() => setStep({ name: "home", employee: step.employee })} />
          </section>
        )}
      </main>
    </div>
  );
}

function OperationProgressLine({ progress }: { progress: OperationProgress }) {
  return (
    <span className={styles.choiceSecondary}>
      Planerat <span className="num">{formatQuantity(progress.planned)}</span> · Klart{" "}
      <span className="num">{formatQuantity(progress.ok)}</span>
      {progress.scrapped > 0 && (
        <>
          {" "}
          · Kasserat <span className="num">{formatQuantity(progress.scrapped)}</span>
        </>
      )}{" "}
      · <strong>
        Kvar <span className="num">{formatQuantity(progress.remaining)}</span> st
      </strong>
    </span>
  );
}

// Stamp-out: totals reported on the operation BEFORE this stint, so the
// operator sees how many are left before typing Antal OK.
function OperationProgressTiles({ progress }: { progress: OperationProgress }) {
  const tiles: { label: string; value: number; emphasis?: boolean }[] = [
    { label: "Planerat", value: progress.planned },
    { label: "Klart", value: progress.ok },
    ...(progress.scrapped > 0 ? [{ label: "Kasserat", value: progress.scrapped }] : []),
    { label: "Kvar", value: progress.remaining, emphasis: true },
  ];
  return (
    <dl className={styles.progressTiles} aria-label="Antal på operationen">
      {tiles.map((t) => (
        <div key={t.label} className={styles.progressTile} data-emphasis={t.emphasis ?? false}>
          <dt>{t.label}</dt>
          <dd className="num">{formatQuantity(t.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function HomeStep({
  employee,
  sessions,
  attendance,
  now,
  allowMultipleStamps,
  busy,
  onStampOut,
  onNewStamp,
  onAttendanceIn,
  onGoHome,
  onAtf,
  onDone,
}: {
  employee: EmployeeDirectoryEntry;
  sessions: StampSession[];
  attendance: AttendanceSession | undefined;
  now: number;
  allowMultipleStamps: boolean;
  busy: boolean;
  onStampOut: (session: StampSession) => void;
  onNewStamp: () => void;
  onAttendanceIn: () => void;
  onGoHome: (attendance: AttendanceSession) => void;
  onAtf: () => void;
  onDone: () => void;
}) {
  const canStampIn = allowMultipleStamps || sessions.length === 0;
  return (
    <section className={styles.listStep} aria-label="Dina stämplingar">
      <div className={styles.prompt}>
        {employee.name} <span className={`${styles.promptMeta} num`}>({employee.employeeNumber})</span>
      </div>

      <div className={styles.attendanceCard} data-present={attendance !== undefined}>
        <span className={styles.attendanceText}>
          {attendance ? (
            <>
              Närvarande sedan{" "}
              <span className="num">
                {new Date(attendance.startedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </>
          ) : (
            "Inte närvarostämplad"
          )}
        </span>
        {attendance ? (
          <button type="button" className={styles.attendanceButton} disabled={busy} onClick={() => onGoHome(attendance)}>
            Gå hem
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.attendanceButton} ${styles.attendanceButtonIn}`}
            disabled={busy}
            onClick={onAttendanceIn}
          >
            Stämpla in närvaro
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className={styles.hint}>Du är inte instämplad på något arbete.</p>
      ) : (
        <div className={styles.choiceList}>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`${styles.choice} ${styles.choiceOpen}`}
              disabled={busy}
              onClick={() => onStampOut(session)}
            >
              <span className={styles.choicePrimary}>
                <span className="num">{session.manufacturingOrderNumber}</span> · {session.articleName}
              </span>
              <span className={styles.choiceSecondary}>
                Op <span className="num">{session.operationSequenceNo}</span> · {session.workCenterName} —{" "}
                <span className="num">{formatElapsed(session, now)}</span>
                {session.pausedAt ? " · Pausad" : ""} · Tryck för att stämpla ut
              </span>
            </button>
          ))}
        </div>
      )}

      {canStampIn ? (
        <button type="button" className={styles.bigAction} disabled={busy} onClick={onNewStamp}>
          Stämpla in på arbete
        </button>
      ) : (
        <p className={styles.hint}>Stämpla ut innan du börjar på nästa arbete.</p>
      )}

      <button type="button" className={styles.choice} disabled={busy} onClick={onAtf}>
        <span className={styles.choicePrimary}>Ta ut ATF</span>
        <span className={styles.choiceSecondary}>
          Arbetstidsförkortning — {attendance ? "närvaron stämplas ut samtidigt" : "registreras på dagens datum"}
        </span>
      </button>

      <BackRow label="Klar" onBack={onDone} />
    </section>
  );
}

// Avvikelseorsaker and/or the overtime choice, exactly as the 409 body asks.
function DeviationStep({
  body,
  pending,
  reasons,
  reasonId,
  onReasonId,
  note,
  onNote,
  overtime,
  onOvertime,
  busy,
  onSubmit,
  onCancel,
}: {
  body: AttendanceInputRequiredBody;
  pending: PendingAttendanceAction;
  reasons: AttendanceDeviationReason[] | null;
  reasonId: string;
  onReasonId: (id: string) => void;
  note: string;
  onNote: (note: string) => void;
  overtime: OvertimeCompensation;
  onOvertime: (value: OvertimeCompensation) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const isStop = pending.kind === "goHome" || pending.kind === "atf";
  const heading = body.reason
    ? body.reason.kind === "late"
      ? `Du kom in ${minutesText(body.reason.minutes)} efter schemat (${body.reason.scheduledTime})`
      : `Du går ${minutesText(body.reason.minutes)} före schemat (${body.reason.scheduledTime})`
    : null;
  return (
    <section className={styles.listStep} aria-label="Anledning och övertid">
      {heading && (
        <>
          <div className={styles.prompt}>{heading}</div>
          <div className={styles.choiceList} role="radiogroup" aria-label="Anledning">
            {reasons === null && <p className={styles.hint}>Hämtar anledningar…</p>}
            {reasons?.length === 0 && <p className={styles.hint}>Det finns inga anledningar. Be en administratör lägga till dem.</p>}
            {reasons?.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={reasonId === r.id}
                className={`${styles.choice} ${reasonId === r.id ? styles.choiceSelected : ""}`}
                disabled={busy}
                onClick={() => onReasonId(r.id)}
              >
                <span className={styles.choicePrimary}>{r.name}</span>
              </button>
            ))}
          </div>
          <input
            className={styles.note}
            type="text"
            maxLength={500}
            aria-label="Kommentar (valfritt)"
            placeholder="Kommentar (valfritt)"
            value={note}
            onChange={(e) => onNote(e.target.value)}
          />
        </>
      )}
      {body.overtime && (
        <>
          <div className={styles.prompt}>Du har arbetat {durationText(body.overtime.minutes)} övertid i dag</div>
          <div className={styles.choiceList} role="radiogroup" aria-label="Övertidsersättning">
            {([
              ["payout", "Övertid utbetald"],
              ["comp", "Övertid sparad"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={overtime === value}
                className={`${styles.choice} ${overtime === value ? styles.choiceSelected : ""}`}
                disabled={busy}
                onClick={() => onOvertime(value)}
              >
                <span className={styles.choicePrimary}>{label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        className={styles.bigAction}
        disabled={busy || (body.reason !== null && reasonId === "")}
        onClick={onSubmit}
      >
        {isStop ? "Spara och gå hem" : "Spara och stämpla in"}
      </button>
      <BackRow label="Avbryt" onBack={onCancel} />
    </section>
  );
}

function BackRow({ label = "Tillbaka", onBack }: { label?: string; onBack: () => void }) {
  return (
    <button type="button" className={styles.backButton} onClick={onBack}>
      {label}
    </button>
  );
}

// Compact station filter: one button that summarises the choice and opens a
// panel (centered on desktop, bottom sheet on a phone). The panel edits a
// draft; Klar applies it in one go (one refetch), Esc/backdrop discard.
const SEARCH_THRESHOLD = 8;

function stationSummary(stations: TerminalStation[], ids: string[]) {
  const chosen = stations.filter((st) => ids.includes(st.id));
  if (chosen.length === 0) return "Alla stationer";
  const label = (st: TerminalStation) => `${st.code} ${st.name}`;
  const head = chosen.slice(0, 2).map(label).join(", ");
  return chosen.length > 2 ? `${head} +${chosen.length - 2}` : head;
}

function StationPicker({
  stations,
  stationIds,
  defaultStationIds,
  onApply,
}: {
  stations: TerminalStation[];
  stationIds: string[];
  defaultStationIds: string[];
  onApply: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const known = new Set(stations.map((st) => st.id));
  const mine = defaultStationIds.filter((id) => known.has(id));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown =
    words.length === 0
      ? stations
      : stations.filter((st) => {
          const hay = `${st.code} ${st.name}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });

  function openPanel() {
    setDraft(stationIds);
    setQuery("");
    setOpen(true);
  }
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }
  function apply() {
    onApply(draft);
    close();
  }
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <div className={styles.filterGroup}>
      <span className={styles.filterLabel}>Station</span>
      <button
        ref={triggerRef}
        type="button"
        className={styles.stationTrigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Station: ${stationSummary(stations, stationIds)}`}
        onClick={openPanel}
      >
        <span className={styles.stationSummary}>{stationSummary(stations, stationIds)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className={styles.stationBackdrop}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={panelRef}
            className={styles.stationPanel}
            role="dialog"
            aria-modal="true"
            aria-label="Station"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <div className={styles.stationPanelHead}>
              <span className={styles.stationPanelTitle}>Station</span>
              <button type="button" className={styles.stationDone} onClick={apply}>
                Klar
              </button>
            </div>
            <div className={styles.stationShortcuts}>
              {mine.length > 0 && (
                <button type="button" className={styles.stationButton} onClick={() => setDraft(mine)}>
                  Mina stationer
                </button>
              )}
              <button type="button" className={styles.stationButton} onClick={() => setDraft([])}>
                Alla stationer
              </button>
            </div>
            {stations.length > SEARCH_THRESHOLD && (
              <input
                className={styles.search}
                type="search"
                aria-label="Sök station"
                placeholder="Sök station"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div className={styles.stationList}>
              {shown.length === 0 && <p className={styles.hint}>Ingen station matchar.</p>}
              {shown.map((st) => {
                const checked = draft.includes(st.id);
                return (
                  <label key={st.id} className={styles.choiceCheckRow} data-checked={checked}>
                    <input
                      type="checkbox"
                      className={styles.choiceCheckbox}
                      checked={checked}
                      onChange={() =>
                        setDraft(checked ? draft.filter((x) => x !== st.id) : [...draft, st.id])
                      }
                    />
                    <span className={styles.choicePrimary}>
                      <span className="num">{st.code}</span> · {st.name}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OperationListView({
  employee,
  stations,
  stationIds,
  onStationIds,
  materials,
  materialId,
  onMaterialId,
  sort,
  onSort,
  onlyReady,
  onOnlyReady,
  search,
  onSearch,
  rows,
  totalRows,
  loading,
  listError,
  onRetry,
  stampedOperationIds,
  selected,
  onToggle,
  busy,
  error,
  onStart,
  onBack,
}: {
  employee: EmployeeDirectoryEntry;
  stations: TerminalStation[];
  stationIds: string[];
  onStationIds: (ids: string[]) => void;
  materials: TerminalMaterial[];
  materialId: string;
  onMaterialId: (id: string) => void;
  sort: TerminalSort;
  onSort: (sort: TerminalSort) => void;
  onlyReady: boolean;
  onOnlyReady: (v: boolean) => void;
  search: string;
  onSearch: (v: string) => void;
  rows: TerminalOperation[];
  totalRows: number;
  loading: boolean;
  listError: string | null;
  onRetry: () => void;
  stampedOperationIds: Set<string>;
  selected: Set<string>;
  onToggle: (operationId: string) => void;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onBack: () => void;
}) {
  const today = stockholmToday();
  const readinessStatus: Record<TerminalOperation["readiness"], Status> = {
    ready: "done",
    partial: "delayed",
    not_ready: "stopped",
  };
  return (
    <section className={styles.listStep} aria-label="Välj operationer">
      <div className={styles.prompt}>Välj operationer</div>

      <div className={styles.filterBar}>
        <StationPicker
          stations={stations}
          stationIds={stationIds}
          defaultStationIds={employee.defaultWorkCenterIds ?? []}
          onApply={onStationIds}
        />
        <label className={styles.filterGroup}>
          <span className={styles.filterLabel}>Material</span>
          <select className={styles.select} value={materialId} onChange={(e) => onMaterialId(e.target.value)}>
            <option value="">Alla material</option>
            {materials.map((m) => (
              <option key={m.articleId} value={m.articleId}>
                {m.articleNumber} · {m.articleName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.filterRow}>
        <SegmentedToggle
          ariaLabel="Sortering"
          value={sort}
          onChange={onSort}
          options={[
            { value: "planned", label: "Planerad vecka" },
            { value: "urgent", label: "Brådskande" },
            { value: "material", label: "Material" },
          ]}
        />
        <label className={styles.onlyReady}>
          <input type="checkbox" checked={onlyReady} onChange={(e) => onOnlyReady(e.target.checked)} />
          Bara redo
        </label>
      </div>

      {/* No autoFocus: on a tablet terminal that would pop the on-screen keyboard. */}
      <input
        className={styles.search}
        type="search"
        aria-label="Sök"
        placeholder="Sök TO, artikel, resurs, material"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />

      {listError ? (
        <div className={styles.listError} role="alert">
          {listError}
          <button type="button" className={styles.attendanceButton} onClick={onRetry}>
            Försök igen
          </button>
        </div>
      ) : loading && totalRows === 0 ? (
        <p className={styles.hint}>Hämtar operationer…</p>
      ) : rows.length === 0 ? (
        <p className={styles.hint}>Inga operationer matchar.</p>
      ) : (
        <div className={styles.choiceList}>
          {loading && <p className={styles.hint}>Hämtar operationer…</p>}
          {rows.map((op) => {
            const stamped = stampedOperationIds.has(op.operationId);
            const checked = selected.has(op.operationId);
            const overdue = op.dueDate !== null && op.dueDate.slice(0, 10) < today;
            return (
              <label key={op.operationId} className={styles.choiceCheckRow} data-checked={checked} data-disabled={stamped}>
                <input
                  type="checkbox"
                  className={styles.choiceCheckbox}
                  checked={checked}
                  disabled={busy || stamped}
                  onChange={() => onToggle(op.operationId)}
                />
                <span className={styles.choiceCheckText}>
                  <span className={styles.choicePrimary}>
                    <span className="num">{op.orderNumber}</span> · <span className="num">{op.articleNumber}</span>{" "}
                    {op.articleName}
                  </span>
                  <span className={styles.choiceSecondary}>
                    Op <span className="num">{op.sequenceNo}</span> · {op.description ?? op.workCenterName} ·{" "}
                    <span className="num">{op.workCenterCode}</span> · {op.workCenterName}
                  </span>
                  <OperationProgressLine progress={operationProgress(op.orderQuantity, op.quantityCompleted, op.quantityScrapped)} />
                  <span className={styles.rowMeta}>
                    <StatusPill status={readinessStatus[op.readiness]} label={readinessLabel(op)} compact />
                    {op.dueDate && (
                      <span className={styles.dueDate} data-overdue={overdue}>
                        Färdigdatum <span className="num">{formatStockholmDate(op.dueDate)}</span>
                        {overdue && <span className={styles.visuallyHidden}> Försenad</span>}
                      </span>
                    )}
                    {plannedWeekLabel(op.plannedStartWeek, op.plannedEndWeek) && (
                      <span className={styles.dueDate}>
                        Planerad <span className="num">{plannedWeekLabel(op.plannedStartWeek, op.plannedEndWeek)}</span>
                      </span>
                    )}
                    {stamped && <span className={styles.choiceSecondary}>Du är instämplad</span>}
                  </span>
                  {op.materials.length > 0 && (
                    <span className={styles.choiceSecondary}>
                      {op.materials.map((m) => `${m.articleNumber} · ${m.articleName}`).join(", ")}
                    </span>
                  )}
                  {op.packingInstructions && <span className={styles.choiceSecondary}>📦 {op.packingInstructions}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {/* Sticky so the action and a start failure stay in view below a long list. */}
      <div className={styles.actionBar}>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button type="button" className={styles.bigAction} disabled={busy || selected.size === 0} onClick={onStart}>
          Starta valda{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
        <BackRow onBack={onBack} />
      </div>
    </section>
  );
}

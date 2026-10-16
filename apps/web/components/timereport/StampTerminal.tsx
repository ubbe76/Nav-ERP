"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Wordmark } from "../ui/Wordmark";
import { ApiError, apiFetch } from "../../lib/api";
import { formatStockholmDate, stockholmToday, toDateTimeLocalValue } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import type {
  AtfStatus,
  AttendanceSession,
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
import { formatElapsed, formatQuantity, operationProgress, type OperationProgress } from "../../lib/stampSessions";
import { formatHours } from "./SchedulesPageClient";
import styles from "./StampTerminal.module.css";

type Step =
  | { name: "keypad" }
  | { name: "home"; employee: EmployeeDirectoryEntry }
  | { name: "pickOperations"; employee: EmployeeDirectoryEntry }
  | { name: "stampOut"; employee: EmployeeDirectoryEntry; session: StampSession }
  | { name: "atf"; employee: EmployeeDirectoryEntry; atf: AtfStatus; scheduledMinutes: number | null }
  | { name: "forgotten"; employee: EmployeeDirectoryEntry; attendanceId: string; startedAt: string };

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
  const [atfHours, setAtfHours] = useState("");
  const [forgottenStop, setForgottenStop] = useState("");
  // pickOperations: the operation list and its station/material/sort/search state.
  const [stationIds, setStationIds] = useState<string[]>([]);
  const [materialId, setMaterialId] = useState("");
  const [sort, setSort] = useState<TerminalSort>("urgent");
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
    setSelectedOperationIds(new Set());
    setStationIds([]);
    setMaterialId("");
    setSort("urgent");
    setOnlyReady(false);
    setSearch("");
    setRows([]);
    setMaterials([]);
    setListError(null);
  }, []);
  useEffect(() => {
    if (step.name === "keypad") return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(resetToKeypad, IDLE_RESET_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [step, entry, note, markDone, search, stationIds, materialId, sort, onlyReady, selectedOperationIds, resetToKeypad]);

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
    setBusy(true);
    try {
      await apiFetch("/api/v1/attendance-sessions", {
        method: "POST",
        body: JSON.stringify({ employeeId: employee.id, forgottenStoppedAt: stop.toISOString() }),
      });
      await refresh();
      setError(null);
      setNotice(`Närvaron är rättad och du är instämplad igen, ${employee.name.split(" ")[0]}.`);
      setStep({ name: "home", employee });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid-attendance-interval"
          ? "Ange en tid den dagen du glömde stämpla ut — efter att du kom och före midnatt."
          : apiErrorMessage(err, "Kunde inte spara tiden.")
      );
    } finally {
      setBusy(false);
    }
  }

  // Open the operation list: the employee's own default stations (only those
  // that are real stations — an inactive or lego id is dropped) are
  // preselected; none left means Alla stationer.
  function openOperationList(employee: EmployeeDirectoryEntry) {
    const known = new Set(stations.map((st) => st.id));
    setStationIds((employee.defaultWorkCenterIds ?? []).filter((id) => known.has(id)));
    setMaterialId("");
    setSort("urgent");
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

  // "Starta valda": stamps in every checked operation, one POST per
  // operation. A failure on one doesn't roll back the others — those stay
  // stamped in, and the failed ones stay checked so the row can be retried.
  async function startSelectedOperations(employee: EmployeeDirectoryEntry, operations: TerminalOperation[]) {
    if (operations.length === 0) return;
    setBusy(true);
    const failed: TerminalOperation[] = [];
    let attendanceStarted = false;
    try {
      for (const operation of operations) {
        try {
          const res = await apiFetch<{ attendanceStarted?: boolean }>("/api/v1/stamp-sessions", {
            method: "POST",
            body: JSON.stringify({ employeeId: employee.id, moOperationId: operation.operationId }),
          });
          if (res?.attendanceStarted === true) attendanceStarted = true;
        } catch {
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
        setSelectedOperationIds(new Set(failed.map((op) => op.operationId)));
        const names = failed.map((op) => `${op.orderNumber} op ${op.sequenceNo}`).join(", ");
        setError(
          failed.length === operations.length
            ? `Instämpling misslyckades: ${names}.`
            : `Instämpling misslyckades för: ${names}. Övriga är instämplade.`
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function attendanceIn(employee: EmployeeDirectoryEntry) {
    setBusy(true);
    try {
      await apiFetch("/api/v1/attendance-sessions", {
        method: "POST",
        body: JSON.stringify({ employeeId: employee.id }),
      });
      await refresh();
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "attendance-open-from-earlier-day") {
        const body = err.body as { attendanceSessionId?: string; startedAt?: string } | undefined;
        if (body?.attendanceSessionId && body.startedAt) {
          return void openForgotten(employee, body.attendanceSessionId, body.startedAt);
        }
      }
      setError(err instanceof Error ? err.message : "Närvarostämplingen misslyckades.");
    } finally {
      setBusy(false);
    }
  }

  // Gå hem: stops the attendance session; open work stays stamped in but
  // pauses — the away time is excluded from reported hours, and the work
  // resumes at the next attendance-in. Also the forgotten view's Gå hem nu:
  // worked past midnight, so the attendance open since yesterday stops now.
  async function goHome(employee: EmployeeDirectoryEntry, attendanceId: string) {
    setBusy(true);
    try {
      const result = await apiFetch<{ pausedWorkSessions: number }>(
        `/api/v1/attendance-sessions/${attendanceId}/stop`,
        { method: "POST" }
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
      setError(err instanceof Error ? err.message : "Kunde inte hämta ATF-saldot.");
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
      await apiFetch(`/api/v1/employees/${employee.id}/atf-transactions`, {
        method: "POST",
        body: JSON.stringify({
          date: new Date().toLocaleDateString("sv-SE"),
          type: "withdrawal",
          minutes: Math.round(hours * 60),
          note: "ATF via stämpelterminalen",
        }),
      });
      let closedAttendance = false;
      if (attendance) {
        await apiFetch(`/api/v1/attendance-sessions/${attendance.id}/stop`, { method: "POST" });
        closedAttendance = true;
      }
      await refresh();
      setNotice(
        `${formatHours(Math.round(hours * 60))} ATF uttaget för ${employee.name.split(" ")[0]}${
          closedAttendance ? " — närvaron är utstämplad." : "."
        }`
      );
      resetToKeypad();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ATF-uttaget misslyckades.");
    } finally {
      setBusy(false);
    }
  }

  async function stampOut(employee: EmployeeDirectoryEntry, session: StampSession) {
    if (Number(quantityScrapped) > 0 && scrapReason.trim() === "") {
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
        window.open(
          `/api/v1/manufacturing-orders/${session.manufacturingOrderId}/operations/${session.moOperationId}/pallet-card?quantity=${reportedOk}`,
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
            {Number(quantityScrapped) > 0 && (
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

function BackRow({ label = "Tillbaka", onBack }: { label?: string; onBack: () => void }) {
  return (
    <button type="button" className={styles.backButton} onClick={onBack}>
      {label}
    </button>
  );
}

function OperationListView({
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
  function toggleStation(id: string) {
    onStationIds(stationIds.includes(id) ? stationIds.filter((s) => s !== id) : [...stationIds, id]);
  }
  return (
    <section className={styles.listStep} aria-label="Välj operationer">
      <div className={styles.prompt}>Välj operationer</div>

      <div className={styles.filterGroup} role="group" aria-label="Station">
        <span className={styles.filterLabel}>Station</span>
        <div className={styles.stationButtons}>
          <button
            type="button"
            className={styles.stationButton}
            data-on={stationIds.length === 0}
            aria-pressed={stationIds.length === 0}
            onClick={() => onStationIds([])}
          >
            Alla stationer
          </button>
          {stations.map((st) => (
            <button
              key={st.id}
              type="button"
              className={styles.stationButton}
              data-on={stationIds.includes(st.id)}
              aria-pressed={stationIds.includes(st.id)}
              onClick={() => toggleStation(st.id)}
            >
              <span className="num">{st.code}</span> · {st.name}
            </button>
          ))}
        </div>
      </div>

      <label className={styles.filterGroup}>
        <span className={styles.filterLabel}>Material</span>
        <select className={styles.select} value={materialId} onChange={(e) => onMaterialId(e.target.value)}>
          <option value="">Alla material</option>
          {materials.map((m) => (
            <option key={m.articleId} value={m.articleId}>
              {m.articleNumber} {m.articleName}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.filterRow}>
        <SegmentedToggle
          ariaLabel="Sortering"
          value={sort}
          onChange={onSort}
          options={[
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
                      </span>
                    )}
                    {stamped && <span className={styles.choiceSecondary}>Du är instämplad</span>}
                  </span>
                  {op.materials.length > 0 && (
                    <span className={styles.choiceSecondary}>
                      {op.materials.map((m) => `${m.articleNumber} ${m.articleName}`).join(", ")}
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

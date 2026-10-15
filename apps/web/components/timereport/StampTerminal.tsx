"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Wordmark } from "../ui/Wordmark";
import { ApiError, apiFetch } from "../../lib/api";
import { toDateTimeLocalValue } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import type {
  AtfStatus,
  AttendanceSession,
  EmployeeDirectoryEntry,
  ManufacturingOrder,
  MOOperation,
  ResolvedCalendarDay,
  StampSession,
} from "../../lib/types";
import { formatElapsed, formatQuantity, operationProgress, type OperationProgress } from "../../lib/stampSessions";
import { formatHours } from "./SchedulesPageClient";
import styles from "./StampTerminal.module.css";

type Step =
  | { name: "keypad" }
  | { name: "home"; employee: EmployeeDirectoryEntry }
  | { name: "pickOrder"; employee: EmployeeDirectoryEntry }
  | { name: "pickOperation"; employee: EmployeeDirectoryEntry; order: ManufacturingOrder; operations: MOOperation[] }
  | { name: "stampOut"; employee: EmployeeDirectoryEntry; session: StampSession }
  | { name: "atf"; employee: EmployeeDirectoryEntry; atf: AtfStatus; scheduledMinutes: number | null }
  | { name: "forgotten"; employee: EmployeeDirectoryEntry; attendanceId: string; startedAt: string };

const IDLE_RESET_MS = 60_000;

// Stockholm calendar day (YYYY-MM-DD), same as dayKey in InProgressPageClient.
function stockholmDay(iso: string | number) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

// Order picker search: every whitespace-separated term must match somewhere
// on the order — TO number, article number/name, or a stampable operation's
// work center (resurs) or production group (produktionsgrupp), by code or
// name. Done and subcontract operations are skipped, matching what the
// operation picker shows: the operator searches for work they can still
// stamp in on, so a resource whose operation is already finished must not
// bring the order up.
function matchesOrderFilter(order: ManufacturingOrder, filter: string): boolean {
  const terms = filter.toLocaleLowerCase("sv-SE").split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    order.orderNumber,
    order.articleNumber,
    order.articleName,
    ...(order.operations ?? [])
      .filter((op) => op.status === "pending" && op.workCenterType !== "subcontract")
      .flatMap((op) => [op.workCenterCode, op.workCenterName, op.productionGroupCode, op.productionGroupName]),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLocaleLowerCase("sv-SE");
  return terms.every((term) => haystack.includes(term));
}

export function StampTerminal({
  employees,
  initialOpenSessions,
  initialOpenAttendance,
  initialOrders,
  allowMultipleStamps,
}: {
  employees: EmployeeDirectoryEntry[];
  initialOpenSessions: StampSession[];
  initialOpenAttendance: AttendanceSession[];
  initialOrders: ManufacturingOrder[];
  allowMultipleStamps: boolean;
}) {
  const [step, setStep] = useState<Step>({ name: "keypad" });
  const [entry, setEntry] = useState("");
  const [openSessions, setOpenSessions] = useState(initialOpenSessions);
  const [openAttendance, setOpenAttendance] = useState(initialOpenAttendance);
  const [orders, setOrders] = useState(initialOrders);
  // pickOrder: free-text filter over the loaded order list (see matchesOrderFilter).
  const [orderFilter, setOrderFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Friendly confirmation shown on the keypad after e.g. going home.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [markDone, setMarkDone] = useState(false);
  // pickOperation: operations checked for the next "Starta valda" batch.
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  // Per-stint quantity report: OK units, scrapped units + mandatory reason.
  const [quantityOk, setQuantityOk] = useState("");
  const [quantityScrapped, setQuantityScrapped] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  const [atfHours, setAtfHours] = useState("");
  const [forgottenStop, setForgottenStop] = useState("");
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
    setOrderFilter("");
  }, []);
  useEffect(() => {
    if (step.name === "keypad") return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(resetToKeypad, IDLE_RESET_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [step, entry, note, markDone, orderFilter, resetToKeypad]);

  const refresh = useCallback(async () => {
    const [sessions, attendance, stampableOrders] = await Promise.all([
      apiFetch<StampSession[]>("/api/v1/stamp-sessions?open=true"),
      apiFetch<AttendanceSession[]>("/api/v1/attendance-sessions?open=true"),
      apiFetch<{ rows: ManufacturingOrder[] }>(
        "/api/v1/manufacturing-orders?status=released,in_progress&limit=1000&withOperations=true"
      ),
    ]);
    setOpenSessions(sessions);
    setOpenAttendance(attendance);
    setOrders(stampableOrders.rows);
    return { sessions, attendance };
  }, []);

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

  async function openOperationPicker(employee: EmployeeDirectoryEntry, order: ManufacturingOrder) {
    setBusy(true);
    try {
      const operations = await apiFetch<MOOperation[]>(`/api/v1/manufacturing-orders/${order.id}/operations`);
      // The endpoint doesn't guarantee routing order. Lego (subcontract)
      // operations are hidden — they are bought via inköpsorder and reported
      // automatically at goods receipt, never stamped on the floor.
      const pending = operations
        .filter((op) => op.status === "pending" && op.workCenterType !== "subcontract")
        .sort((a, b) => a.sequenceNo - b.sequenceNo);
      setSelectedOperationIds(new Set());
      // The filter deliberately survives here: "Tillbaka" from the operation
      // picker returns to the list, and the operator expects their search to
      // still be there when the order turned out to be the wrong one.
      setStep({ name: "pickOperation", employee, order, operations: pending });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte hämta operationer.");
    } finally {
      setBusy(false);
    }
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
  async function startSelectedOperations(employee: EmployeeDirectoryEntry, operations: MOOperation[]) {
    if (operations.length === 0) return;
    setBusy(true);
    const failed: MOOperation[] = [];
    let attendanceStarted = false;
    try {
      for (const operation of operations) {
        try {
          const res = await apiFetch<{ attendanceStarted?: boolean }>("/api/v1/stamp-sessions", {
            method: "POST",
            body: JSON.stringify({ employeeId: employee.id, moOperationId: operation.id }),
          });
          if (res?.attendanceStarted === true) attendanceStarted = true;
        } catch {
          failed.push(operation);
        }
      }
      await refresh();
      if (failed.length === 0) {
        setSelectedOperationIds(new Set());
        setOrderFilter("");
        setError(null);
        if (attendanceStarted) setNotice("Närvaron stämplades in.");
        setStep({ name: "home", employee });
      } else {
        setSelectedOperationIds(new Set(failed.map((op) => op.id)));
        const names = failed.map((op) => `Op ${op.sequenceNo}`).join(", ");
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
  const visibleOrders = orders.filter((order) => matchesOrderFilter(order, orderFilter));

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

      {error && (
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
            onNewStamp={() => setStep({ name: "pickOrder", employee: step.employee })}
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

        {step.name === "pickOrder" && (
          <section className={styles.listStep} aria-label="Välj order">
            <div className={styles.prompt}>Välj order att stämpla in på</div>
            {/* No autoFocus: on a tablet terminal that would pop the on-screen
                keyboard on every visit; whoever wants to search taps the field. */}
            <input
              className={styles.search}
              type="search"
              aria-label="Sök order"
              placeholder="Sök TO-nr, artikel, resurs eller produktionsgrupp"
              value={orderFilter}
              onChange={(e) => setOrderFilter(e.target.value)}
            />
            {orders.length === 0 ? (
              <p className={styles.hint}>Inga frisläppta eller pågående ordrar just nu.</p>
            ) : visibleOrders.length === 0 ? (
              <p className={styles.hint}>Inga ordrar matchar sökningen.</p>
            ) : (
              <div className={styles.choiceList}>
                {visibleOrders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className={styles.orderRow}
                    disabled={busy}
                    onClick={() => openOperationPicker(step.employee, order)}
                  >
                    <span className={`num ${styles.orderRowNumber}`}>{order.orderNumber}</span>
                    <span className={`num ${styles.orderRowMeta}`}>{order.articleNumber}</span>
                    <span className={styles.orderRowName}>{order.articleName}</span>
                    <span className={styles.orderRowMeta}>
                      <span className="num">{Number(order.quantity).toLocaleString("sv-SE")}</span> st
                    </span>
                    <span className={styles.orderRowMeta}>{order.status === "in_progress" ? "Pågår" : "Frisläppt"}</span>
                  </button>
                ))}
              </div>
            )}
            <BackRow
              onBack={() => {
                setOrderFilter("");
                setStep({ name: "home", employee: step.employee });
              }}
            />
          </section>
        )}

        {step.name === "pickOperation" && (
          <section className={styles.listStep} aria-label="Välj operation">
            <div className={styles.prompt}>
              <span className="num">{step.order.orderNumber}</span> — välj operation
            </div>
            {step.operations.length === 0 ? (
              <p className={styles.hint}>Alla operationer på ordern är redan klara.</p>
            ) : (
              <>
                <div className={styles.choiceList}>
                  {step.operations.map((op) => (
                    <label
                      key={op.id}
                      className={styles.choiceCheckRow}
                      data-checked={selectedOperationIds.has(op.id)}
                    >
                      <input
                        type="checkbox"
                        className={styles.choiceCheckbox}
                        checked={selectedOperationIds.has(op.id)}
                        disabled={busy}
                        onChange={() => toggleOperationSelected(op.id)}
                      />
                      {/* The operator's question is "what am I doing?", so the
                          description leads and the resource follows as its code
                          plus name on the secondary line. Without a description
                          the primary line reads exactly as it did before. */}
                      <span className={styles.choiceCheckText}>
                        <span className={styles.choicePrimary}>
                          Op <span className="num">{op.sequenceNo}</span> · {op.description ?? op.workCenterName}
                        </span>
                        <span className={styles.choiceSecondary}>
                          {op.description ? `${op.workCenterCode} · ${op.workCenterName}` : "Markera för att välja"}
                        </span>
                        <OperationProgressLine
                          progress={operationProgress(step.order.quantity, op.quantityCompleted, op.quantityScrapped)}
                        />
                        {op.packingInstructions && (
                          <span className={styles.choiceSecondary}>📦 {op.packingInstructions}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className={styles.bigAction}
                  disabled={busy || selectedOperationIds.size === 0}
                  onClick={() =>
                    startSelectedOperations(
                      step.employee,
                      step.operations.filter((op) => selectedOperationIds.has(op.id))
                    )
                  }
                >
                  Starta valda
                </button>
              </>
            )}
            <BackRow onBack={() => setStep({ name: "pickOrder", employee: step.employee })} />
          </section>
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

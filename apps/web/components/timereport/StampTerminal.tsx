"use client";

import { compressSerialNumbers } from "../../lib/serials";
import { useScrapReasons } from "../../lib/useScrapReasons";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useCanOpen } from "../PermissionsProvider";
import { Wordmark } from "../ui/Wordmark";
import { FileText } from "lucide-react";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import { formatStockholmDate, stockholmToday, toDateTimeLocalValue } from "../../lib/date";
import { apiErrorMessage, shortageList } from "../../lib/errorMessages";
import { formatDuration, parseDuration } from "../../lib/duration";
import { othersStampingOnOperation, stampRestSuggestion } from "../../lib/restSuggestion";
import type {
  AtfStatus,
  AttendanceInputRequiredBody,
  AttendanceOutInput,
  AttendanceReasonInput,
  AttendanceSession,
  AttendanceDeviationReason,
  DrawingFileMeta,
  OvertimeCompensation,
  EmployeeDirectoryEntry,
  ResolvedCalendarDay,
  StampSession,
  TimeKind,
  TerminalMaterial,
  TerminalOperation,
  TerminalStation,
} from "../../lib/types";
import { TIME_KIND_LABELS } from "../../lib/types";
import { StatusPill, type Status } from "../ui/StatusPill";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import {
  filterTerminalOperations,
  forgottenStopNowAllowed,
  readinessLabel,
  sortTerminalOperations,
  splitSelection,
  type TerminalSort,
} from "../../lib/terminalOperations";
import { plannedDateLabel } from "../../lib/planning";
import { formatElapsed, formatQuantity, operationProgress, type OperationProgress } from "../../lib/stampSessions";
import { formatHours } from "./SchedulesPageClient";
import {
  MESSAGES_REFRESH_MS,
  MESSAGE_BODY_MAX,
  TERMINAL_KEYBOARD_ROWS,
  TERMINAL_KEYBOARD_STORAGE_KEY,
  TERMINAL_QUICK_REPLIES,
  applyTerminalKey,
  messageTime,
  terminalKeyboardModeOf,
  terminalKeyboardShiftDefault,
  type BoardConversation,
  type EmployeeUnreadConversation,
  type TerminalKeyboardMode,
} from "../../lib/messages";
import styles from "./StampTerminal.module.css";

type Step =
  | { name: "keypad" }
  // Kräv kod i stämpelterminalen: the employee's own four-digit code, asked
  // for after the anställningsnummer and before anything of the employee's
  // opens. "choose" then "repeat" the first time (no code chosen yet).
  | { name: "pin"; employee: EmployeeDirectoryEntry; mode: "enter" | "choose" | "repeat"; first?: string }
  | { name: "home"; employee: EmployeeDirectoryEntry }
  | { name: "pickOperations"; employee: EmployeeDirectoryEntry }
  | { name: "stampOut"; employee: EmployeeDirectoryEntry; session: StampSession }
  | { name: "atf"; employee: EmployeeDirectoryEntry; atf: AtfStatus; scheduledMinutes: number | null }
  | { name: "forgotten"; employee: EmployeeDirectoryEntry; attendanceId: string; startedAt: string }
  // Meddelanden till den anställde: shown right after the anställningsnummer,
  // before the stamp choices. `proceed` opens what the number would have
  // opened without them (the home view, or the forgotten stamp-out).
  | { name: "messages"; employee: EmployeeDirectoryEntry; unread: EmployeeUnreadConversation[]; proceed: () => void }
  // Svara: the employee's own reply in one of those conversations, written
  // from the messages step. Back (or a sent reply) returns there.
  | {
      name: "reply";
      employee: EmployeeDirectoryEntry;
      unread: EmployeeUnreadConversation[];
      proceed: () => void;
      conversation: EmployeeUnreadConversation;
    }
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
  | { kind: "stampIn"; operations: TerminalOperation[]; earlierFailed: TerminalOperation[]; timeKind?: TimeKind }
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

// Terminalens gamla lista: the operation was switched to another resource
// (Byt resurs) after the list was loaded — the stamp names the listed
// station and the server refuses it.
function isWorkCenterChanged(err: unknown) {
  return err instanceof ApiError && err.code === "stamp-work-center-changed";
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

// Terminalkod: the code's length, the header its bevistoken travels in (as
// TERMINAL_PIN_HEADER in shared) and how long before the token runs out the
// terminal returns to the keypad on its own.
const PIN_LENGTH = 4;
const PIN_HEADER = "X-Terminal-Pin-Token";
const PIN_EXPIRY_MARGIN_MS = 30_000;
const PIN_PROMPTS = { enter: "Ange din kod", choose: "Välj en kod", repeat: "Upprepa koden" } as const;

function lockedText(lockedUntil: string) {
  const time = new Date(lockedUntil).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
  return `För många felaktiga försök — koden är spärrad till kl. ${time}. Försök igen då, eller be en administratör nollställa koden.`;
}

// Skärmtangentbordets named keys: what stands on them and what they are called.
const KEYBOARD_KEY_FACES: Record<string, string> = { shift: "⇧", backspace: "⌫", space: "mellanslag", enter: "↵" };
const KEYBOARD_KEY_LABELS: Record<string, string> = { shift: "Skift", backspace: "Backsteg", space: "Mellanslag", enter: "Ny rad" };

// Stockholm calendar day (YYYY-MM-DD), same as dayKey in InProgressPageClient.
function stockholmDay(iso: string | number) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function StampTerminal({
  employees: initialEmployees,
  initialOpenSessions,
  initialOpenAttendance,
  stations,
  allowMultipleStamps,
  timeKindSplit = false,
  restSuggestStamp = false,
  pinRequired: initialPinRequired = false,
}: {
  employees: EmployeeDirectoryEntry[];
  initialOpenSessions: StampSession[];
  initialOpenAttendance: AttendanceSession[];
  stations: TerminalStation[];
  allowMultipleStamps: boolean;
  // Dela tid i ställ och produktion: Starta ställ / Starta produktion, Ställ klart.
  timeKindSplit?: boolean;
  // Rest som förslag i antalsfältet → Stämpling: Antal OK starts with Kvar —
  // unless someone else has an open stamp on the same operation.
  restSuggestStamp?: boolean;
  // Kräv kod i stämpelterminalen: the code step after the anställningsnummer.
  // Off = no step and no extra request, exactly as before.
  pinRequired?: boolean;
}) {
  const [step, setStep] = useState<Step>({ name: "keypad" });
  // The terminal stays open for days: a number not in the list loaded with
  // the page is looked up once more before it is refused (someone hired
  // since, or made active again).
  const [employees, setEmployees] = useState(initialEmployees);
  const [entry, setEntry] = useState("");
  // Terminalkod: the digits typed on the code step (shown as dots), the
  // bevistoken a right code gave — sent with every request made for the
  // employee and thrown away on every return to the keypad — and the timer
  // that returns there just before the token runs out.
  const [pinEntry, setPinEntry] = useState("");
  // The setting as the page loaded it — and switched on here when the server
  // says so: the terminal stays open for days, and a setting turned on since
  // shows as a refused request (terminal-pin-required). The next number then
  // gets the code step without a reload.
  const [pinRequired, setPinRequired] = useState(initialPinRequired);
  const pinToken = useRef<string | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyNow = useRef(false);
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
  // Materialbrist i läget warn: the "Rapportera ändå?" question, asked on
  // the stamp-out step itself (not the app dialog) so a return to the keypad
  // takes it away — the next person must never answer it for someone else.
  const [shortageQuestion, setShortageQuestion] = useState<string | null>(null);
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
  // Anslagstavlan: the conversations addressed to this terminal's account,
  // shown above the keypad until their slutdatum.
  const [board, setBoard] = useState<BoardConversation[]>([]);
  // Svara: the reply being written, the skärmtangentbord's shift (null = the
  // text decides: a capital first and after a full stop) and which keyboard
  // this terminal uses — remembered in the browser, the screen's own first.
  const [replyText, setReplyText] = useState("");
  const [replyShift, setReplyShift] = useState<boolean | null>(null);
  const [keyboardMode, setKeyboardMode] = useState<TerminalKeyboardMode>("screen");
  const replyField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      setKeyboardMode(terminalKeyboardModeOf(window.localStorage.getItem(TERMINAL_KEYBOARD_STORAGE_KEY)));
    } catch {
      // no storage (private window): the skärmtangentbord
    }
  }, []);
  function chooseKeyboard(mode: TerminalKeyboardMode) {
    setKeyboardMode(mode);
    try {
      window.localStorage.setItem(TERMINAL_KEYBOARD_STORAGE_KEY, mode);
    } catch {
      // the choice then lasts until the page is reloaded
    }
    if (mode === "device") replyField.current?.focus();
  }

  // Live clock + elapsed tickers.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Shared terminal: any pause mid-flow returns to the keypad so the next
  // person never acts as someone else.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The stamp-out form: emptied whenever it opens and on every return to the
  // keypad, so one person's Antal OK, Kasserat or "Operationen är klar" is
  // never reported on the next stamp-out — someone else's or their own.
  const clearStampOutFields = useCallback(() => {
    setNote("");
    setMarkDone(false);
    setQuantityOk("");
    setQuantityScrapped("");
    setScrapReason("");
    setScrapReasonId("");
    setShortageQuestion(null);
  }, []);
  const resetToKeypad = useCallback(() => {
    setStep({ name: "keypad" });
    setEntry("");
    setPinEntry("");
    pinToken.current = null;
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = null;
    setError(null);
    clearStampOutFields();
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
    setReplyText("");
    setReplyShift(null);
  }, [clearStampOutFields]);
  // What the idle timeout does — normally back to the keypad, but after Ta
  // ut ATF the withdrawal is already registered, so the deviation step
  // finishes the stop with the defaults first (set further down, where the
  // request functions exist; read through a ref so the timer sees the
  // latest state).
  const onIdleRef = useRef<() => void>(resetToKeypad);
  const onIdle = useCallback(() => onIdleRef.current(), []);
  // Paused while a request is on its way (and Tillbaka/Klar are disabled):
  // a return to the keypad mid-request would let the answer land on the
  // next person's screen — someone else's home view, acting as them. The
  // full timeout starts again when the request is done.
  useEffect(() => {
    if (step.name === "keypad" || busy) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(onIdle, IDLE_RESET_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [
    step,
    busy,
    entry,
    pinEntry,
    note,
    markDone,
    quantityOk,
    quantityScrapped,
    scrapReason,
    scrapReasonId,
    shortageQuestion,
    atfHours,
    forgottenStop,
    search,
    stationIds,
    materialId,
    sort,
    onlyReady,
    selectedOperationIds,
    devReasonId,
    devNote,
    devOvertime,
    replyText,
    replyShift,
    keyboardMode,
    onIdle,
  ]);

  // Browsing a long operation list (scroll/touch) counts as activity, so the
  // operator isn't sent back to the keypad mid-scroll. So does everything
  // done while writing a reply — a key that changes nothing in the text
  // (arrows, shift, a full field) and reading the messages above it.
  const listActive = (step.name === "pickOperations" || step.name === "reply" || step.name === "messages") && !busy;
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

  // Terminalkod: every request made FOR the employee (stamping, reporting,
  // the employee's messages, ATF, the schedule) carries the bevistoken — a
  // new such request must go through here, or a terminal account is refused
  // (403 terminal-pin-required) while the setting is on. Without a token
  // (the setting off) this is apiFetch.
  function employeeFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = pinToken.current;
    return apiFetch<T>(path, token ? { ...init, headers: { ...init?.headers, [PIN_HEADER]: token } } : init).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === "terminal-pin-required") setPinRequired(true);
      throw err;
    });
  }
  useEffect(() => {
    busyNow.current = busy;
  });
  // Keeps the token and returns to the keypad shortly before it runs out —
  // as the idle timeout does, and never in the middle of a request.
  function holdProof(proof: { token: string; expiresAt: string }) {
    pinToken.current = proof.token;
    if (pinTimer.current) clearTimeout(pinTimer.current);
    const expire = () => {
      if (busyNow.current) {
        pinTimer.current = setTimeout(expire, 2000);
        return;
      }
      setNotice("Tiden för koden har gått ut — knappa in ditt anställningsnummer och din kod igen.");
      onIdle();
    };
    pinTimer.current = setTimeout(expire, Math.max(0, new Date(proof.expiresAt).getTime() - Date.now() - PIN_EXPIRY_MARGIN_MS));
  }
  useEffect(
    () => () => {
      if (pinTimer.current) clearTimeout(pinTimer.current);
    },
    []
  );

  const refresh = useCallback(async () => {
    const [sessions, attendance] = await Promise.all([
      apiFetch<StampSession[]>("/api/v1/stamp-sessions?open=true"),
      apiFetch<AttendanceSession[]>("/api/v1/attendance-sessions?open=true"),
    ]);
    setOpenSessions(sessions);
    setOpenAttendance(attendance);
    return { sessions, attendance };
  }, []);
  // After a write that went through: a failed reload must not look like the
  // write failed — the step would stay put and a second tap would stamp,
  // report or withdraw ATF again. The cached lists stay until the next one.
  const refreshQuietly = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // keep the cached lists
    }
  }, [refresh]);

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

  // Anslagstavlan is read whenever the keypad comes back and once a minute
  // while it shows (the terminal stays open for days). A failed read keeps
  // what is shown.
  const onKeypad = step.name === "keypad";
  useEffect(() => {
    if (!onKeypad) return;
    let cancelled = false;
    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const rows = await apiFetch<BoardConversation[]>("/api/v1/messages/terminal-board");
        if (!cancelled) setBoard(rows);
      } catch {
        // keep the board as it is
      }
    }
    void load();
    const timer = window.setInterval(load, MESSAGES_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onKeypad]);

  // Badge scanners type the employee number and send Enter — accept hardware
  // keyboard input on the keypad step.
  useEffect(() => {
    if (step.name !== "keypad") return;
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) setEntry((v) => (v + e.key).slice(0, 10));
      else if (e.key === "Backspace") setEntry((v) => v.slice(0, -1));
      else if (e.key === "Enter") confirmEntry();
      else return;
      setNotice(null); // the previous person's "Hej då" goes away as on the on-screen keys
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The code step takes a hardware keyboard too.
  useEffect(() => {
    if (step.name !== "pin") return;
    const current = step;
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) setPinEntry((v) => (v + e.key).slice(0, PIN_LENGTH));
      else if (e.key === "Backspace") setPinEntry((v) => v.slice(0, -1));
      else if (e.key === "Enter") void submitPin(current);
      else if (e.key === "Escape") resetToKeypad();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function confirmEntry() {
    if (busy) return;
    if (!entry) {
      setError("Knappa in ditt anställningsnummer.");
      return;
    }
    const typed = entry;
    const matches = (e: EmployeeDirectoryEntry) =>
      e.employeeNumber === typed || e.employeeNumber.replace(/\D/g, "") === typed;
    setError(null);
    setEntry("");
    setBusy(true);
    let employee = employees.find(matches);
    let open: (() => void) | null = null;
    try {
      if (!employee) {
        try {
          const fresh = (await apiFetch<EmployeeDirectoryEntry[]>("/api/v1/employees/directory")).filter((e) => e.active);
          setEmployees(fresh);
          employee = fresh.find(matches);
        } catch {
          // keep the list loaded with the page
        }
        if (!employee) {
          setError(`Inget anställningsnummer matchar ${typed}.`);
          return;
        }
      }
      if (pinRequired) {
        // Kräv kod i stämpelterminalen: nothing of the employee's is read or
        // shown before the code — only whether one is chosen and whether it
        // is locked.
        await askForPin(employee);
        return;
      }
      open = await loadEmployeeView(employee);
    } finally {
      setBusy(false);
    }
    open?.();
  }

  // Opens the code step for the employee: Ange din kod, or Välj en kod when
  // none is chosen. A locked code stays on the keypad with the time. The
  // caller holds `busy`.
  async function askForPin(employee: EmployeeDirectoryEntry) {
    pinToken.current = null;
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = null;
    try {
      const status = await apiFetch<{ pinSet: boolean; lockedUntil: string | null }>(`/api/v1/employees/${employee.id}/terminal-pin`);
      if (status.lockedUntil) {
        resetToKeypad();
        setError(lockedText(status.lockedUntil));
        return;
      }
      setPinEntry("");
      setStep({ name: "pin", employee, mode: status.pinSet ? "enter" : "choose" });
    } catch (err) {
      resetToKeypad();
      setError(apiErrorMessage(err, "Koden kunde inte kontrolleras."));
    }
  }

  // What the number opens: the employee's unread messages first, then the
  // home view (or the forgotten stamp-out). Reads only — the caller holds
  // `busy` and calls the returned function when it has let go of it.
  async function loadEmployeeView(found: EmployeeDirectoryEntry): Promise<() => void> {
    // Fresh lists before deciding: stamps closed elsewhere (an operation
    // turning done stamps everyone out, regel 10) or attendance fixed in
    // Attestering must not show up stale. On failure the cached lists do.
    let attendance = openAttendance;
    let unread: EmployeeUnreadConversation[] = [];
    try {
      attendance = (await refresh()).attendance;
    } catch {
      // keep the cached lists
    }
    // Meddelanden till den anställde. A failed read never stops the
    // stamping — the messages show the next time instead.
    try {
      unread = await employeeFetch<EmployeeUnreadConversation[]>(`/api/v1/messages/employees/${found.id}/unread`);
    } catch (err) {
      // The setting was switched on since this page loaded (or the code was
      // nollställd a moment ago): the code step, never the home view.
      if (err instanceof ApiError && err.code === "terminal-pin-required") {
        await askForPin(found);
        return () => {};
      }
      unread = [];
    }
    const open = attendance.find((a) => a.employeeId === found.id);
    const proceed = () => {
      if (open && stockholmDay(open.startedAt) < stockholmDay(Date.now())) {
        void openForgotten(found, open.id, open.startedAt);
        return;
      }
      setStep({ name: "home", employee: found });
    };
    return () => {
      if (unread.length > 0) setStep({ name: "messages", employee: found, unread, proceed });
      else proceed();
    };
  }

  // OK on the code step. Ange din kod checks the code; Välj en kod asks for
  // it once more (Upprepa koden) and then stores it. A right or a newly
  // chosen code gives the bevistoken and opens what the number opens.
  async function submitPin(current: Extract<Step, { name: "pin" }>) {
    if (busy) return;
    const { employee, mode } = current;
    if (pinEntry.length !== PIN_LENGTH) {
      setError(`Koden ska vara ${PIN_LENGTH} siffror.`);
      return;
    }
    const pin = pinEntry;
    setPinEntry("");
    setError(null);
    if (mode === "choose") {
      setStep({ name: "pin", employee, mode: "repeat", first: pin });
      return;
    }
    if (mode === "repeat" && pin !== current.first) {
      setError("Koderna var inte lika — välj en kod igen.");
      setStep({ name: "pin", employee, mode: "choose" });
      return;
    }
    let open: (() => void) | null = null;
    setBusy(true);
    try {
      const proof = await apiFetch<{ token: string; expiresAt: string }>(
        `/api/v1/employees/${employee.id}/terminal-pin${mode === "enter" ? "/verify" : ""}`,
        { method: "POST", body: JSON.stringify({ pin }) }
      );
      holdProof(proof);
      if (mode === "repeat") setNotice("Koden är vald.");
      open = await loadEmployeeView(employee);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "terminal-pin-locked") {
        // Nothing more to do here until the spärr runs out.
        resetToKeypad();
        setError(apiErrorMessage(err, "Koden är spärrad."));
      } else if (code === "terminal-pin-not-set") {
        // Nollställd by an administrator since the number was entered.
        setStep({ name: "pin", employee, mode: "choose" });
        setError("Koden har nollställts — välj en ny kod.");
      } else if (code === "terminal-pin-already-set") {
        setStep({ name: "pin", employee, mode: "enter" });
        setError(apiErrorMessage(err, "En kod är redan vald."));
      } else {
        if (mode === "repeat") setStep({ name: "pin", employee, mode: "choose" });
        setError(apiErrorMessage(err, "Koden kunde inte kontrolleras."));
      }
      return;
    } finally {
      setBusy(false);
    }
    open?.();
  }

  // OK, läst: the messages on screen are acknowledged for the employee, then
  // the stamp choices open. A failed acknowledgement does not stop the
  // stamping either — the messages come back the next time.
  async function acknowledgeMessages(employee: EmployeeDirectoryEntry, unread: EmployeeUnreadConversation[], proceed: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await employeeFetch(`/api/v1/messages/employees/${employee.id}/read`, {
        method: "POST",
        body: JSON.stringify({ messageIds: unread.flatMap((c) => c.messages.map((m) => m.id)) }),
      });
    } catch {
      // shown again at the next stamp
    } finally {
      setBusy(false);
    }
    proceed();
  }

  // Svara: opens the reply for one of the conversations on the messages step.
  function openReply(step: Extract<Step, { name: "messages" }>, conversation: EmployeeUnreadConversation) {
    setError(null);
    setReplyText("");
    setReplyShift(null);
    setStep({ name: "reply", employee: step.employee, unread: step.unread, proceed: step.proceed, conversation });
  }

  // Skicka: the reply stands in the employee's own name and reads the
  // conversation up to what was on screen. The conversations left are shown
  // again; with none left the stamp choices open. A failed send keeps the
  // text — nothing typed at a terminal is thrown away by an error.
  async function sendReply(step: Extract<Step, { name: "reply" }>) {
    const body = replyText.trim();
    if (busy || !body) return;
    setBusy(true);
    setError(null);
    try {
      await employeeFetch(`/api/v1/messages/employees/${step.employee.id}/conversations/${step.conversation.conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body, messageIds: step.conversation.messages.map((m) => m.id) }),
      });
    } catch (err) {
      setError(apiErrorMessage(err, "Svaret kunde inte skickas."));
      return;
    } finally {
      setBusy(false);
    }
    setReplyText("");
    setReplyShift(null);
    setNotice("Svaret är skickat.");
    const left = step.unread.filter((c) => c.conversationId !== step.conversation.conversationId);
    if (left.length > 0) setStep({ name: "messages", employee: step.employee, unread: left, proceed: step.proceed });
    else step.proceed();
  }

  // One key of the skärmtangentbord.
  function pressReplyKey(key: string) {
    const shift = replyShift ?? terminalKeyboardShiftDefault(replyText);
    if (key === "shift") {
      setReplyShift(!shift);
      return;
    }
    setReplyText((text) => applyTerminalKey(text, key, shift));
    setReplyShift(null);
  }

  // Rule 8: the attendance has been open since an earlier day — ask when
  // the person went home, prefilled with that day's scheduled end.
  async function openForgotten(employee: EmployeeDirectoryEntry, attendanceId: string, startedAt: string) {
    setBusy(true);
    try {
      const day = stockholmDay(startedAt);
      const calendar = await employeeFetch<ResolvedCalendarDay[]>(
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
      return startSelectedOperations(employee, pending.operations, reason, pending.earlierFailed, pending.timeKind);
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
    earlierFailed: TerminalOperation[] = [],
    timeKind?: TimeKind
  ) {
    if (operations.length === 0) return;
    setBusy(true);
    const failed: TerminalOperation[] = [...earlierFailed];
    let moved = false;
    let attendanceStarted = false;
    let reasonPending = attendanceReason;
    try {
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i]!;
        try {
          const res = await employeeFetch<{ attendanceStarted?: boolean }>("/api/v1/stamp-sessions", {
            method: "POST",
            body: JSON.stringify({
              employeeId: employee.id,
              moOperationId: operation.operationId,
              // The station the list showed: an operation the planner has
              // moved since is refused instead of started on the old one.
              workCenterId: operation.workCenterId,
              ...(timeKind ? { kind: timeKind } : {}),
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
            await refreshQuietly();
            return void (await openDeviation(
              employee,
              required,
              { kind: "stampIn", operations: operations.slice(i), earlierFailed: failed, timeKind },
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
              { kind: "stampIn", operations: operations.slice(i), earlierFailed: failed, timeKind },
              {},
              apiErrorMessage(err, "Anledningen finns inte längre — välj en annan.")
            ));
          }
          if (isWorkCenterChanged(err)) moved = true;
          failed.push(operation);
        }
      }
      await refreshQuietly();
      if (failed.length === 0) {
        // Only what was started: a row hidden by Sök/Bara redo was not.
        const started = new Set(operations.map((op) => op.operationId));
        setSelectedOperationIds((prev) => new Set([...prev].filter((id) => !started.has(id))));
        setError(null);
        if (attendanceStarted) setNotice("Närvaron stämplades in.");
        setStep({ name: "home", employee });
      } else {
        // Back to the operation list (also from the deviation step, whose
        // button would otherwise resend operations already started) with
        // only the failed ones checked.
        setSelectedOperationIds(new Set(failed.map((op) => op.operationId)));
        const names = failed.map((op) => `${op.orderNumber} op ${op.sequenceNo}`).join(", ");
        const movedText = moved ? " En operation har flyttats till en annan resurs — listan är uppdaterad." : "";
        setError(
          (failed.length === earlierFailed.length + operations.length
            ? `Instämpling misslyckades: ${names}.`
            : `Instämpling misslyckades för: ${names}. Övriga är instämplade.`) + movedText
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
      await employeeFetch("/api/v1/attendance-sessions", {
        method: "POST",
        body: JSON.stringify({
          employeeId: employee.id,
          ...(reason ? { reason } : {}),
          ...(forgottenStoppedAt ? { forgottenStoppedAt } : {}),
        }),
      });
      await refreshQuietly();
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
      const result = await employeeFetch<{ pausedWorkSessions: number }>(
        `/api/v1/attendance-sessions/${attendanceId}/stop`,
        { method: "POST", ...(answers ? { body: JSON.stringify(answers) } : {}) }
      );
      await refreshQuietly();
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
      const today = stockholmToday();
      const [atf, calendar] = await Promise.all([
        employeeFetch<AtfStatus>(`/api/v1/employees/${employee.id}/atf`),
        employeeFetch<ResolvedCalendarDay[]>(
          `/api/v1/employees/${employee.id}/schedule-calendar?from=${today}&to=${today}`
        ),
      ]);
      const scheduledMinutes = calendar[0]?.daySchedule?.netMinutes ?? null;
      setAtfHours(scheduledMinutes ? formatDuration(scheduledMinutes) : "");
      setError(null);
      setStep({ name: "atf", employee, atf, scheduledMinutes });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta ATF-saldot."));
    } finally {
      setBusy(false);
    }
  }

  async function takeAtf(employee: EmployeeDirectoryEntry, attendance: AttendanceSession | undefined) {
    // Tid as tt:mm — a bare number is minutes (lib/duration.ts).
    const minutes = parseDuration(atfHours);
    if (minutes === null || minutes <= 0 || minutes > 1440) {
      setError("Ange ATF-tiden som tt:mm, t.ex. 8:00 eller 2:30.");
      return;
    }
    setBusy(true);
    try {
      const transaction = await employeeFetch<{ id: string }>(`/api/v1/employees/${employee.id}/atf-transactions`, {
        method: "POST",
        body: JSON.stringify({
          date: stockholmToday(),
          type: "withdrawal",
          minutes,
          note: "ATF via stämpelterminalen",
        }),
      });
      if (!attendance) {
        await refreshQuietly();
        setNotice(`${formatHours(minutes)} ATF uttaget för ${employee.name.split(" ")[0]}.`);
        resetToKeypad();
        return;
      }
      await finishAtf(employee, { kind: "atf", attendanceId: attendance.id, atfTransactionId: transaction.id, hours: minutes / 60 }, undefined, {
        fromAtfStep: true,
      });
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
    answers?: DeviationAnswers,
    { fromAtfStep = false }: { fromAtfStep?: boolean } = {}
  ) {
    const first = employee.name.split(" ")[0];
    const hoursText = formatHours(Math.round(pending.hours * 60));
    setBusy(true);
    try {
      await employeeFetch(`/api/v1/attendance-sessions/${pending.attendanceId}/stop`, {
        method: "POST",
        body: JSON.stringify({ ...answers, atfTransactionId: pending.atfTransactionId }),
      });
      await refreshQuietly();
      setNotice(`${hoursText} ATF uttaget för ${first} — närvaron är utstämplad.`);
      resetToKeypad();
    } catch (err) {
      const required = inputRequiredBody(err);
      if (required) return void (await openDeviation(employee, required, pending, answers ?? {}));
      if (answers?.reason && isReasonInvalid(err)) return void (await reasonInvalid(err));
      if (err instanceof ApiError && err.code === "attendance-session-already-stopped") {
        // Stamped out elsewhere (Attestering, another terminal) meanwhile:
        // the withdrawal stands and there is nothing left to stop.
        await refreshQuietly();
        resetToKeypad();
        setNotice(`${hoursText} ATF uttaget för ${first} — närvaron var redan utstämplad.`);
        return;
      }
      if (fromAtfStep) {
        // The withdrawal is already registered: leave the ATF step, or the
        // next tap on Ta ut ATF would withdraw the hours a second time.
        resetToKeypad();
        setNotice(
          `ATF-uttaget är registrerat, men närvaron kunde inte stämplas ut (${apiErrorMessage(err, "okänt fel")}). Tryck Gå hem.`
        );
        return;
      }
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
      await employeeFetch(`/api/v1/attendance-sessions/${pending.attendanceId}/stop`, {
        method: "POST",
        body: JSON.stringify({
          ...(reason ? { reason } : {}),
          ...(overtimeDisposition ? { overtimeDisposition } : {}),
          atfTransactionId: pending.atfTransactionId,
        }),
      });
      await refreshQuietly();
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

  // Ställ klart: stamp out the setup with 0/0 (only the time row, no quantity,
  // no material) and straight on to Produktion on the same operation. If the
  // second call fails the person stands stamped out, with the error shown.
  async function setupDone(employee: EmployeeDirectoryEntry, session: StampSession) {
    setBusy(true);
    try {
      try {
        await employeeFetch(`/api/v1/stamp-sessions/${session.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ quantityOk: 0, quantityScrapped: 0 }),
        });
      } catch (err) {
        await refreshQuietly();
        setStep({ name: "home", employee });
        setError(apiErrorMessage(err, "Ställ klart misslyckades."));
        return;
      }
      try {
        await employeeFetch("/api/v1/stamp-sessions", {
          method: "POST",
          body: JSON.stringify({
            employeeId: employee.id,
            moOperationId: session.moOperationId,
            kind: "run",
            // The resource the setup was stamped on: a Byt resurs between the
            // two calls is refused rather than producing on another station.
            ...(session.workCenterId ? { workCenterId: session.workCenterId } : {}),
          }),
        });
        setError(null);
        setNotice("Ställ klart — produktionen är instämplad.");
      } catch (err) {
        setError(apiErrorMessage(err, "Ställtiden sparades men instämplingen på produktion misslyckades."));
      }
      await refreshQuietly();
      setStep({ name: "home", employee });
    } finally {
      setBusy(false);
    }
  }

  // Stämpla ut — and Rapportera ändå (allowMaterialShortage) after the
  // shortage question, asked on this step: the first answer is a 409
  // material-shortage with overridable: true (Materialbrist vid rapportering
  // = warn); block mode is an ordinary error.
  async function stampOut(employee: EmployeeDirectoryEntry, session: StampSession, allowMaterialShortage = false) {
    if (Number(quantityScrapped) > 0 && scrapReasonRegister && scrapReasonId === "") {
      setError("Välj en orsak när kasserat antal är större än 0.");
      return;
    }
    if (Number(quantityScrapped) > 0 && !scrapReasonRegister && scrapReason.trim() === "") {
      setError("Ange en kassationsorsak när kasserat antal är större än 0.");
      return;
    }
    setShortageQuestion(null);
    setBusy(true);
    try {
      const stopped = await employeeFetch(`/api/v1/stamp-sessions/${session.id}/stop`, {
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
      });
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
      await refreshQuietly();
      clearStampOutFields();
      setError(null);
      setStep({ name: "home", employee });
      // Serienummer (#8 etapp 2): the numbers the report received.
      const received = (stopped as { receivedSerialNumbers?: string[] } | undefined)?.receivedSerialNumbers ?? [];
      if (received.length > 0) setNotice(`Mottagna serienummer: ${compressSerialNumbers(received)}.`);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === "material-shortage" &&
        (err.body as { overridable?: unknown } | undefined)?.overridable === true
      ) {
        // Nothing is sent until Rapportera ändå; Avbryt (or the return to
        // the keypad) leaves the person stamped in, as the manual says.
        setError(null);
        setShortageQuestion(`Det saknas ingående delar: ${shortageList(err)}. Rapportera ändå?`);
        return;
      }
      if (err instanceof ApiError && err.code === "stamp-session-already-stopped") {
        // Stamped out elsewhere (regel 10) while this view was open: show
        // the current stamps instead of the stale one.
        await refreshQuietly();
        clearStampOutFields();
        setStep({ name: "home", employee });
      }
      setError(apiErrorMessage(err, "Utstämplingen misslyckades."));
    } finally {
      setBusy(false);
    }
  }

  const clock = new Date(now).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
  const visibleRows =
    step.name === "pickOperations"
      ? sortTerminalOperations(filterTerminalOperations(rows, { onlyReady, search }), sort)
      : [];
  // Starta valda starts the checked rows the list shows; checked rows hidden by the filter wait.
  const selection = splitSelection(visibleRows, selectedOperationIds);

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
            {board.length > 0 && (
              <div className={styles.board} role="region" aria-label="Meddelanden till terminalen">
                {board.map((item) => (
                  <article key={item.id} className={styles.boardItem}>
                    <h2 className={styles.boardSubject}>{item.subject}</h2>
                    {item.messages.map((m) => (
                      <div key={m.id} className={styles.boardMessage}>
                        <div className={styles.messageMeta}>
                          {m.senderName} · {messageTime(m.createdAt, stockholmToday())}
                        </div>
                        <div className={styles.messageText}>{m.body}</div>
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            )}
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

        {step.name === "pin" && (
          <section className={styles.keypadStep} aria-label={PIN_PROMPTS[step.mode]}>
            <div className={styles.prompt}>
              {PIN_PROMPTS[step.mode]}{" "}
              <span className={`${styles.promptMeta} num`}>(anställningsnummer {step.employee.employeeNumber})</span>
            </div>
            <div className={styles.entry} role="status" aria-label={`${pinEntry.length} av ${PIN_LENGTH} siffror`}>
              <span aria-hidden="true">
                {"●".repeat(pinEntry.length)}
                <span className={styles.entryPlaceholder}>{"○".repeat(PIN_LENGTH - pinEntry.length)}</span>
              </span>
            </div>
            <div className={styles.keypad}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.key} ${key === "OK" ? styles.keyOk : ""}`}
                  aria-label={key === "⌫" ? "Radera" : undefined}
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    if (key === "OK") void submitPin(step);
                    else if (key === "⌫") setPinEntry((v) => v.slice(0, -1));
                    else setPinEntry((v) => (v + key).slice(0, PIN_LENGTH));
                  }}
                >
                  {key}
                </button>
              ))}
            </div>
            <p className={styles.hint}>
              {step.mode === "enter"
                ? "Har du glömt koden? En administratör kan nollställa den, så väljer du en ny."
                : step.mode === "choose"
                  ? "Välj fyra siffror som bara du känner till. Du anger koden varje gång du har knappat in ditt anställningsnummer."
                  : "Knappa in samma fyra siffror en gång till."}
            </p>
            <BackRow label="Avbryt" disabled={busy} onBack={resetToKeypad} />
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
            timeKindSplit={timeKindSplit}
            onSetupDone={(session) => setupDone(step.employee, session)}
            onStampOut={async (opened) => {
              clearStampOutFields();
              let session = opened;
              if (restSuggestStamp) {
                // The rest is only worth suggesting when it is current: the
                // other stamps (and what they reported) are read again, the
                // cached list stays when the read fails.
                let sessions = openSessions;
                try {
                  sessions = (await refresh()).sessions;
                } catch {
                  // keep the cached list
                }
                session = sessions.find((s) => s.id === opened.id) ?? opened;
                const progress = operationProgress(
                  session.orderQuantity,
                  session.operationQuantityCompleted,
                  session.operationQuantityScrapped
                );
                setQuantityOk(
                  stampRestSuggestion({
                    enabled: true,
                    remaining: progress.remaining,
                    othersStamping: othersStampingOnOperation(sessions, session),
                  }).value
                );
              }
              setStep({ name: "stampOut", employee: step.employee, session });
            }}
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
            <label className={styles.quantityField}>
              ATF-tid (tt:mm)
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="t.ex. 8:00"
                value={atfHours}
                onChange={(e) => setAtfHours(e.target.value)}
                onBlur={(e) => {
                  // Show what was understood ("90" → 1:30), as DurationInput.
                  const minutes = parseDuration(e.target.value);
                  if (minutes !== null && formatDuration(minutes) !== e.target.value) setAtfHours(formatDuration(minutes));
                }}
              />
            </label>
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
            <BackRow disabled={busy} onBack={() => setStep({ name: "home", employee: step.employee })} />
          </section>
        )}

        {step.name === "messages" && (
          <section className={styles.listStep} aria-label="Meddelanden till dig">
            <div className={styles.prompt}>
              {step.employee.name.split(" ")[0]}, du har{" "}
              {step.unread.reduce((n, c) => n + c.messages.length, 0) === 1 ? "ett nytt meddelande" : "nya meddelanden"}
            </div>
            <div className={styles.board}>
              {step.unread.map((item) => (
                <article key={item.conversationId} className={styles.boardItem}>
                  <h2 className={styles.boardSubject}>{item.subject}</h2>
                  {item.messages.map((m) => (
                    <div key={m.id} className={styles.boardMessage}>
                      <div className={styles.messageMeta}>
                        {m.senderName} · {messageTime(m.createdAt, stockholmToday())}
                      </div>
                      <div className={styles.messageText}>{m.body}</div>
                    </div>
                  ))}
                  <button type="button" className={styles.replyButton} disabled={busy} onClick={() => openReply(step, item)}>
                    Svara
                  </button>
                </article>
              ))}
            </div>
            <button
              type="button"
              className={styles.bigAction}
              disabled={busy}
              onClick={() => {
                setNotice(null);
                void acknowledgeMessages(step.employee, step.unread, step.proceed);
              }}
            >
              OK, läst
            </button>
          </section>
        )}

        {step.name === "reply" && (
          <section className={styles.listStep} aria-label="Svara på meddelandet">
            <div className={styles.prompt}>
              Svara <span className={styles.promptMeta}>({step.employee.name})</span>
            </div>
            <article className={styles.boardItem}>
              <h2 className={styles.boardSubject}>{step.conversation.subject}</h2>
              {step.conversation.messages.map((m) => (
                <div key={m.id} className={styles.boardMessage}>
                  <div className={styles.messageMeta}>
                    {m.senderName} · {messageTime(m.createdAt, stockholmToday())}
                  </div>
                  <div className={styles.messageText}>{m.body}</div>
                </div>
              ))}
            </article>
            <div className={styles.quickReplies} role="group" aria-label="Snabbsvar">
              {TERMINAL_QUICK_REPLIES.map((text) => (
                <button
                  key={text}
                  type="button"
                  className={styles.quickReply}
                  disabled={busy}
                  onClick={() => {
                    setReplyText(text);
                    setReplyShift(null);
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
            <textarea
              ref={replyField}
              className={`${styles.note} ${styles.replyText}`}
              aria-label="Ditt svar"
              placeholder="Skriv ditt svar…"
              rows={3}
              maxLength={MESSAGE_BODY_MAX}
              // The skärmtangentbord: the tablet's own keyboard stays down
              // (a physical keyboard still types here).
              inputMode={keyboardMode === "screen" ? "none" : "text"}
              value={replyText}
              onChange={(e) => {
                setReplyText(e.target.value);
                setReplyShift(null);
              }}
            />
            <div className={styles.keyboardChoice} role="group" aria-label="Tangentbord">
              {(
                [
                  ["screen", "Skärmtangentbord"],
                  ["device", "Enhetens tangentbord"],
                ] as const
              ).map(([mode, label]) => (
                <button key={mode} type="button" aria-pressed={keyboardMode === mode} onClick={() => chooseKeyboard(mode)}>
                  {label}
                </button>
              ))}
            </div>
            {keyboardMode === "screen" && (
              <div className={styles.screenKeyboard} role="group" aria-label="Skärmtangentbord">
                {TERMINAL_KEYBOARD_ROWS.map((row, index) => (
                  <div key={index} className={styles.keyboardRow}>
                    {row.map((key) => {
                      const shift = replyShift ?? terminalKeyboardShiftDefault(replyText);
                      const letter = key.length === 1;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={styles.keyboardKey}
                          data-key={letter ? undefined : key}
                          aria-label={KEYBOARD_KEY_LABELS[key]}
                          aria-pressed={key === "shift" ? shift : undefined}
                          disabled={busy}
                          // Keeps the caret's field focused, so a physical keyboard goes on typing there.
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={() => pressReplyKey(key)}
                        >
                          {letter ? (shift ? key.toLocaleUpperCase("sv-SE") : key) : KEYBOARD_KEY_FACES[key]}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            <button type="button" className={styles.bigAction} disabled={busy || replyText.trim() === ""} onClick={() => sendReply(step)}>
              {busy ? "Skickar…" : "Skicka"}
            </button>
            <BackRow
              disabled={busy}
              onBack={() => {
                setError(null);
                setStep({ name: "messages", employee: step.employee, unread: step.unread, proceed: step.proceed });
              }}
            />
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
            {forgottenStopNowAllowed(step.startedAt, now) && (
              <button
                type="button"
                className={styles.attendanceButton}
                disabled={busy}
                onClick={() => goHome(step.employee, step.attendanceId)}
              >
                Gå hem nu
              </button>
            )}
            <BackRow label="Avbryt" disabled={busy} onBack={resetToKeypad} />
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
            startCount={selection.start.length}
            hiddenSelectedCount={selection.hiddenCount}
            onToggle={toggleOperationSelected}
            busy={busy}
            error={error}
            timeKindSplit={timeKindSplit}
            onStart={(timeKind) => startSelectedOperations(step.employee, selection.start, undefined, [], timeKind)}
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
                {step.session.kind && <KindTag kind={step.session.kind} />}
              </div>
              {step.session.packingInstructions && (
                <div className={styles.packingNote}>📦 {step.session.packingInstructions}</div>
              )}
              <OperationDrawingLinks orderId={step.session.manufacturingOrderId} operationId={step.session.moOperationId} />
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
                  onChange={(e) => {
                    setQuantityOk(e.target.value);
                    setShortageQuestion(null);
                  }}
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
                  onChange={(e) => {
                    setQuantityScrapped(e.target.value);
                    setShortageQuestion(null);
                  }}
                  placeholder="0"
                />
              </label>
            </div>
            {restSuggestStamp && othersStampingOnOperation(openSessions, step.session) && (
              <div className={styles.restNote}>Antal OK är tomt eftersom någon annan också stämplar på operationen.</div>
            )}
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
              onClick={() => {
                setMarkDone((v) => !v);
                setShortageQuestion(null);
              }}
              aria-pressed={markDone}
            >
              <span className={styles.toggleBox} aria-hidden="true" />
              Operationen är klar
            </button>
            {timeKindSplit && step.session.kind === "setup" && !step.session.pausedAt && (
              <button
                type="button"
                className={styles.secondaryAction}
                disabled={busy}
                onClick={() => setupDone(step.employee, step.session)}
              >
                Ställ klart
              </button>
            )}
            {shortageQuestion ? (
              <div className={styles.shortageQuestion} role="alertdialog" aria-label="Materialbrist">
                <p>{shortageQuestion}</p>
                <button
                  type="button"
                  className={styles.bigAction}
                  disabled={busy}
                  onClick={() => stampOut(step.employee, step.session, true)}
                >
                  Rapportera ändå
                </button>
                <button
                  type="button"
                  className={styles.backButton}
                  disabled={busy}
                  onClick={() => setShortageQuestion(null)}
                >
                  Avbryt
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.bigAction}
                disabled={busy}
                onClick={() => stampOut(step.employee, step.session)}
              >
                Stämpla ut
              </button>
            )}
            <BackRow disabled={busy} onBack={() => setStep({ name: "home", employee: step.employee })} />
          </section>
        )}
      </main>
    </div>
  );
}

// Ritning (0200): the files the operation is worked from — its chosen
// drawings, otherwise the order's drawings and loose files, in the revision
// the order is built from. Each opens in a new tab (the browser's viewer
// prints it). Nothing is shown when there are none.
function OperationDrawingLinks({ orderId, operationId }: { orderId: string; operationId: string }) {
  const [files, setFiles] = useState<DrawingFileMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch<DrawingFileMeta[]>(`/api/v1/manufacturing-orders/${orderId}/operations/${operationId}/drawings`)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId, operationId]);
  if (files.length === 0) return null;
  return (
    <div className={styles.drawingLinks}>
      {files.map((file) => (
        <a
          key={file.id}
          className={styles.drawingLink}
          href={`${API_URL}/api/v1/manufacturing-orders/${orderId}/files/${file.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText size={20} strokeWidth={2} aria-hidden="true" />
          {file.drawingNumber ? `Ritning ${file.drawingNumber}${file.revision ? ` rev ${file.revision}` : ""}` : file.filename}
        </a>
      ))}
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
  timeKindSplit,
  busy,
  onSetupDone,
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
  timeKindSplit: boolean;
  busy: boolean;
  onSetupDone: (session: StampSession) => void;
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
                {new Date(attendance.startedAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" })}
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
            <div key={session.id} className={styles.sessionGroup}>
              <button
                type="button"
                className={`${styles.choice} ${styles.choiceOpen}`}
                disabled={busy}
                onClick={() => onStampOut(session)}
              >
                <span className={styles.choicePrimary}>
                  <span className="num">{session.manufacturingOrderNumber}</span> · {session.articleName}
                  {session.kind && <KindTag kind={session.kind} />}
                </span>
                <span className={styles.choiceSecondary}>
                  Op <span className="num">{session.operationSequenceNo}</span> · {session.workCenterName} —{" "}
                  <span className="num">{formatElapsed(session, now)}</span>
                  {session.pausedAt ? " · Pausad" : ""} · Tryck för att stämpla ut
                </span>
              </button>
              {timeKindSplit && session.kind === "setup" && !session.pausedAt && (
                <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => onSetupDone(session)}>
                  Ställ klart
                </button>
              )}
              <OperationDrawingLinks orderId={session.manufacturingOrderId} operationId={session.moOperationId} />
            </div>
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

      <BackRow label="Klar" disabled={busy} onBack={onDone} />
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
      <BackRow label="Avbryt" disabled={busy} onBack={onCancel} />
    </section>
  );
}

// Disabled while a request is on its way: leaving mid-request would let the
// answer land on a later screen — possibly the next person's.
function BackRow({ label = "Tillbaka", disabled = false, onBack }: { label?: string; disabled?: boolean; onBack: () => void }) {
  return (
    <button type="button" className={styles.backButton} disabled={disabled} onClick={onBack}>
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
  disabled = false,
  onApply,
}: {
  stations: TerminalStation[];
  stationIds: string[];
  defaultStationIds: string[];
  disabled?: boolean;
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
        disabled={disabled}
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

// The type of a running stamp, next to the operation it belongs to.
function KindTag({ kind }: { kind: TimeKind }) {
  return (
    <span className={styles.kindTag}>
      <StatusPill status={kind === "setup" ? "draft" : "running"} label={TIME_KIND_LABELS[kind]} compact />
    </span>
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
  startCount,
  hiddenSelectedCount,
  onToggle,
  busy,
  error,
  timeKindSplit,
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
  /** Checked rows the list shows (what Starta valda starts) and checked rows the filter hides. */
  startCount: number;
  hiddenSelectedCount: number;
  onToggle: (operationId: string) => void;
  busy: boolean;
  error: string | null;
  timeKindSplit: boolean;
  onStart: (timeKind?: TimeKind) => void;
  onBack: () => void;
}) {
  const canOpenPage = useCanOpen();
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
        {/* Station and material reload the list, which drops checked rows that
            are no longer listed — not while Starta valda is running. */}
        <StationPicker
          stations={stations}
          stationIds={stationIds}
          defaultStationIds={employee.defaultWorkCenterIds ?? []}
          disabled={busy}
          onApply={onStationIds}
        />
        {/* Körplan of the chosen station (one station only), in a new tab. */}
        {stationIds.length === 1 && canOpenPage("/tillverkning/korplan") && (
          <a
            href={`/tillverkning/korplan?resurs=${encodeURIComponent(stationIds[0]!)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.stationButton}
          >
            Körplan
          </a>
        )}
        <label className={styles.filterGroup}>
          <span className={styles.filterLabel}>Material</span>
          <select className={styles.select} value={materialId} disabled={busy} onChange={(e) => onMaterialId(e.target.value)}>
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
            { value: "planned", label: "Planerad dag" },
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
                    {plannedDateLabel(op.plannedStartDate, op.plannedEndDate) && (
                      <span className={styles.dueDate}>
                        Planerad <span className="num">{plannedDateLabel(op.plannedStartDate, op.plannedEndDate)}</span>
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
        {hiddenSelectedCount > 0 && (
          <p className={styles.hint}>
            {hiddenSelectedCount === 1 ? "1 markerad operation döljs" : `${hiddenSelectedCount} markerade operationer döljs`} av
            filtret och startas inte.
          </p>
        )}
        {timeKindSplit ? (
          // One choice for the whole batch: the button pressed is the type.
          <div className={styles.actionPair}>
            <button
              type="button"
              className={styles.secondaryAction}
              disabled={busy || startCount === 0}
              onClick={() => onStart("setup")}
            >
              Starta ställ{startCount > 0 ? ` (${startCount})` : ""}
            </button>
            <button
              type="button"
              className={styles.bigAction}
              disabled={busy || startCount === 0}
              onClick={() => onStart("run")}
            >
              Starta produktion{startCount > 0 ? ` (${startCount})` : ""}
            </button>
          </div>
        ) : (
          <button type="button" className={styles.bigAction} disabled={busy || startCount === 0} onClick={() => onStart()}>
            Starta valda{startCount > 0 ? ` (${startCount})` : ""}
          </button>
        )}
        <BackRow disabled={busy} onBack={onBack} />
      </div>
    </section>
  );
}

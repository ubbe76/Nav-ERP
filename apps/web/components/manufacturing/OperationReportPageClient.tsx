"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { DurationInput } from "../ui/DurationInput";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { Modal } from "../ui/Modal";
import { Table } from "../ui/Table";
import { ScrapReasonFields } from "../quality/ScrapReasonFields";
import { CameraScanner } from "../ui/ScanInput";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { stockholmToday } from "../../lib/date";
import { DURATION_HINT, durationFromHours, hoursFromDuration, parseDuration } from "../../lib/duration";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { defaultReportKind, suggestedReportHours } from "../../lib/moSuggestions";
import { reportNotice, rowProgress, singleMatch, suggestsDone, type ReportSummary } from "../../lib/operationReport";
import { restFieldValue } from "../../lib/restSuggestion";
import { formatQuantity } from "../../lib/stampSessions";
import { filterTerminalOperations, readinessLabel, sortTerminalOperations } from "../../lib/terminalOperations";
import { useScrapReasons } from "../../lib/useScrapReasons";
import type { EmployeeDirectoryEntry, MOOperation, TerminalOperation, TerminalStation, TimeKind, TimeReport } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import styles from "./OperationReportPageClient.module.css";

// Tillverkning → Rapportera (2026-11-24, the user's choices): the open
// operations (the terminal's list — released/in progress orders, not lego),
// found by search or scan; one operation at a time in a dialog with the
// employee, day, time and quantities, sent as ONE report
// (POST /operation-reports: a manual time report and the quantities in one
// transaction). Linked material is drawn automatically, as on every report.

type Sort = "planned" | "urgent";
type Row = TerminalOperation & { id: string };

interface ReportResult {
  reportId: string;
  received: number;
  orderCompleted: boolean;
  receivedSerialNumbers: string[];
}

interface Notice {
  text: string;
  orderId: string;
  reportId: string;
}

export function OperationReportPageClient({
  employees,
  stations,
  suggestRest,
  timeKindSplit,
  canUndo,
}: {
  employees: EmployeeDirectoryEntry[];
  stations: TerminalStation[];
  suggestRest: boolean;
  timeKindSplit: boolean;
  canUndo: boolean;
}) {
  const [rows, setRows] = useState<TerminalOperation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stationId, setStationId] = useState("");
  const [sort, setSort] = useState<Sort>("planned");
  const [target, setTarget] = useState<TerminalOperation | null>(null);
  // Anställd and Datum carry over from one report to the next — a day's
  // notes are usually one person's.
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(() => stockholmToday());
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const request = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  // After a report the search is selected for the next note or scan — once
  // the dialog has closed: a <dialog>'s close() hands focus back to the
  // button that opened it, and the Modal closes it in its own effect, which
  // runs before this component's.
  const focusSearch = useRef(false);
  useEffect(() => {
    if (target !== null || !focusSearch.current) return;
    focusSearch.current = false;
    searchRef.current?.select();
  }, [target]);

  // A sequence number makes a late answer (an older station filter) harmless.
  const load = useCallback(async () => {
    const seq = ++request.current;
    try {
      const res = await apiFetch<{ rows: TerminalOperation[] }>(
        `/api/v1/terminal/operations${stationId ? `?workCenterIds=${stationId}` : ""}`
      );
      if (seq !== request.current) return;
      setRows(res.rows);
      setLoadError(null);
    } catch (err) {
      if (seq !== request.current) return;
      setLoadError(apiErrorMessage(err, "Kunde inte läsa operationerna"));
    }
  }, [stationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo<Row[]>(
    () =>
      rows
        ? sortTerminalOperations(filterTerminalOperations(rows, { onlyReady: false, search }), sort).map((r) => ({
            ...r,
            id: r.operationId,
          }))
        : [],
    [rows, search, sort]
  );

  // Enter in the search field — a scanned TO number ends with it — opens the
  // operation straight away when the search leaves exactly one.
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const one = singleMatch(shown);
    if (one) open(one);
  }

  // Kamera (a phone): the decoded code becomes the search, and a single
  // match opens as after Enter.
  function scanned(code: string) {
    setCameraOpen(false);
    const text = code.trim();
    setSearch(text);
    const one = rows ? singleMatch(filterTerminalOperations(rows, { onlyReady: false, search: text })) : null;
    if (one) open(one);
  }

  function open(row: TerminalOperation) {
    setUndoError(null);
    setTarget(row);
  }

  function reported(row: TerminalOperation, result: ReportResult, summary: ReportSummary) {
    setTarget(null);
    setNotice({
      text: reportNotice({
        ...summary,
        orderNumber: row.orderNumber,
        sequenceNo: row.sequenceNo,
        received: result.received,
        orderCompleted: result.orderCompleted,
        receivedSerialNumbers: result.receivedSerialNumbers,
      }),
      orderId: row.manufacturingOrderId,
      reportId: result.reportId,
    });
    setUndoError(null);
    void load();
    focusSearch.current = true;
  }

  async function undo() {
    if (!notice) return;
    const ok = await confirmDialog("Ångra rapporten? Tiden och antalen tas bort, och materialet läggs tillbaka i lager.", {
      confirmLabel: "Ångra rapporten",
    });
    if (!ok) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      await apiFetch(`/api/v1/manufacturing-orders/${notice.orderId}/reports/${notice.reportId}/undo`, { method: "POST" });
      setNotice({ ...notice, text: "Rapporten är ångrad.", reportId: "" });
      void load();
    } catch (err) {
      setUndoError(apiErrorMessage(err, "Kunde inte ångra rapporten"));
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Rapportera</div>
          <div className={shellStyles.meta}>
            {rows === null ? "Läser operationer…" : `${shown.length} av ${rows.length} operationer`}
          </div>
        </div>
        <HelpLink chapter="tillverkning" anchor="rapportera" label="Hjälp om Rapportera" />
      </div>

      <FormHint>
        Rapportera tid och antal på en operation i taget, t.ex. från en arbetslapp. Material som är kopplat till operationen
        dras automatiskt.
      </FormHint>

      <div className={styles.toolbar}>
        <Input
          ref={searchRef}
          type="search"
          className={styles.search}
          aria-label="Sök eller skanna"
          placeholder="Sök eller skanna TO-nummer, artikel eller resurs…"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKey}
        />
        <Button type="button" variant="secondary" onClick={() => setCameraOpen(true)}>
          Kamera
        </Button>
        <Select aria-label="Filtrera på resurs" size="md" value={stationId} onChange={(e) => setStationId(e.target.value)}>
          <option value="">Alla resurser</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} {s.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Sortera" size="md" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="planned">Sortering: Planerad dag</option>
          <option value="urgent">Sortering: Färdigdatum</option>
        </Select>
      </div>

      {notice && (
        <FormNotice className={styles.notice} role="status">
          <span>{notice.text}</span>
          {canUndo && notice.reportId && (
            <Button type="button" variant="ghost" size="small" disabled={undoBusy} onClick={() => void undo()}>
              Ångra
            </Button>
          )}
        </FormNotice>
      )}
      <FormError margin="below">{undoError}</FormError>
      <FormError margin="below">{loadError}</FormError>

      <Table<Row>
        columns={[
          { key: "order", label: "TO", width: "110px" },
          { key: "article", label: "Artikel", width: "minmax(160px, 1.4fr)" },
          { key: "operation", label: "Operation", width: "minmax(140px, 1fr)" },
          { key: "resource", label: "Resurs", width: "minmax(110px, 0.8fr)" },
          { key: "planned", label: "Planerad", width: "100px" },
          { key: "progress", label: "Klart / Kvar", width: "110px", align: "right" },
          { key: "ready", label: "Redo", width: "110px" },
          { key: "action", label: "", width: "120px" },
        ]}
        rows={shown}
        loading={rows === null && loadError === null}
        emptyText={search ? "Inga operationer matchar sökningen." : "Inga öppna operationer att rapportera."}
        renderCell={(row, key) => {
          switch (key) {
            case "order":
              return <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`}>{row.orderNumber}</GatedLink>;
            case "article":
              return (
                <>
                  {row.articleNumber} <span className={styles.muted}>{row.articleName}</span>
                </>
              );
            case "operation":
              return `${row.sequenceNo}${row.description ? ` — ${row.description}` : ""}`;
            case "resource":
              return `${row.workCenterCode} ${row.workCenterName}`;
            case "planned":
              return row.plannedStartDate ?? <span className={styles.muted}>–</span>;
            case "progress": {
              const p = rowProgress(row);
              return (
                <span className="num">
                  {formatQuantity(p.ok)} / {formatQuantity(p.remaining)}
                </span>
              );
            }
            case "ready":
              return readinessLabel(row);
            case "action":
              return (
                <Button type="button" variant="secondary" size="small" onClick={() => open(row)}>
                  Rapportera
                </Button>
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={cameraOpen} onClose={() => setCameraOpen(false)} title="Skanna med kameran">
        <CameraScanner onDecoded={scanned} />
      </Modal>

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `Rapportera ${target.orderNumber} op ${target.sequenceNo}` : ""}
      >
        {target && (
          <ReportForm
            key={target.operationId}
            row={target}
            employees={employees}
            employeeId={employeeId}
            onEmployeeId={setEmployeeId}
            date={date}
            onDate={setDate}
            suggestRest={suggestRest}
            timeKindSplit={timeKindSplit}
            onDone={(result, summary) => reported(target, result, summary)}
            onCancel={() => setTarget(null)}
          />
        )}
      </Modal>
    </>
  );
}

function ReportForm({
  row,
  employees,
  employeeId,
  onEmployeeId,
  date,
  onDate,
  suggestRest,
  timeKindSplit,
  onDone,
  onCancel,
}: {
  row: TerminalOperation;
  employees: EmployeeDirectoryEntry[];
  employeeId: string;
  onEmployeeId: (id: string) => void;
  date: string;
  onDate: (date: string) => void;
  suggestRest: boolean;
  timeKindSplit: boolean;
  onDone: (result: ReportResult, summary: ReportSummary) => void;
  onCancel: () => void;
}) {
  const p = rowProgress(row);
  // Typ: förval Produktion with Dela tid i ställ och produktion on.
  const [kind, setKind] = useState<TimeKind | "">(defaultReportKind(timeKindSplit));
  // Tid starts with what remains of the operation's planned time — setup +
  // run time per unit × order quantity, less the time already reported on
  // it (per Typ when the time is split) — the TO card's Rapportera tid rule
  // (suggestedReportHours). The operation's times and time reports are read
  // when the dialog opens; a time typed before they land wins ("manuellt
  // vinner"), and a failed read leaves the field empty.
  const [planned, setPlanned] = useState<{ operation: MOOperation | undefined; timeReports: TimeReport[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<MOOperation[]>(`/api/v1/manufacturing-orders/${row.manufacturingOrderId}/operations`),
      apiFetch<TimeReport[]>(`/api/v1/manufacturing-orders/${row.manufacturingOrderId}/time-reports`),
    ])
      .then(([operations, timeReports]) => {
        if (!cancelled) setPlanned({ operation: operations.find((op) => op.id === row.operationId), timeReports });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [row.manufacturingOrderId, row.operationId]);
  const [typedHours, setTypedHours] = useState<string | null>(null);
  const suggestedHours = planned
    ? suggestedReportHours(planned.operation, row.orderQuantity, planned.timeReports, timeKindSplit ? kind : "")
    : "";
  const hours = typedHours ?? (suggestedHours === "" ? "" : durationFromHours(suggestedHours));
  // The suggestion lands after Tid got its focus: select it then, so typing
  // replaces it instead of appending to it.
  useEffect(() => {
    if (planned === null) return;
    const field = document.getElementById("or-hours");
    if (field instanceof HTMLInputElement && document.activeElement === field && field.value !== "") field.select();
  }, [planned]);
  // Antal OK starts with Kvar — Rest som förslag i antalsfältet → Rapportering,
  // the TO card's box (on by default).
  const [quantityOk, setQuantityOk] = useState(() => restFieldValue(suggestRest, p.remaining));
  const [quantityScrapped, setQuantityScrapped] = useState("");
  const scrapReasonOptions = useScrapReasons();
  const reasonRegister = scrapReasonOptions !== null && scrapReasonOptions.length > 0;
  const [scrapReasonId, setScrapReasonId] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  // Operationen är klar follows Antal OK until it is ticked or unticked by hand.
  const [doneChoice, setDoneChoice] = useState<boolean | null>(null);
  const markDone = doneChoice ?? suggestsDone(row, quantityOk);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Anställd while none is chosen, else Tid — the next thing to type, its
  // suggestion selected so typing replaces it. A frame later: the Modal's
  // showModal() runs after this effect and focuses the dialog's first
  // control itself.
  const firstField = useRef(employeeId === "" ? "or-employee" : "or-hours");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const field = document.getElementById(firstField.current);
      field?.focus();
      if (field instanceof HTMLInputElement) field.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const employee = employees.find((emp) => emp.id === employeeId);
    if (!employee) {
      setError("Välj anställd");
      return;
    }
    if (date === "") {
      setError("Ange datum");
      return;
    }
    const minutes = parseDuration(hours);
    if (minutes === null || minutes <= 0) {
      setError(minutes === null ? `Tid: ${DURATION_HINT}` : "Ange en tid större än 0:00.");
      return;
    }
    const ok = Number(quantityOk) || 0;
    const scrapped = Number(quantityScrapped) || 0;
    if (scrapped > 0 && reasonRegister && !scrapReasonId) {
      setError("Välj en orsak när kasserat antal är större än 0");
      return;
    }
    if (scrapped > 0 && !reasonRegister && !scrapReason.trim()) {
      setError("Ange en kassationsorsak när kasserat antal är större än 0");
      return;
    }
    setBusy(true);
    try {
      const result = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch<ReportResult>("/api/v1/operation-reports", {
          method: "POST",
          body: JSON.stringify({
            moOperationId: row.operationId,
            employeeId,
            date,
            hours: hoursFromDuration(hours),
            ...(timeKindSplit && kind ? { kind } : {}),
            note: note.trim() || undefined,
            quantityOk: ok,
            quantityScrapped: scrapped,
            ...(scrapped > 0 && reasonRegister ? { scrapReasonId } : {}),
            scrapReason: scrapReason.trim() || undefined,
            markOperationDone: markDone,
            allowMaterialShortage,
          }),
        })
      );
      if (result === null) {
        setBusy(false);
        return;
      }
      onDone(result, { employeeName: employee.name, minutes, quantityOk: ok, quantityScrapped: scrapped, markedDone: markDone });
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte rapportera"));
      setBusy(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormHint>
        {row.articleNumber} {row.articleName} · {row.workCenterCode} {row.workCenterName}
        {row.description && row.description !== row.workCenterName ? ` · ${row.description}` : ""}
      </FormHint>
      <FormHint>
        Planerat {formatQuantity(p.planned)} · Klart {formatQuantity(p.ok)}
        {p.scrapped > 0 && <> · Kasserat {formatQuantity(p.scrapped)}</>} · Kvar {formatQuantity(p.remaining)}
      </FormHint>
      <Field label="Anställd" htmlFor="or-employee">
        <Select
          id="or-employee"
          required
          value={employeeId}
          onChange={(e) => onEmployeeId(e.target.value)}
        >
          <option value="">Välj anställd…</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.employeeNumber} — {emp.name}
            </option>
          ))}
        </Select>
      </Field>
      <FormRow>
        <Field label="Datum" htmlFor="or-date">
          <Input id="or-date" type="date" required size="sm" value={date} onChange={(e) => onDate(e.target.value)} />
        </Field>
        <Field label="Tid (tt:mm)" htmlFor="or-hours">
          <DurationInput id="or-hours" required size="sm" value={hours} onValueChange={setTypedHours} />
        </Field>
      </FormRow>
      {timeKindSplit && (
        <Field label="Typ" htmlFor="or-kind">
          <Select id="or-kind" value={kind} onChange={(e) => setKind(e.target.value as TimeKind | "")}>
            <option value="">Ej uppdelad</option>
            <option value="setup">Ställ</option>
            <option value="run">Produktion</option>
          </Select>
        </Field>
      )}
      <FormRow>
        <Field label="Antal OK" htmlFor="or-ok">
          <Input id="or-ok" type="number" min="0" step="any" size="sm" value={quantityOk} onChange={(e) => setQuantityOk(e.target.value)} />
        </Field>
        <Field label="Kasserat" htmlFor="or-scrap">
          <Input
            id="or-scrap"
            type="number"
            min="0"
            step="any"
            size="sm"
            value={quantityScrapped}
            onChange={(e) => setQuantityScrapped(e.target.value)}
          />
        </Field>
      </FormRow>
      {(Number(quantityScrapped) || 0) > 0 && (
        <ScrapReasonFields
          idPrefix="or"
          reasons={scrapReasonOptions}
          reasonId={scrapReasonId}
          text={scrapReason}
          onReasonId={setScrapReasonId}
          onText={setScrapReason}
        />
      )}
      <label className={styles.checkRow}>
        <Checkbox checked={markDone} onChange={(e) => setDoneChoice(e.target.checked)} />
        Operationen är klar
      </label>
      <Field label="Anteckning (valfritt)" htmlFor="or-note">
        <Input id="or-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Rapporterar…" : "Rapportera"}
        </Button>
      </FormActions>
    </Form>
  );
}

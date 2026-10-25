"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormRow, FormSaved } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import {
  amountText,
  distributeRow,
  isBudgetableAccount,
  isBlankRow,
  monthShortLabel,
  monthSums,
  parseAmount,
  rowSum,
  rowsSignature,
  sumOf,
  toPutLines,
  type BudgetEditRow,
} from "../../lib/budget";
import { confirmDialog } from "../../lib/confirm";
import { useDimensions } from "../../lib/dimensions";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import type {
  Account,
  BudgetActualsResponse,
  BudgetCsvParseResult,
  BudgetDetail,
  BudgetGridLine,
  FiscalYear,
} from "../../lib/types";
import buttonStyles from "../ui/Button.module.css";
import shellStyles from "../AppShell.module.css";
import { AccountCell } from "./VerificationRowsEditor";
import styles from "./Budget.module.css";

// "total" = the read-only sum over every cost centre, "none" = Ej fördelat,
// anything else is a cost centre id.
type TabKey = "total" | "none" | (string & {});

let rowCounter = 0;
const newKey = () => `b${++rowCounter}`;

function emptyRow(months: number): BudgetEditRow {
  return { key: newKey(), accountNumber: "", accountName: "", amounts: new Array<string>(months).fill(""), annual: null };
}

function toEditRow(line: { accountNumber: string; accountName: string | null; amounts: number[] }, months: number): BudgetEditRow {
  return {
    key: newKey(),
    accountNumber: line.accountNumber,
    accountName: line.accountName ?? "",
    amounts: Array.from({ length: months }, (_, i) => amountText(line.amounts[i] ?? 0)),
    annual: null,
  };
}

// The rows of one tab. "Totalt" adds up every line of the account.
function rowsForTab(detail: BudgetDetail, tab: TabKey): BudgetEditRow[] {
  const months = detail.months.length;
  if (tab === "total") {
    const byAccount = new Map<string, { accountNumber: string; accountName: string | null; amounts: number[] }>();
    for (const line of detail.lines) {
      const entry = byAccount.get(line.accountNumber) ?? {
        accountNumber: line.accountNumber,
        accountName: line.accountName,
        amounts: new Array<number>(months).fill(0),
      };
      for (let i = 0; i < months; i++) entry.amounts[i] = round2(entry.amounts[i]! + (line.amounts[i] ?? 0));
      byAccount.set(line.accountNumber, entry);
    }
    return [...byAccount.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)).map((l) => toEditRow(l, months));
  }
  const costCenterId = tab === "none" ? null : tab;
  return detail.lines.filter((l) => l.costCenterId === costCenterId).map((l) => toEditRow(l, months));
}

function previousYearId(years: FiscalYear[], detail: BudgetDetail): string {
  const before = years
    .filter((y) => y.id !== detail.fiscalYearId && y.endDate < detail.fiscalYearStart)
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  return before[0]?.id ?? years.find((y) => y.id !== detail.fiscalYearId)?.id ?? "";
}

// Ekonomi → Budget → a budget: the grid of accounts × months, one tab per
// cost centre (plus Ej fördelat and a read-only Totalt).
export function BudgetDetailPageClient({
  initial,
  accounts,
  fiscalYears,
  dropped,
}: {
  initial: BudgetDetail;
  accounts: Account[];
  fiscalYears: FiscalYear[];
  dropped: number;
}) {
  const dims = useDimensions();
  const [detail, setDetail] = useState(initial);
  const [name, setName] = useState(initial.name);
  const hasCostCenterLines = initial.lines.some((l) => l.costCenterId !== null);
  const [tab, setTab] = useState<TabKey>(hasCostCenterLines ? "total" : "none");
  const [rows, setRows] = useState<BudgetEditRow[]>(() => rowsForTab(initial, hasCostCenterLines ? "total" : "none"));
  const [baseline, setBaseline] = useState(() => rowsSignature(rowsForTab(initial, hasCostCenterLines ? "total" : "none")));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRows, setErrorRows] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [actualsOpen, setActualsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const months = detail.months.length;
  const readOnly = tab === "total";
  const rowsDirty = !readOnly && rowsSignature(rows) !== baseline;
  const nameDirty = name.trim() !== detail.name;
  const dirty = rowsDirty || nameDirty;
  useUnsavedGuard(dirty);

  const budgetAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.active && isBudgetableAccount(a.number))
        .sort((a, b) => a.number.localeCompare(b.number))
        .map((a) => ({ number: a.number, name: a.name })),
    [accounts]
  );

  // Cost-centre tabs: the active ones, plus any inactive one that has lines.
  const withLines = new Set(detail.lines.map((l) => l.costCenterId).filter((id): id is string => id !== null));
  const costCenters = dims.allCostCenters.filter((c) => c.active || withLines.has(c.id));
  const showTabs = costCenters.length > 0 || withLines.size > 0;
  const tabs: { key: TabKey; label: string }[] = [
    ...(withLines.size > 0 ? [{ key: "total" as TabKey, label: "Totalt" }] : []),
    { key: "none", label: "Ej fördelat" },
    ...costCenters.map((c) => ({ key: c.id as TabKey, label: `${c.code} · ${c.name}` })),
  ];
  const tabLabel = tabs.find((t) => t.key === tab)?.label ?? "Ej fördelat";
  const hasRegister = dims.allCostCenters.length > 0 || withLines.size > 0;
  // The cost-centre parameter of the actuals/CSV calls for the active tab.
  const tabParam = !hasRegister || tab === "total" ? null : tab === "none" ? "none" : tab;

  function load(next: BudgetDetail, key: TabKey) {
    const list = rowsForTab(next, key);
    setRows(list);
    setBaseline(rowsSignature(list));
  }

  async function switchTab(key: TabKey) {
    if (key === tab) return;
    if (rowsDirty) {
      const ok = await confirmDialog("Fliken har osparade ändringar som går förlorade om du byter flik — byta ändå?", {
        confirmLabel: "Byt flik",
        danger: true,
      });
      if (!ok) return;
    }
    setTab(key);
    load(detail, key);
    setError(null);
    setErrorRows([]);
    setNotice(null);
    setSaved(false);
  }

  function patchRow(key: string, patch: Partial<BudgetEditRow>) {
    setSaved(false);
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function setAmount(key: string, month: number, value: string) {
    setSaved(false);
    setRows((list) =>
      list.map((r) =>
        r.key === key ? { ...r, amounts: r.amounts.map((a, i) => (i === month ? value : a)), annual: null } : r
      )
    );
  }

  function focusCell(rowIndex: number, col: string) {
    containerRef.current?.querySelector<HTMLElement>(`[data-cell="${rowIndex}:${col}"]`)?.focus();
  }

  function addRow() {
    setSaved(false);
    setRows((list) => [...list, emptyRow(months)]);
    setTimeout(() => focusCell(rows.length, "account"), 0);
  }

  function removeRow(key: string) {
    setSaved(false);
    setRows((list) => list.filter((r) => r.key !== key));
  }

  function distribute(key: string) {
    setSaved(false);
    setRows((list) => list.map((r) => (r.key === key ? distributeRow(r) : r)));
  }

  function amountKeyDown(e: KeyboardEvent<HTMLInputElement>, rowIndex: number, col: number) {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (col < months - 1) focusCell(rowIndex, `m${col + 1}`);
      else focusCell(rowIndex, "annual");
    }
  }

  function containerKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      setTimeout(() => void save(), 0);
    }
  }

  async function save() {
    if (pending || !dirty) return;
    setError(null);
    setErrorRows([]);
    setNotice(null);
    setSaved(false);
    const trimmed = name.trim();
    if (trimmed === "") return setError("Ange ett namn.");
    const put = rowsDirty ? toPutLines(rows) : null;
    if (put?.error) return setError(put.error);
    setPending(true);
    try {
      let current = detail;
      if (nameDirty) {
        await apiFetch(`/api/v1/budgets/${detail.id}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) });
        current = { ...current, name: trimmed };
        setDetail(current);
      }
      if (put) {
        current = await apiFetch<BudgetDetail>(`/api/v1/budgets/${detail.id}/lines`, {
          method: "PUT",
          body: JSON.stringify({ costCenterId: tab === "none" ? null : tab, lines: put.lines }),
        });
        setDetail(current);
        setName(current.name);
        load(current, tab);
      }
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte sparas"));
    } finally {
      setPending(false);
    }
  }

  async function makeDefault() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/budgets/${detail.id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) });
      setDetail((d) => ({ ...d, isDefault: true }));
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte göras förvald"));
    } finally {
      setPending(false);
    }
  }

  // Replaces the tab's rows with `lines` — nothing is saved until Spara.
  async function replaceRows(lines: BudgetGridLine[]): Promise<boolean> {
    if (rows.some((r) => !isBlankRow(r))) {
      const ok = await confirmDialog(`Raderna på fliken ${tabLabel} ersätts — de sparas först när du klickar på Spara.`, {
        confirmLabel: "Ersätt raderna",
        danger: true,
      });
      if (!ok) return false;
    }
    setSaved(false);
    setRows(lines.map((l) => toEditRow(l, months)));
    return true;
  }

  async function importCsv(file: File) {
    setError(null);
    setErrorRows([]);
    setNotice(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      // Multipart — apiFetch would send a JSON content type.
      const res = await fetch(`${API_URL}/api/v1/budgets/${detail.id}/csv/parse`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new ApiError(payload.error ?? "Filen kunde inte läsas", res.status, payload.code, payload);
      }
      const result = (await res.json()) as BudgetCsvParseResult;
      if (result.errors.length > 0) {
        setError("Filen innehåller fel — inget har lästs in.");
        setErrorRows(result.errors.map((e) => `Rad ${e.row}: ${e.message}`));
        return;
      }
      const tabCostCenter = tab === "none" ? null : tab;
      const mine = result.lines.filter((l) => l.costCenterId === tabCostCenter);
      const others = result.lines.length - mine.length;
      if (mine.length === 0) {
        setError(`Filen innehåller inga rader för fliken ${tabLabel}.`);
        return;
      }
      if (await replaceRows(mine)) {
        setNotice(
          `${mine.length} rader har lästs in i fliken ${tabLabel} — kontrollera dem och klicka på Spara.` +
            (others > 0 ? ` ${others} rader för andra kostnadsställen i filen hoppades över.` : "")
        );
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Filen kunde inte läsas"));
    } finally {
      setPending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const sums = useMemo(() => monthSums(rows, months), [rows, months]);
  const csvHref = `${API_URL}/api/v1/budgets/${detail.id}/csv${tabParam ? `?costCenterId=${tabParam}` : ""}`;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{detail.name}</div>
          <div className={shellStyles.meta}>Räkenskapsår {detail.fiscalYearLabel}</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/ekonomi/budget" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Alla budgetar
          </Link>
          <HelpLink chapter="ekonomi" anchor="budget" label="Hjälp om budget" />
        </div>
      </div>

      <Card maxWidth="none">
        <FormRow>
          <Field label="Namn" htmlFor="budgetName">
            <Input id="budgetName" className={styles.name} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Förvald budget" htmlFor="budgetDefault">
            {detail.isDefault ? (
              <span id="budgetDefault">
                <StatusPill status="running" label="Förvald" compact />
              </span>
            ) : (
              <span>
                <Button id="budgetDefault" type="button" variant="secondary" size="small" disabled={pending} onClick={() => void makeDefault()}>
                  Gör förvald
                </Button>
              </span>
            )}
          </Field>
        </FormRow>

        {dropped > 0 && (
          <p className={styles.notice}>
            {dropped === 1 ? "1 månad" : `${dropped} månader`} i källbudgeten fick inte plats i räkenskapsårets perioder och
            lämnades utanför.
          </p>
        )}

        {showTabs && (
          <div className={styles.tabStrip} role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={t.key === tab}
                className={styles.tab}
                data-active={t.key === tab}
                onClick={() => void switchTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className={styles.toolbar}>
          <Button type="button" variant="secondary" size="small" disabled={readOnly || pending} onClick={() => setActualsOpen(true)}>
            Kopiera utfall från föregående år
          </Button>
          <a href={csvHref} download className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.small}`}>
            Exportera CSV
          </a>
          <Button type="button" variant="secondary" size="small" disabled={readOnly || pending} onClick={() => fileRef.current?.click()}>
            Importera CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            aria-label="Välj CSV-fil att importera"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importCsv(file);
            }}
          />
          {!readOnly && (
            <Button type="button" variant="secondary" size="small" disabled={pending} onClick={addRow}>
              + Lägg till rad
            </Button>
          )}
        </div>

        {readOnly && (
          <p className={styles.notice}>Totalt är summan av alla kostnadsställen och kan inte ändras — välj en annan flik för att redigera.</p>
        )}
        {notice && <p className={styles.notice}>{notice}</p>}
        <FormError>{error}</FormError>
        {errorRows.length > 0 && (
          <ul className={styles.errorList}>
            {errorRows.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        <div ref={containerRef} className={styles.scroller} onKeyDown={containerKeyDown}>
          <table className={styles.grid} aria-label="Budgetrutnät">
            <thead>
              <tr>
                <th className={styles.accountCell}>Konto</th>
                {detail.months.map((m) => (
                  <th key={m.month} className={styles.monthCell} title={`${m.startDate} – ${m.endDate}`}>
                    {monthShortLabel(m.label)}
                  </th>
                ))}
                <th className={styles.sumCell}>Summa</th>
                {!readOnly && <th className={styles.actionCell} />}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className={styles.empty} colSpan={months + 3}>
                    {readOnly ? "Budgeten har inga rader än." : "Fliken har inga rader — klicka på + Lägg till rad."}
                  </td>
                </tr>
              )}
              {rows.map((row, rowIndex) => {
                const n = rowIndex + 1;
                const sum = rowSum(row);
                return (
                  <tr key={row.key}>
                    <td className={styles.accountCell}>
                      {readOnly ? (
                        <span className={styles.readonlyAmount} style={{ textAlign: "left" }}>
                          {row.accountNumber} · {row.accountName}
                        </span>
                      ) : (
                        <div style={{ position: "relative" }}>
                          <AccountCell
                            cellId={`${rowIndex}:account`}
                            row={row}
                            accounts={budgetAccounts}
                            disabled={pending}
                            label={`Konto, rad ${n}`}
                            onCommit={(number) =>
                              patchRow(row.key, {
                                accountNumber: number,
                                accountName: budgetAccounts.find((a) => a.number === number)?.name ?? "",
                              })
                            }
                            onEnter={() => focusCell(rowIndex, "m0")}
                          />
                        </div>
                      )}
                    </td>
                    {row.amounts.map((a, i) => (
                      <td key={i} className={styles.monthCell}>
                        {readOnly ? (
                          <span className={`${styles.readonlyAmount} num`}>{a === "" ? "" : formatMoney(parseAmount(a))}</span>
                        ) : (
                          <input
                            data-cell={`${rowIndex}:m${i}`}
                            className={`${styles.input} ${styles.amount}`}
                            type="number"
                            step="any"
                            inputMode="decimal"
                            aria-label={`${monthShortLabel(detail.months[i]?.label ?? "")}, rad ${n}`}
                            disabled={pending}
                            value={a}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => setAmount(row.key, i, e.target.value)}
                            onKeyDown={(e) => amountKeyDown(e, rowIndex, i)}
                          />
                        )}
                      </td>
                    ))}
                    <td className={styles.sumCell}>
                      {readOnly ? (
                        <span className={`${styles.readonlyAmount} num`}>{formatMoney(sum)}</span>
                      ) : (
                        <input
                          data-cell={`${rowIndex}:annual`}
                          className={`${styles.input} ${styles.amount}`}
                          type="number"
                          step="any"
                          inputMode="decimal"
                          aria-label={`Summa, rad ${n}`}
                          disabled={pending}
                          value={row.annual ?? (sum === 0 ? "" : String(sum))}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => patchRow(row.key, { annual: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                              e.preventDefault();
                              distribute(row.key);
                              if (rowIndex < rows.length - 1) focusCell(rowIndex + 1, "account");
                            }
                          }}
                        />
                      )}
                    </td>
                    {!readOnly && (
                      <td className={styles.actionCell}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          title="Fördela årsbelopp jämnt"
                          aria-label={`Fördela årsbelopp jämnt, rad ${n}`}
                          disabled={pending}
                          onClick={() => distribute(row.key)}
                        >
                          Fördela
                        </Button>
                        <button
                          type="button"
                          tabIndex={-1}
                          className={styles.removeButton}
                          aria-label={`Ta bort rad ${n}`}
                          title="Ta bort raden"
                          disabled={pending}
                          onClick={() => removeRow(row.key)}
                        >
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {(
                [
                  ["Intäkter", sums.revenue],
                  ["Kostnader", sums.costs],
                  ["Resultat", sums.result],
                ] as const
              ).map(([label, values]) => (
                <tr key={label} className={styles.summaryRow}>
                  <td className={styles.accountCell}>
                    <span className={styles.readonlyAmount} style={{ textAlign: "left" }}>
                      {label}
                    </span>
                  </td>
                  {values.map((v, i) => (
                    <td key={i} className={styles.monthCell}>
                      <span className={`${styles.readonlyAmount} num ${label === "Resultat" && v < 0 ? styles.negative : ""}`}>
                        {formatMoney(v)}
                      </span>
                    </td>
                  ))}
                  <td className={styles.sumCell}>
                    <span className={`${styles.readonlyAmount} num ${label === "Resultat" && sumOf(values) < 0 ? styles.negative : ""}`}>
                      {formatMoney(sumOf(values))}
                    </span>
                  </td>
                  {!readOnly && <td className={styles.actionCell} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
          <Button type="button" variant="primary" disabled={pending || !dirty} onClick={() => void save()}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && !dirty && <FormSaved>Sparat</FormSaved>}
        </div>
      </Card>

      <ActualsDialog
        open={actualsOpen}
        onClose={() => setActualsOpen(false)}
        budgetId={detail.id}
        fiscalYears={fiscalYears.filter((y) => y.id !== detail.fiscalYearId)}
        defaultYearId={previousYearId(fiscalYears, detail)}
        tabLabel={tabLabel}
        costCenterParam={tabParam}
        onLoaded={async (lines, yearLabel) => {
          if (await replaceRows(lines)) {
            setNotice(`Utfallet från ${yearLabel} har lästs in i fliken ${tabLabel} — kontrollera det och klicka på Spara.`);
            return true;
          }
          return false;
        }}
      />
    </>
  );
}

function ActualsDialog({
  open,
  onClose,
  budgetId,
  fiscalYears,
  defaultYearId,
  tabLabel,
  costCenterParam,
  onLoaded,
}: {
  open: boolean;
  onClose: () => void;
  budgetId: string;
  fiscalYears: FiscalYear[];
  defaultYearId: string;
  tabLabel: string;
  costCenterParam: string | null;
  onLoaded: (lines: BudgetGridLine[], yearLabel: string) => Promise<boolean>;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Kopiera utfall från föregående år">
      <ActualsForm
        budgetId={budgetId}
        fiscalYears={fiscalYears}
        defaultYearId={defaultYearId}
        tabLabel={tabLabel}
        costCenterParam={costCenterParam}
        onLoaded={async (lines, label) => {
          if (await onLoaded(lines, label)) onClose();
        }}
        onCancel={onClose}
      />
    </Modal>
  );
}

function ActualsForm({
  budgetId,
  fiscalYears,
  defaultYearId,
  tabLabel,
  costCenterParam,
  onLoaded,
  onCancel,
}: {
  budgetId: string;
  fiscalYears: FiscalYear[];
  defaultYearId: string;
  tabLabel: string;
  costCenterParam: string | null;
  onLoaded: (lines: BudgetGridLine[], yearLabel: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [yearId, setYearId] = useState(defaultYearId);
  const [percent, setPercent] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const pct = parseAmount(percent);
    if (pct < -100 || pct > 1000) return setError("Procent måste ligga mellan −100 och 1000.");
    if (!yearId) return setError("Välj ett räkenskapsår att hämta utfall från.");
    setError(null);
    setPending(true);
    try {
      const query = new URLSearchParams({ sourceFiscalYearId: yearId, percent: String(pct) });
      if (costCenterParam) query.set("costCenterId", costCenterParam);
      const result = await apiFetch<BudgetActualsResponse>(`/api/v1/budgets/${budgetId}/actuals?${query.toString()}`);
      await onLoaded(result.lines, fiscalYears.find((y) => y.id === yearId)?.label ?? "källåret");
    } catch (err) {
      setError(apiErrorMessage(err, "Utfallet kunde inte hämtas"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <p className={styles.dialogHint}>
        Utfallet per konto och månad läggs in i fliken {tabLabel}, avrundat till hela kronor. Inget sparas förrän du klickar på Spara.
      </p>
      <FormError>{error}</FormError>
      <Field label="Räkenskapsår" htmlFor="actualsYear">
        <Select id="actualsYear" value={yearId} onChange={(e) => setYearId(e.target.value)}>
          {fiscalYears.length === 0 && <option value="">— Inga andra räkenskapsår —</option>}
          {fiscalYears.map((y) => (
            <option key={y.id} value={y.id}>
              {y.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Påslag eller avdrag (%)" htmlFor="actualsPercent">
        <Input id="actualsPercent" type="number" step="any" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" variant="primary" disabled={pending || fiscalYears.length === 0}>
          {pending ? "Hämtar…" : "Hämta utfall"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </form>
  );
}

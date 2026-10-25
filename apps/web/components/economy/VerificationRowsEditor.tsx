"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { useDimensions } from "../../lib/dimensions";
import { formatMoney } from "../../lib/format";
import { splitVat, splitVatApplies } from "../../lib/splitVat";
import { vatCodeOptionLabel, type VatCodeView } from "../../lib/vatCodes";
import {
  amountOf,
  counterRow,
  emptyRow,
  isBlankRow,
  matchAccounts,
  rowTotals,
  type EditorRow,
} from "../../lib/verificationRows";
import styles from "./VerificationRowsEditor.module.css";

export interface EditorAccount {
  number: string;
  name: string;
}

type ColKey = "account" | "description" | "vatCode" | "costCenter" | "project" | "debit" | "credit";

const COL_LABELS: Record<ColKey, string> = {
  account: "Konto",
  description: "Beskrivning",
  vatCode: "Momskod",
  costCenter: "Kostnadsställe",
  project: "Projekt",
  debit: "Debet",
  credit: "Kredit",
};

// The EditorRow field a column edits (Esc restores it).
const ROW_FIELD: Record<ColKey, keyof EditorRow> = {
  account: "accountNumber",
  description: "description",
  vatCode: "vatCode",
  costCenter: "costCenterId",
  project: "projectId",
  debit: "debit",
  credit: "credit",
};

// Kostnadsställe/Projekt columns are shown or hidden with a checkbox; the
// choice is remembered in this browser (localStorage can throw — private
// mode, blocked site data — so every access is guarded).
const DIMENSIONS_KEY = "nav:verification-dimensions";

function readDimensionsPreference(): boolean | null {
  try {
    const raw = window.localStorage.getItem(DIMENSIONS_KEY);
    return raw === "true" ? true : raw === "false" ? false : null;
  } catch {
    return null;
  }
}

function writeDimensionsPreference(value: boolean) {
  try {
    window.localStorage.setItem(DIMENSIONS_KEY, String(value));
  } catch {
    // Not remembered — the checkbox still works for this visit.
  }
}

function valueOf(row: EditorRow, col: ColKey): string {
  switch (col) {
    case "account":
      return row.accountNumber;
    case "description":
      return row.description;
    case "vatCode":
      return row.vatCode;
    case "costCenter":
      return row.costCenterId;
    case "project":
      return row.projectId;
    case "debit":
      return row.debit;
    case "credit":
      return row.credit;
  }
}

interface EditorProps {
  rows: EditorRow[];
  onChange: (rows: EditorRow[]) => void;
  // Active accounts, in number order.
  accounts: EditorAccount[];
  // Given ⇒ the Momskod column (verifikat); omitted ⇒ no column (mallar).
  vatCodes?: VatCodeView[];
  // Ctrl+Enter anywhere in the table.
  onSave?: () => void;
  // Motrad: a new row carries the difference (off for templates).
  counterRows?: boolean;
  showBalance?: boolean;
  disabled?: boolean;
  // Kostnadsställe och Projekt: the checkbox and the two columns (on by
  // default; the editor reads the two registers itself).
  dimensions?: boolean;
}

// The editable rows table of a verification/template: Konto (searchable),
// Beskrivning, Momskod, Debet, Kredit. Tab/Enter move to the next cell, Enter
// in the last cell of the last row adds a row (prefilled with the difference),
// Ctrl+Enter saves, Esc undoes the cell. Controlled: the parent owns `rows`.
export function VerificationRowsEditor({
  rows,
  onChange,
  accounts,
  vatCodes,
  onSave,
  counterRows = true,
  showBalance = true,
  disabled = false,
  dimensions = true,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const pendingFocus = useRef<{ key: string; col: ColKey } | null>(null);
  const snapshot = useRef<{ key: string; col: ColKey; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const withVat = vatCodes !== undefined;

  // Hidden unless the user chose to show them — or a row already carries one,
  // which must never be invisible. Read after mount (the server render has no
  // localStorage), so the first paint is the hidden state.
  const dims = useDimensions();
  const hasObjects = dims.allCostCenters.length > 0 || dims.allProjects.length > 0;
  const rowsHaveDimensions = rows.some((r) => r.costCenterId !== "" || r.projectId !== "");
  const [dimensionsChoice, setDimensionsChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setDimensionsChoice(readDimensionsPreference());
  }, []);
  const dimensionsAvailable = dimensions && (hasObjects || rowsHaveDimensions);
  const withDims = dimensionsAvailable && (rowsHaveDimensions || dimensionsChoice === true);

  const cols: ColKey[] = [
    "account",
    "description",
    ...(withVat ? (["vatCode"] as ColKey[]) : []),
    ...(withDims ? (["costCenter", "project"] as ColKey[]) : []),
    "debit",
    "credit",
  ];
  // Desktop grid; the stacked card layout takes over below the breakpoints
  // in the stylesheet.
  const gridColumns = [
    withDims ? "minmax(150px, 1.3fr)" : "minmax(190px, 1.5fr)",
    withDims ? "minmax(100px, 1fr)" : "minmax(120px, 1fr)",
    ...(withVat ? [withDims ? "130px" : "minmax(150px, 1fr)"] : []),
    ...(withDims ? ["minmax(96px, 0.8fr)", "minmax(96px, 0.8fr)"] : []),
    withDims ? "110px" : "118px",
    withDims ? "110px" : "118px",
    "34px",
  ].join(" ");
  const splittable = (vatCodes ?? []).filter((c) => c.active && splitVatApplies(c));

  // Cells are addressed by row INDEX, not by the row's key: the keys come from
  // a client-side counter, so a server-rendered page hydrates with other keys
  // in its attributes (React does not patch attributes on hydration) and a
  // key-based lookup would find nothing.
  function focusCell(key: string, col: ColKey) {
    const index = rowsRef.current.findIndex((r) => r.key === key);
    if (index < 0) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-cell="${index}:${col}"]`);
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement && col !== "account") el.select();
  }

  // A row added or a split made re-renders first; focus lands afterwards.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target) {
      pendingFocus.current = null;
      focusCell(target.key, target.col);
    }
  });

  function commit(next: EditorRow[]) {
    rowsRef.current = next;
    onChange(next);
  }

  function patchRow(key: string, patch: Partial<EditorRow>) {
    commit(rowsRef.current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function nameOf(number: string): string {
    return accounts.find((a) => a.number === number)?.name ?? "";
  }

  function addRow(focus = true) {
    const row = counterRows ? counterRow(rowsRef.current) : emptyRow();
    if (focus) pendingFocus.current = { key: row.key, col: "account" };
    commit([...rowsRef.current, row]);
  }

  function removeRow(key: string) {
    commit(rowsRef.current.filter((r) => r.key !== key));
  }

  // Momshjälp: the row's amount is interpreted per its Momskod when the cell
  // (or the amount after it) is left; the code is then cleared — it is never
  // stored, the server only sees ordinary rows.
  function applySplit(key: string) {
    const list = rowsRef.current;
    const index = list.findIndex((r) => r.key === key);
    const row = list[index];
    if (!row || row.vatCode === "") return;
    const code = vatCodes?.find((c) => c.code === row.vatCode);
    const debit = amountOf(row.debit);
    const credit = amountOf(row.credit);
    const side = debit > 0 ? "debit" : credit > 0 ? "credit" : null;
    if (!code || !side) return; // no amount yet — keep the code until there is one
    const result = splitVat(side === "debit" ? debit : credit, code, side);
    if (result.error) {
      setNotice(result.error);
      patchRow(key, { vatCode: "" });
      return;
    }
    const extra = result.rows.map((r) =>
      emptyRow({
        accountNumber: r.accountNumber,
        accountName: nameOf(r.accountNumber),
        description: r.description,
        [r.side]: String(r.amount),
      })
    );
    const missing = result.rows.filter((r) => !accounts.some((a) => a.number === r.accountNumber));
    setNotice(
      missing.length > 0
        ? `Momskontot ${missing.map((r) => r.accountNumber).join(", ")} finns inte eller är inaktivt — välj ett annat konto på momsraden.`
        : null
    );
    commit([
      ...list.slice(0, index),
      { ...row, vatCode: "", [side]: String(result.net) },
      ...extra,
      ...list.slice(index + 1),
    ]);
  }

  function advance(key: string, col: ColKey) {
    applySplit(key);
    const list = rowsRef.current;
    const rowIndex = list.findIndex((r) => r.key === key);
    if (rowIndex < 0) return;
    const colIndex = cols.indexOf(col);
    if (colIndex < cols.length - 1) {
      focusCell(key, cols[colIndex + 1]!);
      return;
    }
    // After a split the VAT rows sit directly below — continue from the last
    // of them, i.e. the row that follows in the list.
    if (rowIndex < list.length - 1) {
      focusCell(list[rowIndex + 1]!.key, cols[0]!);
      return;
    }
    if (isBlankRow(list[rowIndex]!)) return;
    addRow();
  }

  function revert(key: string, col: ColKey) {
    const snap = snapshot.current;
    if (!snap || snap.key !== key || snap.col !== col) return;
    patchRow(key, { [ROW_FIELD[col]]: snap.value } as Partial<EditorRow>);
  }

  function rememberCell(row: EditorRow, col: ColKey) {
    snapshot.current = { key: row.key, col, value: valueOf(row, col) };
  }

  function cellKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, key: string, col: ColKey) {
    if (e.ctrlKey || e.metaKey) return; // Ctrl+Enter is handled by the table
    if (e.key === "Enter") {
      e.preventDefault();
      advance(key, col);
    } else if (e.key === "Escape") {
      e.preventDefault();
      revert(key, col);
    }
  }

  function tableKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      const active = document.activeElement?.getAttribute("data-cell");
      const activeRow = active ? rowsRef.current[Number(active.split(":")[0])] : undefined;
      if (activeRow) applySplit(activeRow.key);
      // After React has applied the split (the parent's handler is the latest).
      setTimeout(() => onSaveRef.current?.(), 0);
    }
  }

  const totals = rowTotals(rows);

  return (
    <div>
      <div
        ref={containerRef}
        className={`${styles.editor} ${withDims ? styles.withDims : ""}`}
        style={{ "--editor-cols": gridColumns } as React.CSSProperties}
        role="group"
        aria-label="Verifikatrader"
        onKeyDown={tableKeyDown}
      >
        <div className={styles.headerRow}>
          {cols.map((col) => (
            <div key={col} className={col === "debit" || col === "credit" ? styles.right : undefined}>
              {COL_LABELS[col]}
            </div>
          ))}
          <div />
        </div>

        {rows.map((row, rowIndex) => {
          const n = rowIndex + 1;
          return (
            <div className={styles.row} key={row.key}>
              <div className={`${styles.cell} ${styles.cellAccount}`}>
                <span className={styles.mobileLabel}>Konto</span>
                <AccountCell
                  cellId={`${rowIndex}:account`}
                  row={row}
                  accounts={accounts}
                  disabled={disabled}
                  label={`Konto, rad ${n}`}
                  onCommit={(number) => patchRow(row.key, { accountNumber: number, accountName: nameOf(number) })}
                  onEnter={() => advance(row.key, "account")}
                />
              </div>
              <div className={`${styles.cell} ${styles.cellDescription}`}>
                <span className={styles.mobileLabel}>Beskrivning</span>
                <input
                  data-cell={`${rowIndex}:description`}
                  className={styles.input}
                  aria-label={`Beskrivning, rad ${n}`}
                  maxLength={255}
                  disabled={disabled}
                  value={row.description}
                  onFocus={() => rememberCell(row, "description")}
                  onChange={(e) => patchRow(row.key, { description: e.target.value })}
                  onKeyDown={(e) => cellKeyDown(e, row.key, "description")}
                />
              </div>
              {withVat && (
                <div className={`${styles.cell} ${styles.cellVat}`}>
                  <span className={styles.mobileLabel}>Momskod</span>
                  <select
                    data-cell={`${rowIndex}:vatCode`}
                    className={styles.input}
                    aria-label={`Momskod, rad ${n}`}
                    disabled={disabled}
                    value={row.vatCode}
                    onFocus={() => rememberCell(row, "vatCode")}
                    onChange={(e) => patchRow(row.key, { vatCode: e.target.value })}
                    onBlur={() => applySplit(row.key)}
                    onKeyDown={(e) => cellKeyDown(e, row.key, "vatCode")}
                  >
                    <option value="">—</option>
                    {splittable.map((c) => (
                      <option key={c.code} value={c.code}>
                        {vatCodeOptionLabel(c)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {withDims && (
                <>
                  <div className={`${styles.cell} ${styles.cellCostCenter}`}>
                    <span className={styles.mobileLabel}>Kostnadsställe</span>
                    <DimensionCell
                      cellId={`${rowIndex}:costCenter`}
                      label={`Kostnadsställe, rad ${n}`}
                      disabled={disabled}
                      value={row.costCenterId}
                      currentLabel={row.costCenterLabel}
                      options={dims.costCenters.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
                      onFocus={() => rememberCell(row, "costCenter")}
                      onChange={(id) => patchRow(row.key, { costCenterId: id, costCenterLabel: "" })}
                      onKeyDown={(e) => cellKeyDown(e, row.key, "costCenter")}
                    />
                  </div>
                  <div className={`${styles.cell} ${styles.cellProject}`}>
                    <span className={styles.mobileLabel}>Projekt</span>
                    <DimensionCell
                      cellId={`${rowIndex}:project`}
                      label={`Projekt, rad ${n}`}
                      disabled={disabled}
                      value={row.projectId}
                      currentLabel={row.projectLabel}
                      options={dims.projects.map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` }))}
                      onFocus={() => rememberCell(row, "project")}
                      onChange={(id) => patchRow(row.key, { projectId: id, projectLabel: "" })}
                      onKeyDown={(e) => cellKeyDown(e, row.key, "project")}
                    />
                  </div>
                </>
              )}
              <div className={`${styles.cell} ${styles.cellDebit}`}>
                <span className={styles.mobileLabel}>Debet</span>
                <input
                  data-cell={`${rowIndex}:debit`}
                  className={`${styles.input} ${styles.amount}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  aria-label={`Debet, rad ${n}`}
                  disabled={disabled}
                  value={row.debit}
                  onFocus={() => rememberCell(row, "debit")}
                  onChange={(e) =>
                    patchRow(row.key, { debit: e.target.value, ...(amountOf(e.target.value) > 0 ? { credit: "" } : {}) })
                  }
                  onBlur={() => applySplit(row.key)}
                  onKeyDown={(e) => cellKeyDown(e, row.key, "debit")}
                />
              </div>
              <div className={`${styles.cell} ${styles.cellCredit}`}>
                <span className={styles.mobileLabel}>Kredit</span>
                <input
                  data-cell={`${rowIndex}:credit`}
                  className={`${styles.input} ${styles.amount}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  aria-label={`Kredit, rad ${n}`}
                  disabled={disabled}
                  value={row.credit}
                  onFocus={() => rememberCell(row, "credit")}
                  onChange={(e) =>
                    patchRow(row.key, { credit: e.target.value, ...(amountOf(e.target.value) > 0 ? { debit: "" } : {}) })
                  }
                  onBlur={() => applySplit(row.key)}
                  onKeyDown={(e) => cellKeyDown(e, row.key, "credit")}
                />
              </div>
              <div className={`${styles.cell} ${styles.cellRemove}`}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.removeButton}
                  aria-label={`Ta bort rad ${n}`}
                  title="Ta bort raden"
                  disabled={disabled}
                  onClick={() => removeRow(row.key)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}

        <div className={styles.footer}>
          {showBalance && (
            <>
              <span>∑ Debet: {formatMoney(totals.debit)}</span>
              <span>∑ Kredit: {formatMoney(totals.credit)}</span>
              <span className={totals.diff !== 0 ? styles.differs : styles.balanced}>
                Differens: {formatMoney(totals.diff)}
              </span>
            </>
          )}
          {dimensionsAvailable && (
            <label className={styles.dimensionsToggle}>
              <Checkbox
                checked={withDims}
                disabled={rowsHaveDimensions}
                onChange={(e) => {
                  setDimensionsChoice(e.target.checked);
                  writeDimensionsPreference(e.target.checked);
                }}
              />
              Visa kostnadsställe och projekt
            </label>
          )}
          <Button type="button" variant="secondary" size="small" className={styles.addButton} disabled={disabled} onClick={() => addRow()}>
            + Lägg till rad
          </Button>
        </div>
        {notice && <div className={styles.notice}>{notice}</div>}
        <div className={styles.hint}>
          Tab eller Enter går till nästa fält, Enter i sista fältet lägger till en rad
          {counterRows ? " med differensen förifylld" : ""}, Ctrl+Enter sparar och Esc ångrar fältet.
          {withVat
            ? " Välj en Momskod så tolkas beloppet som inklusive moms och raden delas när du lämnar fältet (för omvända koder är beloppet nettot och momsraderna läggs till)."
            : ""}
        </div>
      </div>
    </div>
  );
}

// Kostnadsställe/Projekt cell: a plain select over the active objects. A value
// that is no longer offered (inactive cost centre, closed project) stays
// selectable under the name the row carried, so opening an old row changes
// nothing.
function DimensionCell({
  cellId,
  label,
  disabled,
  value,
  currentLabel,
  options,
  onFocus,
  onChange,
  onKeyDown,
}: {
  cellId: string;
  label: string;
  disabled: boolean;
  value: string;
  currentLabel: string;
  options: { id: string; label: string }[];
  onFocus: () => void;
  onChange: (id: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLSelectElement>) => void;
}) {
  const offered = options.some((o) => o.id === value);
  return (
    <select
      data-cell={cellId}
      className={styles.input}
      aria-label={label}
      disabled={disabled}
      value={value}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    >
      <option value="">—</option>
      {value !== "" && !offered && <option value={value}>{currentLabel || "(inaktivt)"}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// The searchable Konto cell: digits match the account number from the start,
// text matches the name; only active accounts; Enter picks the highlighted
// account and moves on, Tab picks it too, Esc undoes the cell.
function AccountCell({
  cellId,
  row,
  accounts,
  disabled,
  label,
  onCommit,
  onEnter,
}: {
  cellId: string;
  row: EditorRow;
  accounts: EditorAccount[];
  disabled: boolean;
  label: string;
  onCommit: (number: string) => void;
  onEnter: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [typed, setTyped] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const initial = useRef("");
  const listRef = useRef<HTMLUListElement>(null);

  const known = accounts.find((a) => a.number === row.accountNumber);
  const shownName = known?.name ?? row.accountName;
  const closedLabel = row.accountNumber
    ? `${row.accountNumber}${shownName ? ` · ${shownName}` : ""}${known ? "" : " (inaktivt)"}`
    : "";
  const matches = open ? matchAccounts(accounts, typed ? text : "") : [];

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  // A cleared box clears the account; otherwise an exact number wins over
  // the highlighted match.
  function pick(): EditorAccount | undefined {
    if (text.trim() === "") return undefined;
    return matches.find((a) => a.number === text.trim()) ?? matches[highlight];
  }

  function choose(account: EditorAccount) {
    onCommit(account.number);
    setTyped(false);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (typed) {
        if (text.trim() === "") {
          onCommit("");
          setTyped(false);
        } else {
          const hit = pick();
          if (!hit) return; // nothing to pick — stay and let the user correct
          choose(hit);
        }
      }
      setOpen(false);
      onEnter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setTyped(false);
      setOpen(false);
      if (row.accountNumber !== initial.current) onCommit(initial.current);
    } else if (e.key === "Tab" && typed) {
      if (text.trim() === "") {
        onCommit("");
        setTyped(false);
      } else {
        const hit = pick();
        if (hit) choose(hit);
      }
    }
  }

  return (
    <>
      <input
        data-cell={cellId}
        className={`${styles.input} ${row.accountNumber && !known ? styles.inactive : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={label}
        placeholder="Sök konto…"
        autoComplete="off"
        disabled={disabled}
        value={typed ? text : closedLabel}
        onFocus={(e) => {
          initial.current = row.accountNumber;
          setTyped(false);
          setText("");
          setOpen(true);
          const index = matchAccounts(accounts, "").findIndex((a) => a.number === row.accountNumber);
          setHighlight(Math.max(index, 0));
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setTyped(true);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (typed) {
            const exact = accounts.find((a) => a.number === text.trim());
            if (exact) onCommit(exact.number);
            else if (text.trim() === "") onCommit("");
          }
          setTyped(false);
          setOpen(false);
        }}
      />
      {open && (
        <ul className={styles.list} role="listbox" ref={listRef}>
          {matches.map((a, index) => (
            <li key={a.number}>
              <button
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === highlight}
                className={styles.option}
                data-highlighted={index === highlight}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(a)}
              >
                <span className={styles.optionNumber}>{a.number}</span>
                <span className={styles.optionName}>{a.name}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className={styles.empty}>Inga aktiva konton matchar sökningen</li>}
        </ul>
      )}
    </>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../ui/Button";
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

type ColKey = "account" | "description" | "vatCode" | "debit" | "credit";

const COL_LABELS: Record<ColKey, string> = {
  account: "Konto",
  description: "Beskrivning",
  vatCode: "Momskod",
  debit: "Debet",
  credit: "Kredit",
};

function valueOf(row: EditorRow, col: ColKey): string {
  switch (col) {
    case "account":
      return row.accountNumber;
    case "description":
      return row.description;
    case "vatCode":
      return row.vatCode;
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
  const cols: ColKey[] = withVat
    ? ["account", "description", "vatCode", "debit", "credit"]
    : ["account", "description", "debit", "credit"];
  const splittable = (vatCodes ?? []).filter((c) => c.active && splitVatApplies(c));

  function focusCell(key: string, col: ColKey) {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-cell="${key}:${col}"]`);
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
    patchRow(key, { [col === "account" ? "accountNumber" : col]: snap.value } as Partial<EditorRow>);
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
      if (active) applySplit(active.split(":")[0]!);
      // After React has applied the split (the parent's handler is the latest).
      setTimeout(() => onSaveRef.current?.(), 0);
    }
  }

  const totals = rowTotals(rows);

  return (
    <div>
      <div
        ref={containerRef}
        className={`${styles.editor} ${withVat ? styles.withVat : ""}`}
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
                  cellId={`${row.key}:account`}
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
                  data-cell={`${row.key}:description`}
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
                    data-cell={`${row.key}:vatCode`}
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
              <div className={`${styles.cell} ${styles.cellDebit}`}>
                <span className={styles.mobileLabel}>Debet</span>
                <input
                  data-cell={`${row.key}:debit`}
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
                  data-cell={`${row.key}:credit`}
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

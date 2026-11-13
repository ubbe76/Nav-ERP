"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { Checkbox, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  SERIAL_NUMBERS_MAX,
  addSerialNumbers,
  parseSerialText,
  serialCells,
  type SerialAssignedAt,
} from "../../lib/serialInput";
import type { Article, ArticleTracking, BatchBalanceRow } from "../../lib/types";

// Serienummer (#8 etapp 2): the fields every serial-number routine shares.
//   SerialNumbersInput   — type or scan the numbers one by one (receipt, and
//                          the numbers given at the delivery).
//   DeliverySerialsField — Vid utleverans: the suggestion from the series,
//                          editable, "manuellt vinner".
//   SerialCellPicker     — pick (or scan) numbers that stand in stock (the
//                          outflows: Leverera, Förbruka, flytt, justering).
//   useSerialModes       — Serienummer skapas per article (the rows only
//                          carry the sort, not when the number is given).

const muted = { color: "var(--color-text-muted)", fontSize: 12 } as const;
const warnText = { color: "var(--status-stopped-text)", fontSize: 12 } as const;

// Serienummer skapas per article id, for the serienummerstyrda ones among the
// given articles (GET /articles/:id; a failed read leaves the article out).
export function useSerialModes(articles: { articleId: string; tracking?: ArticleTracking }[]): Record<string, SerialAssignedAt> {
  const [modes, setModes] = useState<Record<string, SerialAssignedAt>>({});
  const key = [...new Set(articles.filter((a) => a.tracking === "serial").map((a) => a.articleId))].sort().join(",");
  useEffect(() => {
    if (key === "") {
      setModes({});
      return;
    }
    let cancelled = false;
    Promise.all(
      key.split(",").map((id) =>
        apiFetch<Pick<Article, "serialAssignedAt">>(`/api/v1/articles/${id}`)
          .then((a): [string, SerialAssignedAt] => [id, a.serialAssignedAt ?? "receipt"])
          .catch(() => null)
      )
    ).then((pairs) => {
      if (cancelled) return;
      setModes(Object.fromEntries(pairs.filter((p): p is [string, SerialAssignedAt] => p !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return modes;
}

// The article's stock is per serial number (numbers created at the receipt).
export function isStockSerial(tracking: ArticleTracking | undefined, modes: Record<string, SerialAssignedAt>, articleId: string): boolean {
  return tracking === "serial" && modes[articleId] !== "delivery";
}

// The article gives its numbers at the delivery.
export function isDeliverySerial(tracking: ArticleTracking | undefined, modes: Record<string, SerialAssignedAt>, articleId: string): boolean {
  return tracking === "serial" && modes[articleId] === "delivery";
}

// Type or scan the numbers: Enter adds the typed one (a pasted list with
// several lines adds them all), × takes one away. `count` is how many the
// quantity asks for — only shown, the API checks it.
export function SerialNumbersInput({
  value,
  onChange,
  count,
  ariaLabel,
  placeholder = "Skriv eller skanna serienummer",
  inputRef,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  count?: number | null;
  ariaLabel: string;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  function add(incoming: string[]) {
    if (incoming.length === 0) return;
    const { list, duplicates } = addSerialNumbers(value, incoming);
    const capped = list.slice(0, SERIAL_NUMBERS_MAX);
    const messages: string[] = [];
    if (duplicates.length > 0) messages.push(`${duplicates.slice(0, 3).join(", ")}${duplicates.length > 3 ? " m.fl." : ""} fanns redan i listan`);
    if (list.length > SERIAL_NUMBERS_MAX) messages.push(`högst ${SERIAL_NUMBERS_MAX} serienummer åt gången`);
    setNotice(messages.length > 0 ? messages.join(" — ") : null);
    onChange(capped);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    // Enter adds the number — it never submits the form around the field.
    e.preventDefault();
    add(parseSerialText(text));
    setText("");
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    add(parseSerialText(pasted));
  }

  const mismatch = count != null && value.length !== count;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 4, minWidth: 0, maxWidth: "100%" }}>
      <Input
        type="text"
        size="md"
        ref={inputRef}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          // A typed number that was never confirmed with Enter is not lost.
          if (text.trim() !== "") {
            add(parseSerialText(text));
            setText("");
          }
        }}
      />
      <span style={mismatch ? warnText : muted}>
        {value.length} serienummer{count != null ? ` av ${count}` : ""}
        {value.length > 0 && !disabled && (
          <>
            {" · "}
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                onChange([]);
              }}
              style={{ background: "none", border: 0, padding: 0, color: "var(--accent-fg)", cursor: "pointer", font: "inherit" }}
            >
              Rensa
            </button>
          </>
        )}
      </span>
      {notice && <span style={warnText}>{notice}</span>}
      {value.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            maxHeight: 132,
            overflowY: "auto",
          }}
        >
          {value.map((s) => (
            <li
              key={s}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 6px",
                border: "1px solid var(--color-border-control)",
                borderRadius: 4,
                background: "var(--color-input-surface)",
                fontSize: 12,
              }}
            >
              {s}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Ta bort ${s}`}
                  onClick={() => onChange(value.filter((x) => x !== s))}
                  style={{ background: "none", border: 0, padding: 0, color: "var(--color-text-muted)", cursor: "pointer", font: "inherit" }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// Vid utleverans: the numbers the series would give for `count` styck, as an
// editable list. Manuellt vinner — once the user has changed the list a late
// suggestion never replaces it (a ref that mirrors the flag is read when the
// answer lands, plus a request sequence). The suggestion reserves nothing;
// the delivery draws the numbers and decides.
export function DeliverySerialsField({
  articleId,
  count,
  value,
  onChange,
  ariaLabel,
}: {
  articleId: string;
  // Styck to deliver; null/0 = nothing to suggest.
  count: number | null;
  value: string[];
  onChange: (next: string[]) => void;
  ariaLabel: string;
}) {
  const touched = useRef(false);
  const touchedNow = useRef(false);
  const seq = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The latest onChange without making the effect depend on it.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  function suggest(force: boolean) {
    const mine = ++seq.current;
    if (count === null || count > SERIAL_NUMBERS_MAX) {
      if (!touchedNow.current || force) onChangeRef.current([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    apiFetch<{ serialNumbers: string[] }>(
      `/api/v1/serial-suggestions?articleId=${encodeURIComponent(articleId)}&count=${count}`
    )
      .then((r) => {
        if (mine !== seq.current) return;
        if (touchedNow.current && !force) return;
        setError(null);
        onChangeRef.current(r.serialNumbers);
      })
      .catch((err) => {
        if (mine !== seq.current) return;
        setError(apiErrorMessage(err, "Kunde inte hämta serienummerförslag"));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }

  useEffect(() => {
    if (touched.current) return;
    suggest(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, count]);

  function change(next: string[]) {
    touched.current = true;
    touchedNow.current = true;
    onChange(next);
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 4, minWidth: 0, maxWidth: "100%" }}>
      <SerialNumbersInput value={value} onChange={change} count={count} ariaLabel={ariaLabel} placeholder="Serienummer ur serien" />
      <span style={muted}>
        {loading ? "Hämtar förslag…" : "Förslag ur artikelns serie — ändra vid behov. "}
        {touched.current && (
          <button
            type="button"
            onClick={() => {
              touched.current = false;
              touchedNow.current = false;
              suggest(true);
            }}
            style={{ background: "none", border: 0, padding: 0, color: "var(--accent-fg)", cursor: "pointer", font: "inherit" }}
          >
            Nytt förslag
          </button>
        )}
      </span>
      {error && <span style={warnText}>{error}</span>}
    </span>
  );
}

// Pick numbers that stand in stock (serial cells ur batch-balances). Nothing
// picked = Automatiskt, the oldest numbers. Typing filters the list, Enter
// (or a scan) picks the number that matches exactly — or the only one left.
export function SerialCellPicker({
  rows,
  articleId,
  locationId,
  value,
  onChange,
  ariaLabel,
}: {
  rows: BatchBalanceRow[];
  articleId: string;
  locationId?: string | null;
  // Chosen numbers as stock_batches ids (the API's serialIds).
  value: string[];
  onChange: (next: string[]) => void;
  ariaLabel: string;
}) {
  const cells = useMemo(() => serialCells(rows, articleId, locationId), [rows, articleId, locationId]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const chosen = useMemo(() => new Set(value), [value]);

  // A number that no longer stands at the picked place drops out.
  useEffect(() => {
    const live = value.filter((id) => cells.some((c) => c.batchId === id));
    if (live.length !== value.length) onChange(live);
  }, [cells, value, onChange]);

  const needle = text.trim().toLowerCase();
  const filtered = needle === "" ? cells : cells.filter((c) => (c.batchNumber ?? "").toLowerCase().includes(needle));
  const SHOWN = 200;

  function pick(id: string) {
    onChange(chosen.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (needle === "") return;
    const exact = cells.filter((c) => (c.batchNumber ?? "").toLowerCase() === needle);
    const hit = exact.length === 1 ? exact[0]! : filtered.length === 1 ? filtered[0]! : null;
    if (!hit) {
      setNotice(filtered.length === 0 ? `${text.trim()} finns inte i lager${locationId ? " på platsen" : ""}` : "Flera träffar — skriv hela numret");
      return;
    }
    if (hit.blocked) {
      setNotice(`${hit.batchNumber} står på en spärrad lagerplats`);
      return;
    }
    setNotice(null);
    if (!chosen.has(hit.batchId!)) onChange([...value, hit.batchId!]);
    setText("");
  }

  if (cells.length === 0) return <span style={muted}>Inga serienummer i lager</span>;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 4, minWidth: 0, maxWidth: "100%" }}>
      <Input
        type="text"
        size="md"
        aria-label={ariaLabel}
        placeholder="Skanna eller sök serienummer"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNotice(null);
        }}
        onKeyDown={onKeyDown}
      />
      <span style={muted}>
        {value.length === 0 ? "Automatiskt — äldsta numren" : `${value.length} valda`}
        {value.length > 0 && (
          <>
            {" · "}
            <button
              type="button"
              onClick={() => onChange([])}
              style={{ background: "none", border: 0, padding: 0, color: "var(--accent-fg)", cursor: "pointer", font: "inherit" }}
            >
              Rensa
            </button>
          </>
        )}
      </span>
      {notice && <span style={warnText}>{notice}</span>}
      <details>
        <summary style={{ ...muted, cursor: "pointer" }}>Välj bland {cells.length} i lager</summary>
        <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, maxHeight: 180, overflowY: "auto", display: "grid", gap: 2 }}>
          {filtered.slice(0, SHOWN).map((c) => (
            <li key={`${c.batchId}-${c.locationId}`}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap" }}>
                <Checkbox checked={chosen.has(c.batchId!)} disabled={c.blocked} onChange={() => pick(c.batchId!)} />
                <span>{c.batchNumber}</span>
                {c.locationName && (
                  <span style={muted}>
                    {c.warehouseName ? `${c.warehouseName} · ` : ""}
                    {c.locationName}
                    {c.blocked ? " — spärrad" : ""}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
        {filtered.length > SHOWN && <span style={muted}>Visar {SHOWN} av {filtered.length} — skriv för att filtrera.</span>}
      </details>
    </span>
  );
}

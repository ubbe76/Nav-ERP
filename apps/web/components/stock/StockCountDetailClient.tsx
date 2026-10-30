"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { StatusPill } from "../ui/StatusPill";
import { HelpLink } from "../ui/HelpLink";
import { ScanPanel } from "../ui/ScanInput";
import { useScanFeedback, useScanQueue } from "../ui/useOrderScan";
import { locationCountHref, ORDER_KIND_LABEL } from "./StockCountScanPanel";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { resolveCountScan } from "../../lib/countScan";
import buttonStyles from "../ui/Button.module.css";
import shellStyles from "../AppShell.module.css";
import { FormError } from "../ui/Form";
import {
  STOCK_COUNT_STATUS_LABELS,
  type Article,
  type StockCountDetail,
  type ScanMatch,
  type StockCountPostResult,
  type StockCountRow,
} from "../../lib/types";
import { formatQuantity } from "../../lib/format";

const PILL_STATUS = { open: "running", posted: "done", cancelled: "stopped" } as const;

const articleLabel = (a: { articleNumber: string; name: string }) => `${a.articleNumber} · ${a.name}`;

// Skanning (#4, etapp 4): the scan field takes a lagerplats label (this
// count's place, or another place whose count opens) or an article — its row
// is marked and Räknat takes the cursor with the value selected: artikel och
// antal, typed and saved with Enter, which hands the cursor back to the scan
// field. An article the sheet lacks is added first, as Lägg till artikel
// does. No +1 per scan here: a handheld scanner types into the focused field,
// so counting by scans and typing the count cannot be mixed.
export function StockCountDetailClient({ session }: { session: StockCountDetail }) {
  const router = useRouter();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [addArticle, setAddArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = session.status === "open";
  const { feedback, ok, warn } = useScanFeedback();
  const [markedRowId, setMarkedRowId] = useState<string | null>(null);
  const scanField = useRef<HTMLInputElement>(null);
  const countFields = useRef(new Map<string, HTMLInputElement>());
  // A row added by a scan arrives with the refresh; its field takes the
  // cursor then.
  const focusWhenLoaded = useRef<string | null>(null);
  // The props the queued scan handler reads — it may run after a refresh.
  const latest = useRef(session);
  useEffect(() => {
    latest.current = session;
  });

  function focusCount(rowId: string) {
    setMarkedRowId(rowId);
    const field = countFields.current.get(rowId);
    if (!field) {
      focusWhenLoaded.current = rowId;
      return;
    }
    field.focus();
    field.select();
  }

  useEffect(() => {
    const rowId = focusWhenLoaded.current;
    if (!rowId || !session.rows.some((r) => r.id === rowId)) return;
    focusWhenLoaded.current = null;
    focusCount(rowId);
    // focusCount reads refs only; rerun when the refreshed rows arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.rows]);

  function serverValue(row: StockCountRow): string {
    return row.countedQuantity === null ? "" : String(Number(row.countedQuantity));
  }
  function enteredCount(row: StockCountRow): string {
    return counted[row.id] ?? serverValue(row);
  }
  // Canonicalize before comparing against serverValue — a raw-string compare
  // leaves non-canonical input ("8.0", "08") permanently dirty, which keeps
  // Registrera disabled until a reload.
  function canonCount(value: string): string {
    return value.trim() === "" ? "" : String(Number(value));
  }
  const dirtyRows = useMemo(
    () => session.rows.filter((row) => counted[row.id] !== undefined && canonCount(counted[row.id]!) !== serverValue(row)),
    [counted, session.rows]
  );
  const dirtyRowsRef = useRef(0);
  dirtyRowsRef.current = dirtyRows.length;

  async function saveCounts() {
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      for (const row of dirtyRows) {
        const value = counted[row.id]!;
        await apiFetch(`/api/v1/stock-counts/${session.id}/rows/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ countedQuantity: value === "" ? null : Number(value) }),
        });
      }
      // Deliberately NOT clearing `counted` here: router.refresh() is fired
      // but not awaited, so the `session` prop is still stale for a moment.
      // Leaving the just-saved local values in place keeps dirtyRows/rows
      // dirty (counted[row.id] !== serverValue(row) against the stale prop)
      // until fresh props actually land, at which point serverValue matches
      // and the rows clean themselves up automatically. This doubles as the
      // freshness gate for post()'s confirm dialog (session.countedCount/
      // rowCount) — Registrera stays disabled until the numbers it quotes are
      // guaranteed current. Side effect: "Spara räknade antal (N)" stays
      // enabled/visible until the refresh lands; a re-click just re-PATCHes
      // the same values, which is idempotent.
      setMessage("Räknade antal sparade.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara räkningen");
    } finally {
      setPending(false);
    }
  }

  // Enter in Räknat: saves this one row (the scanned count) and hands the
  // cursor back to the scan field.
  async function saveRow(row: StockCountRow) {
    const value = counted[row.id];
    scanField.current?.focus();
    if (value === undefined || canonCount(value) === serverValue(row)) return;
    try {
      await apiFetch(`/api/v1/stock-counts/${session.id}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ countedQuantity: value === "" ? null : Number(value) }),
      });
      ok(`${row.articleNumber}: räknat ${value === "" ? "– (ej räknad)" : `${Number(value)} ${row.unit ?? ""}`.trim()} — sparat`);
      // counted stays until the fresh props land, as in saveCounts.
      router.refresh();
    } catch (err) {
      warn(apiErrorMessage(err, "Kunde inte spara raden"));
    }
  }

  const onScan = useScanQueue(async (code: string, matches: ScanMatch[]) => {
    const current = latest.current;
    const intent = resolveCountScan(matches, {
      locationId: current.locationId,
      open: current.status === "open",
      rows: current.rows,
    });
    switch (intent.kind) {
      case "thisLocation":
        ok(`${current.warehouseName} — ${current.locationName} är den här inventeringens plats`);
        return;
      case "otherLocation": {
        const m = intent.match;
        let href: string | null;
        try {
          href = await locationCountHref(m);
        } catch (err) {
          warn(apiErrorMessage(err, "Kunde inte hämta inventeringarna"));
          return;
        }
        if (!href) {
          warn(`${m.warehouseName} — ${m.name} är inaktiv och har inget saldo att inventera`);
          return;
        }
        if (
          dirtyRowsRef.current > 0 &&
          !(await confirmDialog(`Gå till ${m.warehouseName} — ${m.name}? Räknade antal som inte sparats försvinner.`, {
            confirmLabel: "Byt lagerplats",
          }))
        ) {
          return;
        }
        router.push(href);
        return;
      }
      case "row":
        ok(`${articleLabel(intent.match)} — skriv räknat antal och tryck Enter`);
        focusCount(intent.rowId);
        return;
      case "addArticle": {
        const article = intent.match;
        try {
          const row = await apiFetch<{ id: string }>(`/api/v1/stock-counts/${current.id}/rows`, {
            method: "POST",
            body: JSON.stringify({ articleId: article.id }),
          });
          warn(`${articleLabel(article)} fanns inte på underlaget och lades till — skriv räknat antal`);
          focusCount(row.id);
          router.refresh();
        } catch (err) {
          warn(apiErrorMessage(err, "Kunde inte lägga till artikeln"));
        }
        return;
      }
      case "articleNotCounting":
        warn(`Inventeringen är ${STOCK_COUNT_STATUS_LABELS[current.status].toLowerCase()} — räknade antal kan inte ändras`);
        return;
      case "order":
        warn(`${code} är ${ORDER_KIND_LABEL[intent.match.kind]} — skanna en lagerplats eller en artikel`);
        return;
      case "unknown":
        warn(`Ingen träff för ${code}`);
        return;
    }
  }, warn);

  async function post() {
    const skipped = session.rowCount - session.countedCount;
    if (
      !(await confirmDialog(
        `Registrera inventering ${session.countNumber}? ${session.countedCount} rader räknade, ${skipped} hoppas över. Differenserna bokförs som lagertransaktioner och kan inte ångras.`
      ))
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      const result = await apiFetch<StockCountPostResult>(`/api/v1/stock-counts/${session.id}/post`, {
        method: "POST",
      });
      setMessage(
        result.adjustments === 1
          ? "1 differens bokfördes."
          : `${result.adjustments} differenser bokfördes.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte registrera inventeringen");
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    if (!(await confirmDialog(`Avbryt inventering ${session.countNumber}? Inget bokförs och spärren släpper.`))) return;
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock-counts/${session.id}/cancel`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte avbryta inventeringen");
    } finally {
      setPending(false);
    }
  }

  async function addRow() {
    if (!addArticle) return;
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/stock-counts/${session.id}/rows`, {
        method: "POST",
        body: JSON.stringify({ articleId: addArticle.id }),
      });
      setAddArticle(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte lägga till artikeln");
    } finally {
      setPending(false);
    }
  }

  async function deleteRow(row: StockCountRow) {
    if (!(await confirmDelete(`Ta bort ${row.articleNumber} ur inventeringen?`))) return;
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/v1/stock-counts/${session.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort raden");
    }
  }

  function diffFor(row: StockCountRow): string {
    const entered = enteredCount(row);
    if (entered === "") return "—";
    // Round to the quantity scale (4 decimals) — the raw float difference
    // renders artifacts like "+0.1999999999999993" for 8.2 − 8.
    const diff = Math.round((Number(entered) - Number(row.snapshotQuantity)) * 1e4) / 1e4;
    if (Number.isNaN(diff)) return "—";
    if (diff === 0) return "0";
    return diff > 0 ? `+${diff}` : String(diff);
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inventering {session.countNumber}</div>
          <div className={shellStyles.meta}>
            {session.warehouseName} — {session.locationName} ({session.locationLabelCode})
            {session.blocksTransactions ? " · Lagertransaktioner spärrade" : ""}
            {session.note ? ` · ${session.note}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <StatusPill status={PILL_STATUS[session.status]} label={STOCK_COUNT_STATUS_LABELS[session.status]} />
          <a
            href={`${API_URL}/api/v1/stock-counts/${session.id}/pdf`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Skriv ut räknelista
          </a>
          <a
            href={`${API_URL}/api/v1/stock-counts/${session.id}/pdf?showBalances=true`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Räknelista med saldo
          </a>
          <Link href="/lager/inventering" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Alla inventeringar
          </Link>
          <HelpLink chapter="lager" anchor="inventering" label="Hjälp om inventering" />
        </div>
      </div>

      <ScanPanel
        inputRef={scanField}
        placeholder="Skanna lagerplats eller artikel…"
        onScan={onScan}
        feedback={feedback}
      />

      <FormError>{error}</FormError>
      {message && <p>{message}</p>}

      <Table<StockCountRow>
        columns={[
          { key: "articleNumber", label: "Artikel", width: "1fr" },
          { key: "unit", label: "Enhet", width: "70px" },
          { key: "snapshotQuantity", label: "Bokfört", width: "100px", align: "right" },
          { key: "countedQuantity", label: "Räknat", width: "120px", align: "right" },
          { key: "diff", label: "Diff", width: "90px", align: "right" },
          { key: "warning", label: "", width: "170px" },
          { key: "actions", label: "", width: "80px", align: "right" },
        ]}
        rows={session.rows}
        highlightedRowId={markedRowId}
        emptyText="Inga rader — lagerplatsen har inget bokfört saldo. Lägg till artiklar som hittas fysiskt."
        renderCell={(row, key) => {
          switch (key) {
            case "articleNumber":
              return `${row.articleNumber} — ${row.articleName}`;
            case "unit":
              return row.unit ?? "—";
            case "snapshotQuantity":
              return formatQuantity(row.snapshotQuantity);
            case "countedQuantity":
              return open ? (
                <Input
                  aria-label={`Räknat antal för ${row.articleNumber}`}
                  type="number"
                  min="0"
                  step="any"
                  size="sm"
                  value={enteredCount(row)}
                  onChange={(e) => setCounted((c) => ({ ...c, [row.id]: e.target.value }))}
                  ref={(field) => {
                    if (field) countFields.current.set(row.id, field);
                    else countFields.current.delete(row.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void saveRow(row);
                  }}
                />
              ) : row.countedQuantity === null ? (
                "ej räknad"
              ) : (
                Number(row.countedQuantity)
              );
            case "diff":
              return diffFor(row);
            case "warning":
              return row.disturbed ? (
                <span title="Lagertransaktioner har bokförts på artikeln efter frysningen — kontrollera att räkningen gjordes efter rörelsen.">
                  ⚠ Rörelser efter frysning
                </span>
              ) : null;
            case "actions":
              return open ? (
                <Button variant="ghost" size="small" onClick={() => deleteRow(row)} aria-label={`Ta bort ${row.articleNumber}`}>
                  Ta bort
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
      />

      {open && (
        <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 320 }}>
            <Field label="Lägg till artikel" htmlFor="countAddArticle">
              <ArticlePicker id="countAddArticle" value={addArticle} onChange={setAddArticle} />
            </Field>
          </div>
          <Button variant="secondary" onClick={addRow} disabled={pending || !addArticle}>
            Lägg till
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={saveCounts} disabled={pending || dirtyRows.length === 0}>
            {pending ? "Sparar…" : `Spara räknade antal${dirtyRows.length > 0 ? ` (${dirtyRows.length})` : ""}`}
          </Button>
          <Button
            variant="primary"
            onClick={post}
            disabled={pending || dirtyRows.length > 0}
            title={dirtyRows.length > 0 ? "Spara räknade antal först" : undefined}
          >
            Registrera
          </Button>
          <Button variant="danger" onClick={cancel} disabled={pending}>
            Avbryt inventering
          </Button>
        </div>
      )}
    </>
  );
}

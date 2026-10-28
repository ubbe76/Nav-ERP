"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { StatusPill } from "../ui/StatusPill";
import { HelpLink } from "../ui/HelpLink";
import { API_URL, apiFetch } from "../../lib/api";
import buttonStyles from "../ui/Button.module.css";
import shellStyles from "../AppShell.module.css";
import { FormError } from "../ui/Form";
import {
  STOCK_COUNT_STATUS_LABELS,
  type Article,
  type StockCountDetail,
  type StockCountPostResult,
  type StockCountRow,
} from "../../lib/types";
import { formatQuantity } from "../../lib/format";

const PILL_STATUS = { open: "running", posted: "done", cancelled: "stopped" } as const;

export function StockCountDetailClient({ session }: { session: StockCountDetail }) {
  const router = useRouter();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [addArticle, setAddArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = session.status === "open";

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
            {session.warehouseName} — {session.locationName}
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

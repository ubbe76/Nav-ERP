"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import type { StockBalance, StockLocation, StockTransferResult } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { FormError } from "../ui/Form";
import { formatQuantity } from "../../lib/format";

interface RowWithId extends StockBalance {
  id: string;
}

// Lagerflytt routine — move balances from one stock location to another.
// Quantities are prefilled with the whole balance (or only the preselected
// article's when linked from the balance list); rows left at 0 are skipped.
// The whole move is booked as one POST so it either lands completely or not
// at all — the API writes both legs of every row in one transaction.
export function StockTransferPageClient({
  locations,
  fromLocationId,
  preselectedArticleId,
  balances,
}: {
  locations: StockLocation[];
  fromLocationId: string | null;
  preselectedArticleId: string | null;
  balances: StockBalance[];
}) {
  const router = useRouter();

  const [toLocationId, setToLocationId] = useState("");
  const [note, setNote] = useState("");
  // articleId → entered quantity (string). Absent = the prefilled default.
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const rows: RowWithId[] = useMemo(
    () => balances.map((b) => ({ ...b, id: b.articleId })),
    [balances]
  );

  const fromLocation = locations.find((l) => l.id === fromLocationId) ?? null;
  const targetOptions = locations.filter((l) => l.id !== fromLocationId);

  // Linked from a single balance row: only that article is prefilled.
  function defaultQuantity(row: RowWithId): string {
    if (preselectedArticleId && row.articleId !== preselectedArticleId) return "0";
    return String(Number(row.quantityOnHand));
  }

  function enteredQuantity(row: RowWithId): string {
    return quantities[row.articleId] ?? defaultQuantity(row);
  }

  function selectFrom(id: string) {
    setQuantities({});
    setError(null);
    setDone(null);
    setToLocationId("");
    router.replace(id ? `/lager/flytta?from=${id}` : "/lager/flytta");
  }

  async function transfer() {
    setError(null);
    setDone(null);

    const payloadRows = rows
      .map((row) => ({ articleId: row.articleId, quantity: Number(enteredQuantity(row)) }))
      .filter((row) => row.quantity > 0);

    if (payloadRows.length === 0) {
      setError("Ange ett antal att flytta på minst en rad.");
      return;
    }
    if (!toLocationId) {
      setError("Välj en lagerplats att flytta till.");
      return;
    }

    setPending(true);
    try {
      const result = await apiFetch<StockTransferResult>("/api/v1/stock/transfers", {
        method: "POST",
        body: JSON.stringify({
          fromLocationId,
          toLocationId,
          note: note || undefined,
          rows: payloadRows,
        }),
      });
      const moved =
        result.movedRows === 1
          ? `1 artikel flyttad till ${result.toLocationName}`
          : `${result.movedRows} artiklar flyttade till ${result.toLocationName}`;
      setDone(
        result.deactivatedSourceLocation
          ? `${moved}. Lagerplatsen ${result.fromLocationName} är nu tom och har inaktiverats.`
          : moved
      );
      setQuantities({});
      setNote("");
      // A deactivated source is no longer a selectable option, so drop it from
      // the URL and fall back to the neutral state instead of a dangling ?from.
      if (result.deactivatedSourceLocation) router.replace("/lager/flytta");
      else router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte genomföra flytten");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lagerflytt</div>
          <div className={shellStyles.meta}>Flytta saldon mellan lagerplatser</div>
        </div>
        <HelpLink chapter="lager" anchor="lagerflytt" label="Hjälp om lagerflytt" />
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <Field label="Från lagerplats" htmlFor="transferFrom">
          <Select
            id="transferFrom"
            value={fromLocationId ?? ""}
            onChange={(e) => selectFrom(e.target.value)}
            style={{ minWidth: 260 }}
          >
            <option value="">Välj lagerplats…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.warehouseName} — {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Till lagerplats" htmlFor="transferTo">
          <Select
            id="transferTo"
            value={toLocationId}
            onChange={(e) => setToLocationId(e.target.value)}
            disabled={!fromLocationId}
            style={{ minWidth: 260 }}
          >
            <option value="">Välj lagerplats…</option>
            {targetOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.warehouseName} — {l.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {done && <p style={{ fontWeight: 600, marginTop: 0 }}>{done}</p>}
      <FormError>{error}</FormError>

      {!fromLocationId && !done && <p>Välj lagerplatsen du vill flytta saldon från.</p>}
      {fromLocationId && rows.length === 0 && !done && (
        <p>{fromLocation ? `${fromLocation.name} har inget saldo att flytta.` : "Lagerplatsen har inget saldo att flytta."}</p>
      )}

      {fromLocationId && rows.length > 0 && (
        <>
          <Table<RowWithId>
            columns={[
              { key: "articleNumber", label: "Artikelnummer", width: "160px" },
              { key: "articleName", label: "Benämning", width: "1fr" },
              { key: "quantityOnHand", label: "Saldo", width: "110px", align: "right" },
              { key: "id", label: "Flytta", width: "160px", align: "right" },
            ]}
            rows={rows}
            renderCell={(row, key) => {
              switch (key) {
                case "quantityOnHand":
                  return formatQuantity(row.quantityOnHand);
                case "id":
                  return (
                    <Input
                      type="number"
                      min="0"
                      max={Number(row.quantityOnHand)}
                      step="any"
                      size="sm"
                      aria-label={`Flytta — ${row.articleNumber}`}
                      value={enteredQuantity(row)}
                      onChange={(e) =>
                        setQuantities((q) => ({ ...q, [row.articleId]: e.target.value }))
                      }
                    />
                  );
                default:
                  return row[key as keyof RowWithId];
              }
            }}
          />

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Anteckning" htmlFor="transferNote">
              <Input
                id="transferNote"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="T.ex. orsak till flytten"
                style={{ minWidth: 320 }}
              />
            </Field>
            <Button type="button" variant="primary" disabled={pending} onClick={transfer}>
              {pending ? "Flyttar…" : "Flytta"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

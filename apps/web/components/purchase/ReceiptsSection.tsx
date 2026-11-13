"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { GatedLink } from "../ui/GatedLink";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { serialListText } from "../../lib/serialInput";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import { toUnitQuantity } from "../../lib/units";
import { useCan } from "../PermissionsProvider";
import type { PurchaseOrderRow, PurchaseOrderStatus, PurchaseReceipt } from "../../lib/types";
import { formatStockholmDateTime } from "../../lib/date";

// Inleveranser on the IO card: every receipt (Ta emot leverans / the
// Inleverans routine), newest first. Ångra inleverans reverses exactly that
// one receipt — the goods out of stock again (a lego row: the TO report it
// made), the row's received quantity and the order status; an undone row
// stays, greyed out. Quantities are shown in the row's unit.

function when(iso: string) {
  return formatStockholmDateTime(iso);
}

function rowQuantity(receipt: PurchaseReceipt, row: PurchaseOrderRow | undefined) {
  return toUnitQuantity(Number(receipt.quantity), row?.unitFactor ?? null).toLocaleString("sv-SE");
}

// What Ångra will do, spelled out for the confirmation.
function undoQuestion(receipt: PurchaseReceipt, row: PurchaseOrderRow | undefined): string {
  const what = `${rowQuantity(receipt, row)} ${row?.unitCode ?? ""} ${row?.articleNumber ?? ""}`.replace(/\s+/g, " ").trim();
  const effect = row?.moOperationId
    ? `Rapporteringen på ${row.moOrderNumber ?? "tillverkningsordern"} ångras också.`
    : `Varorna tas ut ur lager${receipt.locationName ? ` från ${receipt.locationName}` : ""}${
        receipt.batchNumber ? ` (${receipt.batchKind === "serial" ? "serienummer" : "batch"} ${receipt.batchNumber})` : ""
      } igen.`;
  return `Ångra inleveransen ${when(receipt.createdAt)} av ${what}? ${effect}`;
}

// A serial receipt is one styck, so one receive call leaves one receipt per
// number. They are shown as ONE entry per row and call (same row, time and
// user), each number with its own Ångra.
type ReceiptEntry = PurchaseReceipt & { group: PurchaseReceipt[] | null };

function groupReceipts(receipts: PurchaseReceipt[]): ReceiptEntry[] {
  const entries: ReceiptEntry[] = [];
  const byKey = new Map<string, ReceiptEntry>();
  for (const r of receipts) {
    if (r.batchKind !== "serial" || r.purchaseOrderRowId === null) {
      entries.push({ ...r, group: null });
      continue;
    }
    const key = `${r.purchaseOrderRowId}|${r.createdAt}|${r.createdByName ?? ""}|${r.locationName ?? ""}`;
    const head = byKey.get(key);
    if (head) head.group!.push(r);
    else {
      const entry: ReceiptEntry = { ...r, group: [r] };
      byKey.set(key, entry);
      entries.push(entry);
    }
  }
  for (const e of entries) {
    if (e.group) e.group.sort((a, b) => (a.batchNumber ?? "").localeCompare(b.batchNumber ?? "", "sv", { numeric: true }));
  }
  return entries;
}

export function ReceiptsSection({
  orderId,
  orderStatus,
  receipts,
  rows,
}: {
  orderId: string;
  orderStatus: PurchaseOrderStatus;
  receipts: PurchaseReceipt[];
  rows: PurchaseOrderRow[];
}) {
  const router = useRouter();
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (receipts.length === 0) return null;
  const entries = groupReceipts(receipts);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // A closed order is finished business; the API refuses it too.
  const canUndo = can(["inkop"]) && (orderStatus === "partially_received" || orderStatus === "received");

  async function undo(receipt: PurchaseReceipt) {
    const row = receipt.purchaseOrderRowId ? rowById.get(receipt.purchaseOrderRowId) : undefined;
    if (!(await confirmDialog(undoQuestion(receipt, row), { confirmLabel: "Ångra inleverans", danger: true }))) return;
    setError(null);
    setPendingId(receipt.id);
    try {
      await apiFetch(`/api/v1/purchase-orders/${orderId}/receipts/${receipt.id}/undo`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ångra inleveransen"));
    } finally {
      setPendingId(null);
    }
  }

  // Ångra alla: every live number of a group, one receipt at a time (each is
  // its own transaction); a refusal says how far it got.
  async function undoGroup(group: PurchaseReceipt[]) {
    const live = group.filter((r) => r.undoneAt === null);
    const row = group[0]!.purchaseOrderRowId ? rowById.get(group[0]!.purchaseOrderRowId) : undefined;
    const numbers = live.map((r) => r.batchNumber ?? "");
    if (
      !(await confirmDialog(
        `Ångra inleveransen ${when(group[0]!.createdAt)} av ${live.length} st ${row?.articleNumber ?? ""}? Serienummer ${serialListText(numbers)} tas ut ur lager igen.`,
        { confirmLabel: "Ångra inleverans", danger: true }
      ))
    )
      return;
    setError(null);
    setPendingId(group[0]!.id);
    let undone = 0;
    try {
      for (const r of live) {
        await apiFetch(`/api/v1/purchase-orders/${orderId}/receipts/${r.id}/undo`, { method: "POST" });
        undone += 1;
      }
    } catch (err) {
      setError(
        `${undone > 0 ? `${undone} av ${live.length} serienummer ångrades: ` : ""}${apiErrorMessage(err, "Kunde inte ångra inleveransen")}`
      );
    } finally {
      setPendingId(null);
      router.refresh();
    }
  }

  return (
    <>
      <SectionHeading spaced>Inleveranser</SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<ReceiptEntry>
        columns={[
          { key: "createdAt", label: "Tid", width: "130px" },
          { key: "purchaseOrderRowId", label: "Artikel", width: "minmax(0, 2fr)" },
          { key: "quantity", label: "Antal", width: "110px", align: "right" },
          { key: "locationName", label: "Lagerplats", width: "minmax(0, 1fr)" },
          { key: "createdByName", label: "Av", width: "minmax(0, 1fr)" },
          { key: "id", label: "", width: "170px", align: "right" },
        ]}
        rows={entries}
        renderCell={(receipt, key) => {
          const row = receipt.purchaseOrderRowId ? rowById.get(receipt.purchaseOrderRowId) : undefined;
          const group = receipt.group;
          const undone = group ? group.every((r) => r.undoneAt !== null) : receipt.undoneAt !== null;
          const muted = undone ? { color: "var(--color-text-muted)", textDecoration: "line-through" } : undefined;
          switch (key) {
            case "createdAt":
              return <span style={muted}>{when(receipt.createdAt)}</span>;
            case "purchaseOrderRowId":
              return (
                <span style={muted}>
                  {row ? `${row.articleNumber} — ${row.articleName}` : receipt.purchaseOrderRowId === null ? "Borttagen rad" : "–"}
                  {group && (
                    <details style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                      <summary style={{ cursor: "pointer" }}>
                        {group.length} serienummer
                        {group.some((r) => r.undoneAt !== null) && !undone ? ` (${group.filter((r) => r.undoneAt !== null).length} ångrade)` : ""}
                      </summary>
                      <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                        {group.map((r) => {
                          const gone = r.undoneAt !== null;
                          return (
                            <li key={r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={gone ? { textDecoration: "line-through" } : undefined}>
                                <GatedLink
                                  href={`/lager/sparbarhet?search=${encodeURIComponent(r.batchNumber ?? "")}`}
                                  style={{ color: gone ? "inherit" : "var(--accent-fg)" }}
                                >
                                  {r.batchNumber}
                                </GatedLink>
                              </span>
                              {gone ? (
                                <span>Ångrad {when(r.undoneAt!)}</span>
                              ) : (
                                canUndo && (
                                  <Button
                                    type="button"
                                    size="small"
                                    variant="secondary"
                                    disabled={pendingId !== null}
                                    onClick={() => undo(r)}
                                  >
                                    {pendingId === r.id ? "Ångrar…" : "Ångra"}
                                  </Button>
                                )
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                  {!group && receipt.batchNumber && (
                    <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                      Batch{" "}
                      <GatedLink href={`/lager/sparbarhet?search=${encodeURIComponent(receipt.batchNumber)}`} style={{ color: "var(--accent-fg)" }}>
                        {receipt.batchNumber}
                      </GatedLink>
                    </div>
                  )}
                  {row?.moOperationId && (
                    <div style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 2 }}>
                      Lego för {row.moOrderNumber ?? "TO"}
                    </div>
                  )}
                </span>
              );
            case "quantity":
              return (
                <span style={muted}>
                  {group ? toUnitQuantity(group.reduce((sum, r) => sum + Number(r.quantity), 0), row?.unitFactor ?? null).toLocaleString("sv-SE") : rowQuantity(receipt, row)}{" "}
                  {row?.unitCode ?? ""}
                </span>
              );
            case "locationName":
              return <span style={muted}>{receipt.locationName ?? "–"}</span>;
            case "createdByName":
              return <span style={muted}>{receipt.createdByName ?? "–"}</span>;
            case "id":
              if (undone) {
                return (
                  <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                    Ångrad {when(receipt.undoneAt!)}
                    {receipt.undoneByName ? ` av ${receipt.undoneByName}` : ""}
                  </span>
                );
              }
              if (!canUndo) return null;
              if (group) {
                return group.filter((r) => r.undoneAt === null).length > 1 ? (
                  <Button type="button" size="small" variant="secondary" disabled={pendingId !== null} onClick={() => undoGroup(group)}>
                    {pendingId === receipt.id ? "Ångrar…" : "Ångra alla"}
                  </Button>
                ) : null;
              }
              return (
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={pendingId !== null}
                  onClick={() => undo(receipt)}
                >
                  {pendingId === receipt.id ? "Ångrar…" : "Ångra"}
                </Button>
              );
            default:
              return null;
          }
        }}
      />
    </>
  );
}

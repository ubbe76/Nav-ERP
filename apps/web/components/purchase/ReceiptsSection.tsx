"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import { toUnitQuantity } from "../../lib/units";
import { useCan } from "../PermissionsProvider";
import type { PurchaseOrderRow, PurchaseOrderStatus, PurchaseReceipt } from "../../lib/types";

// Inleveranser on the IO card: every receipt (Ta emot leverans / the
// Inleverans routine), newest first. Ångra inleverans reverses exactly that
// one receipt — the goods out of stock again (a lego row: the TO report it
// made), the row's received quantity and the order status; an undone row
// stays, greyed out. Quantities are shown in the row's unit.

function when(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

function rowQuantity(receipt: PurchaseReceipt, row: PurchaseOrderRow | undefined) {
  return toUnitQuantity(Number(receipt.quantity), row?.unitFactor ?? null).toLocaleString("sv-SE");
}

// What Ångra will do, spelled out for the confirmation.
function undoQuestion(receipt: PurchaseReceipt, row: PurchaseOrderRow | undefined): string {
  const what = `${rowQuantity(receipt, row)} ${row?.unitCode ?? ""} ${row?.articleNumber ?? ""}`.replace(/\s+/g, " ").trim();
  const effect = row?.moOperationId
    ? `Rapporteringen på ${row.moOrderNumber ?? "tillverkningsordern"} ångras också.`
    : `Varorna tas ut ur lager${receipt.locationName ? ` från ${receipt.locationName}` : ""} igen.`;
  return `Ångra inleveransen ${when(receipt.createdAt)} av ${what}? ${effect}`;
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
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // A closed order is finished business; the API refuses it too.
  const canUndo = can(["inkop"]) && (orderStatus === "partially_received" || orderStatus === "received");

  async function undo(receipt: PurchaseReceipt) {
    const row = rowById.get(receipt.purchaseOrderRowId);
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

  return (
    <>
      <SectionHeading spaced>Inleveranser</SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<PurchaseReceipt>
        columns={[
          { key: "createdAt", label: "Tid", width: "130px" },
          { key: "purchaseOrderRowId", label: "Artikel", width: "minmax(0, 2fr)" },
          { key: "quantity", label: "Antal", width: "110px", align: "right" },
          { key: "locationName", label: "Lagerplats", width: "minmax(0, 1fr)" },
          { key: "createdByName", label: "Av", width: "minmax(0, 1fr)" },
          { key: "id", label: "", width: "170px", align: "right" },
        ]}
        rows={receipts}
        renderCell={(receipt, key) => {
          const row = rowById.get(receipt.purchaseOrderRowId);
          const undone = receipt.undoneAt !== null;
          const muted = undone ? { color: "var(--color-text-muted)", textDecoration: "line-through" } : undefined;
          switch (key) {
            case "createdAt":
              return <span style={muted}>{when(receipt.createdAt)}</span>;
            case "purchaseOrderRowId":
              return (
                <span style={muted}>
                  {row ? `${row.articleNumber} — ${row.articleName}` : "–"}
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
                  {rowQuantity(receipt, row)} {row?.unitCode ?? ""}
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

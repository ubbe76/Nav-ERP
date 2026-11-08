"use client";

import { TableSkeleton } from "../ui/Table";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { FormActions, FormError } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { confirmDialog } from "../../lib/confirm";
import { useCan } from "../PermissionsProvider";
import type { DeliveryRowsResponse, SalesOrderStatus } from "../../lib/types";

// Ångra utleverans: lists a följesedel's rows; Ångra on a row puts exactly
// that row's goods back in stock and lowers the order row's delivered
// quantity. Undone rows stay in the list, greyed out.

function when(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

const fmtQty = (n: number) => n.toLocaleString("sv-SE");

// Where an undone row's goods go back: one part per location it was taken
// from, in the article's base unit.
function putBackText(row: DeliveryRowsResponse["rows"][number]): string | null {
  if (row.locations.length === 0) return null;
  const parts = row.locations.map(
    (l) => `${l.warehouseName} — ${l.locationName} (${fmtQty(l.quantity)} ${row.baseUnit})`
  );
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} och ${parts[parts.length - 1]}` : parts[0];
  return `Varorna läggs tillbaka på ${joined}.`;
}

const mutedText = { color: "var(--color-text-muted)" } as const;

// Also opened by Utleverans' notice (Ångra…, Nav som program punkt 7).
export function UndoDeliveryDialog({
  orderId,
  deliveryId,
  open,
  onClose,
}: {
  orderId: string;
  deliveryId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<DeliveryRowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<DeliveryRowsResponse>(`/api/v1/deliveries/${deliveryId}/rows`));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta följesedelns rader"));
    }
  }, [deliveryId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setData(null);
    void load();
  }, [open, load]);

  async function undo(row: DeliveryRowsResponse["rows"][number]) {
    const what = `${row.quantity.toLocaleString("sv-SE")} ${row.unit} ${row.articleNumber}`.replace(/\s+/g, " ").trim();
    const question = `Ångra leveransen av ${what} på följesedel ${data?.deliveryNumber ?? ""}? ${putBackText(row) ?? "Varorna läggs tillbaka i lager."} Orderns levererade antal minskas.`;
    if (!(await confirmDialog(question, { confirmLabel: "Ångra", danger: true }))) return;
    setError(null);
    setPendingId(row.id);
    try {
      await apiFetch(`/api/v1/sales-orders/${orderId}/deliveries/${deliveryId}/rows/${row.id}/undo`, { method: "POST" });
      await load();
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ångra utleveransen"));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Ångra utleverans${data ? ` — ${data.deliveryNumber}` : ""}`}>
      <FormError margin="below">{error}</FormError>
      {data === null && !error && <TableSkeleton label="Hämtar rader…" columns={4} rows={3} />}
      {data && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {data.rows.map((row) => {
            const undone = row.undoneAt !== null;
            return (
              <li
                key={row.id}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
              >
                <div style={undone ? { ...mutedText, textDecoration: "line-through" } : undefined}>
                  {row.articleNumber} — {row.articleName}
                  <div style={{ fontSize: 12, ...mutedText }}>
                    {row.quantity.toLocaleString("sv-SE")} {row.unit}
                  </div>
                  {!undone && row.undoable && putBackText(row) && (
                    <div style={{ fontSize: 12, ...mutedText }}>{putBackText(row)}</div>
                  )}
                </div>
                {undone ? (
                  <span style={{ ...mutedText, fontSize: 12, textAlign: "right" }}>
                    Ångrad {when(row.undoneAt!)}
                    {row.undoneByName ? ` av ${row.undoneByName}` : ""}
                  </span>
                ) : row.undoable ? (
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    disabled={pendingId !== null}
                    onClick={() => undo(row)}
                  >
                    {pendingId === row.id ? "Ångrar…" : "Ångra"}
                  </Button>
                ) : (
                  <span style={{ ...mutedText, fontSize: 12 }}>Kan inte ångras</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <FormActions>
        <Button type="button" variant="secondary" onClick={onClose}>
          Stäng
        </Button>
      </FormActions>
    </Modal>
  );
}

// Ångra… link for a följesedel in the order card's list. Hidden for users
// without Försäljning, and unless the order is Under tillverkning/Levererad
// (the API refuses anything else).
export function UndoDeliveryButton({
  orderId,
  deliveryId,
  orderStatus,
}: {
  orderId: string;
  deliveryId: string;
  orderStatus: SalesOrderStatus;
}) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can(["forsaljning"]) || (orderStatus !== "in_production" && orderStatus !== "delivered")) return null;
  return (
    <>
      <Button type="button" variant="ghost" size="small" onClick={() => setOpen(true)}>
        Ångra…
      </Button>
      <UndoDeliveryDialog orderId={orderId} deliveryId={deliveryId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

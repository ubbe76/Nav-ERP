"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity as fmt } from "../../lib/format";
import { confirmDialog } from "../../lib/confirm";
import type { PurchaseDispatch } from "../../lib/types";

// Avsändningar: the log of goods sent to a lego supplier (the Avsändning lego
// routine and the IO card), newest first, undone ones greyed out. Pallkort
// reprints the cards; Ångra… reverses exactly that dispatch — which only
// moves the derived Skickat figure, nothing in stock.

function when(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", {
    dateStyle: "short",
    timeZone: "Europe/Stockholm",
    timeStyle: "short",
  });
}

export function DispatchesSection({
  orderId,
  dispatches,
  hideWhenEmpty,
  onPalletCard,
  onChanged,
}: {
  orderId: string;
  dispatches: PurchaseDispatch[];
  // The IO card shows the section only once something has been sent.
  hideWhenEmpty?: boolean;
  // The host owns the Pallkort dialog (the routine opens it right after
  // Rapportera avsändning); without it the section opens its own.
  onPalletCard?: (dispatchId: string) => void;
  // Called after a successful Ångra… (the routine clears its "skickade" note).
  onChanged?: () => void;
}) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(["inkop"]);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ownCard, setOwnCard] = useState<string | null>(null);

  if (hideWhenEmpty && dispatches.length === 0) return null;

  async function undo(d: PurchaseDispatch) {
    const what = d.rows
      .map((r) => `${fmt(r.quantity)} ${r.unit} ${r.articleNumber}`)
      .join(", ");
    if (
      !(await confirmDialog(
        `Ångra avsändningen ${when(d.dispatchedAt)} av ${what}? Skickat minskar med lika mycket. Lagret påverkas inte.`,
        {
          confirmLabel: "Ångra avsändning",
          danger: true,
        },
      ))
    )
      return;
    setError(null);
    setPendingId(d.id);
    try {
      await apiFetch(
        `/api/v1/purchase-orders/${orderId}/dispatches/${d.id}/undo`,
        { method: "POST" },
      );
      onChanged?.();
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ångra avsändningen"));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <SectionHeading spaced>Avsändningar</SectionHeading>
      <FormError margin="below">{error}</FormError>
      <Table<PurchaseDispatch>
        columns={[
          { key: "dispatchedAt", label: "Tid", width: "130px" },
          {
            key: "dispatchedByName",
            label: "Skickat av",
            width: "minmax(0, 1fr)",
          },
          { key: "rows", label: "Rader", width: "minmax(0, 3fr)" },
          { key: "note", label: "Anteckning", width: "minmax(0, 2fr)" },
          { key: "id", label: "", width: "190px", align: "right" },
        ]}
        rows={dispatches}
        emptyText="Inget har skickats än."
        renderCell={(d, key) => {
          const undone = d.undoneAt !== null;
          const muted = undone
            ? {
                color: "var(--color-text-muted)",
                textDecoration: "line-through",
              }
            : undefined;
          switch (key) {
            case "dispatchedAt":
              return <span style={muted}>{when(d.dispatchedAt)}</span>;
            case "dispatchedByName":
              return <span style={muted}>{d.dispatchedByName ?? "–"}</span>;
            case "rows":
              return (
                <span style={muted}>
                  {d.rows.map((r) => (
                    <div key={r.id}>
                      {r.articleNumber} — {r.articleName}: {fmt(r.quantity)}{" "}
                      {r.unit}, {r.parcels} kolli
                    </div>
                  ))}
                </span>
              );
            case "note":
              return <span style={muted}>{d.note ?? "–"}</span>;
            case "id":
              if (undone) {
                return (
                  <span
                    style={{ color: "var(--color-text-muted)", fontSize: 12 }}
                  >
                    Ångrad {when(d.undoneAt!)}
                    {d.undoneByName ? ` av ${d.undoneByName}` : ""}
                  </span>
                );
              }
              return (
                <span
                  style={{
                    display: "inline-flex",
                    gap: 4,
                    justifyContent: "flex-end",
                  }}
                >
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    onClick={() =>
                      onPalletCard ? onPalletCard(d.id) : setOwnCard(d.id)
                    }
                  >
                    Pallkort
                  </Button>
                  {canWrite && (
                    <Button
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={pendingId !== null}
                      onClick={() => undo(d)}
                    >
                      {pendingId === d.id ? "Ångrar…" : "Ångra…"}
                    </Button>
                  )}
                </span>
              );
            default:
              return null;
          }
        }}
      />
      {!onPalletCard && (
        <PalletCardDialog
          target={
            ownCard ? { kind: "dispatch", orderId, dispatchId: ownCard } : null
          }
          onClose={() => setOwnCard(null)}
        />
      )}
    </>
  );
}

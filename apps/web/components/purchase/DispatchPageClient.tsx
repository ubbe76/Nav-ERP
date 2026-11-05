"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { FormError } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import { DispatchesSection } from "./DispatchesSection";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import {
  PURCHASE_ORDER_STATUS_PILL,
  type PurchaseDispatch,
  type PurchaseOrder,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
} from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "./GoodsReceiptPageClient.module.css";

const OPEN: PurchaseOrderStatus[] = [
  "draft",
  "confirmed",
  "partially_received",
];

// Rounded so 0.1 + 0.2 style float noise never shows in a prefilled field.
const round4 = (n: number) => Math.round(n * 10000) / 10000;

const legoReference = (r: PurchaseOrderRow) =>
  r.moOrderNumber
    ? `${r.moOrderNumber} · Op ${r.moOperationSequenceNo ?? "?"}${r.moOperationDescription ? ` · ${r.moOperationDescription}` : ""}`
    : "–";

// "Ytbehandling: … · Färg: …" — only the filled ones, like the IO PDF.
const finish = (r: PurchaseOrderRow) =>
  [
    r.articleSurfaceTreatment && `Ytbehandling: ${r.articleSurfaceTreatment}`,
    r.articleColour && `Färg: ${r.articleColour}`,
  ]
    .filter(Boolean)
    .join(" · ");

// Avsändning lego routine — report goods sent to a lego supplier. "Att
// skicka" is prefilled with ordered − already sent (never below 0); rows set
// to 0 are skipped, more than ordered is allowed with a warning. A manually
// typed figure wins over the prefill (edits are kept per row and dropped
// after a report). Nothing is booked in stock — the dispatch only feeds
// Skickat and the pallet card; the material is drawn at the receipt.
export function DispatchPageClient({
  selected,
  rows,
  dispatches,
  openOrders,
}: {
  selected: PurchaseOrder | null;
  rows: PurchaseOrderRow[];
  dispatches: PurchaseDispatch[];
  openOrders: PurchaseOrder[];
}) {
  const router = useRouter();
  const order = selected;
  const legoRows = rows.filter((r) => r.moOperationId !== null);
  const [edits, setEdits] = useState<
    Record<string, { quantity?: string; parcels?: string }>
  >({});
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [card, setCard] = useState<{
    orderId: string;
    dispatchId: string;
  } | null>(null);

  const remaining = (r: PurchaseOrderRow) =>
    Math.max(
      round4(
        toUnitQuantity(
          Number(r.quantityOrdered) - Number(r.quantityDispatched),
          r.unitFactor,
        ),
      ),
      0,
    );
  const quantityOf = (r: PurchaseOrderRow) =>
    edits[r.id]?.quantity ?? String(remaining(r));
  const parcelsOf = (r: PurchaseOrderRow) => edits[r.id]?.parcels ?? "1";
  const setEdit = (
    id: string,
    patch: { quantity?: string; parcels?: string },
  ) => setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const canDispatch = order !== null && OPEN.includes(order.status);
  const toSend = legoRows.filter((r) => Number(quantityOf(r)) > 0);
  const overRows = toSend.filter(
    (r) =>
      Number(quantityOf(r)) +
        toUnitQuantity(Number(r.quantityDispatched), r.unitFactor) >
      toUnitQuantity(Number(r.quantityOrdered), r.unitFactor),
  );

  function goToOrder(id: string) {
    setEdits({});
    setNote("");
    setError(null);
    setDone(null);
    router.replace(`/inkop/avsandning?order=${id}`);
  }

  function selectOrder(next: PurchaseOrder | null) {
    // The picker also fires onChange(null) while typing — only a pick navigates.
    if (next) goToOrder(next.id);
  }

  async function report() {
    if (!order) return;
    setError(null);
    setDone(null);
    setPending(true);
    try {
      const res = await apiFetch<{ id: string }>(
        `/api/v1/purchase-orders/${order.id}/dispatches`,
        {
          method: "POST",
          body: JSON.stringify({
            rows: toSend.map((r) => ({
              rowId: r.id,
              quantity: toBaseQuantity(Number(quantityOf(r)), r.unitFactor),
              parcels: Math.max(1, Math.floor(Number(parcelsOf(r)) || 1)),
            })),
            note: note.trim() || null,
          }),
        },
      );
      setDone(
        `${toSend.length} rad${toSend.length === 1 ? "" : "er"} skickade`,
      );
      setEdits({});
      setNote("");
      setCard({ orderId: order.id, dispatchId: res.id });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte rapportera avsändningen"));
    } finally {
      setPending(false);
    }
  }

  const pill = order ? PURCHASE_ORDER_STATUS_PILL[order.status] : null;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Avsändning lego</div>
          <div className={shellStyles.meta}>
            Rapportera gods som skickats till legoleverantör
          </div>
        </div>
        <HelpLink
          chapter="inkop"
          anchor="avsandning-lego"
          label="Hjälp om avsändning lego"
        />
      </div>

      <div className={styles.controls}>
        <Field label="Inköpsorder" htmlFor="dispatchOrder">
          <SearchPicker
            id="dispatchOrder"
            endpoint="/api/v1/purchase-orders?kind=lego&status=draft,confirmed,partially_received"
            value={order}
            onChange={selectOrder}
            formatLabel={(o) => `${o.orderNumber} — ${o.supplierName}`}
            placeholder="Sök ordernummer, leverantör, artikelnummer eller benämning…"
            emptyText="Inga inköpsordrar med legorader matchar sökningen"
          />
        </Field>
        {order && pill && (
          <div className={styles.orderStatus}>
            <StatusPill status={pill.status} label={pill.label} />
            <Link
              href={`/inkop/ordrar/${order.id}`}
              style={{ fontWeight: 600, color: "inherit" }}
            >
              Öppna {order.orderNumber}
            </Link>
          </div>
        )}
      </div>

      {done && <p style={{ fontWeight: 600, marginTop: 0 }}>{done}</p>}

      {!order && (
        <div className={styles.openOrders}>
          <SectionHeading>Inköpsordrar med legorader</SectionHeading>
          <Table<PurchaseOrder>
            columns={[
              { key: "orderNumber", label: "Ordernummer", width: "140px" },
              { key: "supplierName", label: "Leverantör", width: "1fr" },
              { key: "createdAt", label: "Orderdatum", width: "130px" },
              { key: "status", label: "Status", width: "160px" },
            ]}
            rows={openOrders}
            emptyText="Inga öppna inköpsordrar har legorader."
            renderCell={(o, key) => {
              switch (key) {
                case "orderNumber":
                  return (
                    <button
                      type="button"
                      className={styles.rowLink}
                      onClick={() => selectOrder(o)}
                    >
                      {o.orderNumber}
                    </button>
                  );
                case "supplierName":
                  return o.supplierName;
                case "createdAt":
                  return new Date(o.createdAt).toLocaleDateString("sv-SE");
                case "status": {
                  const p = PURCHASE_ORDER_STATUS_PILL[o.status];
                  return (
                    <StatusPill status={p.status} label={p.label} compact />
                  );
                }
                default:
                  return null;
              }
            }}
          />
        </div>
      )}

      {order && legoRows.length === 0 && <p>Ordern har inga legorader.</p>}
      {order && !canDispatch && legoRows.length > 0 && (
        <p>
          Ordern är {pill?.label.toLowerCase()} — inget nytt kan skickas, men
          loggen nedan visar tidigare avsändningar.
        </p>
      )}

      {order && canDispatch && legoRows.length > 0 && (
        <>
          <Table<PurchaseOrderRow>
            columns={[
              {
                key: "articleName",
                label: "Artikel",
                width: "minmax(140px, 2fr)",
              },
              {
                key: "moOperationId",
                label: "Lego för",
                width: "minmax(140px, 2fr)",
              },
              {
                key: "quantityOrdered",
                label: "Beställt",
                width: "90px",
                align: "right",
              },
              {
                key: "quantityDispatched",
                label: "Skickat",
                width: "90px",
                align: "right",
              },
              {
                key: "quantity",
                label: "Att skicka",
                width: "130px",
                align: "right",
              },
              { key: "parcels", label: "Kolli", width: "80px", align: "right" },
            ]}
            rows={legoRows}
            renderCell={(row, key) => {
              switch (key) {
                case "articleName":
                  return (
                    <>
                      {row.articleNumber} — {row.articleName}
                    </>
                  );
                case "moOperationId":
                  return (
                    <>
                      {legoReference(row)}
                      {finish(row) && (
                        <div
                          style={{
                            color: "var(--color-text-muted)",
                            fontSize: 12,
                            marginTop: 2,
                          }}
                        >
                          {finish(row)}
                        </div>
                      )}
                    </>
                  );
                case "quantityOrdered":
                  return `${formatQuantity(toUnitQuantity(Number(row.quantityOrdered), row.unitFactor))} ${row.unitCode}`;
                case "quantityDispatched":
                  return `${formatQuantity(toUnitQuantity(Number(row.quantityDispatched), row.unitFactor))} ${row.unitCode}`;
                case "quantity":
                  return (
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      size="sm"
                      aria-label={`Att skicka — ${row.articleNumber}`}
                      value={quantityOf(row)}
                      onChange={(e) =>
                        setEdit(row.id, { quantity: e.target.value })
                      }
                    />
                  );
                case "parcels":
                  return (
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      size="xs"
                      aria-label={`Kolli — ${row.articleNumber}`}
                      value={parcelsOf(row)}
                      onChange={(e) =>
                        setEdit(row.id, { parcels: e.target.value })
                      }
                    />
                  );
                default:
                  return null;
              }
            }}
          />

          {overRows.length > 0 && (
            <p
              role="status"
              style={{ color: "var(--status-delayed-text)", fontWeight: 600 }}
            >
              Mer än beställt: {overRows.map((r) => r.articleNumber).join(", ")}
              . Du kan ändå rapportera avsändningen.
            </p>
          )}

          <div style={{ marginTop: 16, maxWidth: 560 }}>
            <Field label="Anteckning" htmlFor="dispatchNote">
              <Input
                id="dispatchNote"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>

          <FormError margin="below">{error}</FormError>
          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <Button
              type="button"
              variant="primary"
              disabled={pending || toSend.length === 0}
              onClick={report}
            >
              {pending ? "Rapporterar…" : "Rapportera avsändning"}
            </Button>
          </div>
        </>
      )}

      {order && legoRows.length > 0 && (
        <DispatchesSection
          orderId={order.id}
          dispatches={dispatches}
          onChanged={() => setDone(null)}
          onPalletCard={(dispatchId) =>
            setCard({ orderId: order.id, dispatchId })
          }
        />
      )}

      <PalletCardDialog
        target={card ? { kind: "dispatch", ...card } : null}
        onClose={() => setCard(null)}
      />
    </>
  );
}

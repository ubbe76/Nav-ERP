"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { configuredDeliveryWarning } from "../../lib/configuredDelivery";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import { SALES_ORDER_STATUS_PILL, type SalesOrder, type SalesOrderRow, type StockLocation } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError, FormNotice } from "../ui/Form";
import { BookTransportButton } from "../shipping/BookTransportButton";
import { PalletCardDialog } from "../documents/PalletCardDialog";
import styles from "./DeliveryPageClient.module.css";

// Utleverans routine — report a whole delivery in one go. Quantities are
// prefilled with each row's remaining amount; rows set to 0 are skipped. All
// filled-in rows are booked in ONE POST /sales-orders/:id/deliver call —
// C2's batch endpoint — so the whole occasion becomes a single delivery
// (följesedel), atomic across every row. Delivery requires status
// "Under tillverkning".
export function DeliveryPageClient({
  locations,
  selected,
  rows,
  openOrders,
}: {
  locations: StockLocation[];
  selected: SalesOrder | null;
  rows: SalesOrderRow[];
  // Every deliverable order (status in_production) — browsable list shown
  // below the picker while no order is selected, so the routine works
  // without knowing the order number (mirrors inleverans' "Mottagbara
  // ordrar").
  openOrders: SalesOrder[];
}) {
  const router = useRouter();
  const order = selected;
  const selectedId = order?.id ?? null;
  const openRows = useMemo(
    () => rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered)),
    [rows]
  );

  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [palletCardDeliveryId, setPalletCardDeliveryId] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; deliveryId: string; deliveryNumber: string } | null>(null);

  // Frakt: "Boka transport" on the result block only when freight is
  // enabled under System → Frakt — fetched once; an error hides the button.
  const [freightEnabled, setFreightEnabled] = useState(false);
  useEffect(() => {
    apiFetch<{ enabled: boolean }>("/api/v1/freight-settings/status")
      .then((r) => setFreightEnabled(r.enabled))
      .catch(() => setFreightEnabled(false));
  }, []);

  // Entered/displayed in the row's unit; converted to the base unit when the
  // delivery is booked (stock is always base).
  function enteredQuantity(row: SalesOrderRow): string {
    return (
      quantities[row.id] ??
      String(toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityDelivered), row.unitFactor))
    );
  }

  // The SearchPicker also fires onChange(null) while the user is typing (it
  // invalidates the previous pick) — only a definite pick should navigate.
  function selectOrder(next: SalesOrder | null) {
    if (!next) return;
    setQuantities({});
    setRowErrors({});
    setFormError(null);
    setDone(null);
    router.replace(`/forsaljning/utleverans?order=${next.id}`);
  }

  async function report() {
    setRowErrors({});
    setFormError(null);
    setDone(null);

    const toDeliver = openRows
      .map((row) => ({ row, quantity: Number(enteredQuantity(row)) }))
      .filter(({ quantity }) => quantity > 0);
    if (toDeliver.length === 0) return;

    setPending(true);
    try {
      const result = await apiFetch<{ deliveryId: string; deliveryNumber: string; orderStatus: string }>(
        `/api/v1/sales-orders/${selectedId}/deliver`,
        {
          method: "POST",
          body: JSON.stringify({
            locationId: locationId || undefined,
            rows: toDeliver.map(({ row, quantity }) => ({
              rowId: row.id,
              quantity: toBaseQuantity(quantity, row.unitFactor),
            })),
          }),
        }
      );
      setDone({
        message: `${toDeliver.length} rad${toDeliver.length === 1 ? "" : "er"} utlevererade`,
        deliveryId: result.deliveryId,
        deliveryNumber: result.deliveryNumber,
      });
      setQuantities({});
      // Pallkort: auto-open the cards for the delivery (one page per row) —
      // best effort (a popup blocker may stop it); the Pallkort (PDF) link
      // in the result block is the always-there fallback.
      window.open(`/api/v1/deliveries/${result.deliveryId}/pallet-card`, "_blank", "noopener");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kunde inte leverera";
      // The batch error has no structured per-row attribution — but
      // SalesOrderRowNotFoundError's message embeds the row id, so a match
      // still gets shown inline (the raw message — that's what carries the
      // id); anything else (e.g. over-delivery, which names no row) falls
      // back to a form-level message from the shared error-code dictionary.
      const attributed = toDeliver.find(({ row }) => message.includes(row.id));
      if (attributed) {
        setRowErrors({ [attributed.row.id]: message });
      } else {
        setFormError(apiErrorMessage(err, "Kunde inte leverera"));
      }
    }
    setPending(false);
    router.refresh();
  }

  const pill = order ? SALES_ORDER_STATUS_PILL[order.status] : null;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Utleverans</div>
          <div className={shellStyles.meta}>Rapportera leverans mot kundorder</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="utleverans" label="Hjälp om utleverans" />
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <Field label="Kundorder" htmlFor="deliveryOrder">
          <SearchPicker
            id="deliveryOrder"
            endpoint="/api/v1/sales-orders?status=in_production&withOpenRows=true"
            value={order}
            onChange={selectOrder}
            formatLabel={(o) => `${o.orderNumber} — ${o.customerName}`}
            placeholder="Sök ordernummer, kund, artikelnummer eller benämning…"
            emptyText="Inga kundordrar under tillverkning matchar sökningen"
            renderOption={(o) => (
              <span className={styles.optionRows}>
                <span className={styles.optionTitle}>
                  {o.orderNumber} — {o.customerName}
                </span>
                <span className={styles.optionMeta}>
                  {new Date(o.createdAt).toLocaleDateString("sv-SE")} · {SALES_ORDER_STATUS_PILL[o.status].label}
                  {o.openRowCount != null ? ` · ${o.openRowCount} restrad${o.openRowCount === 1 ? "" : "er"}` : ""}
                </span>
              </span>
            )}
          />
        </Field>
        {locations.length > 0 && (
          <Field label="Lagerplats" htmlFor="deliveryLocation">
            <Select id="deliveryLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Artikelns lagerplats</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.warehouseName} — {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {order && pill && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", paddingBottom: 6 }}>
            <StatusPill status={pill.status} label={pill.label} />
            <Link href={`/forsaljning/ordrar/${order.id}`} style={{ fontWeight: 600, color: "inherit" }}>
              Öppna {order.orderNumber}
            </Link>
            <a
              href={`/api/v1/sales-orders/${order.id}/pick-list`}
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              download
            >
              Plocklista (PDF)
            </a>
          </div>
        )}
      </div>

      {done && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <p style={{ fontWeight: 600, margin: 0 }}>{done.message}</p>
          <a
            href={`/api/v1/deliveries/${done.deliveryId}/pdf`}
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Följesedel {done.deliveryNumber} (PDF)
          </a>
          <button
            type="button"
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            onClick={() => setPalletCardDeliveryId(done.deliveryId)}
          >
            Pallkort (PDF)
          </button>
          <PalletCardDialog
            target={palletCardDeliveryId ? { kind: "delivery", deliveryId: palletCardDeliveryId } : null}
            onClose={() => setPalletCardDeliveryId(null)}
          />
          <BookTransportButton deliveryId={done.deliveryId} shipment={null} enabled={freightEnabled} />
        </div>
      )}

      <FormError margin="below">{formError}</FormError>

      {!order && (
        <div className={styles.openOrders}>
          <SectionHeading>Levererbara ordrar</SectionHeading>
          <Table<SalesOrder>
            columns={[
              { key: "orderNumber", label: "Ordernummer", width: "140px" },
              { key: "customerName", label: "Kund", width: "1fr" },
              { key: "createdAt", label: "Orderdatum", width: "130px" },
              { key: "status", label: "Status", width: "160px" },
              { key: "openRowCount", label: "Restrader", width: "110px", align: "right" },
            ]}
            rows={openOrders}
            emptyText="Inga ordrar väntar på utleverans."
            renderCell={(o, key) => {
              switch (key) {
                case "orderNumber":
                  return (
                    <button type="button" className={styles.rowLink} onClick={() => selectOrder(o)}>
                      {o.orderNumber}
                    </button>
                  );
                case "customerName":
                  return o.customerName;
                case "createdAt":
                  return new Date(o.createdAt).toLocaleDateString("sv-SE");
                case "status": {
                  const p = SALES_ORDER_STATUS_PILL[o.status];
                  return <StatusPill status={p.status} label={p.label} compact />;
                }
                case "openRowCount":
                  return o.openRowCount ?? "–";
                default:
                  return null;
              }
            }}
          />
        </div>
      )}

      {order && openRows.length === 0 && <p>Alla rader på ordern är redan levererade.</p>}

      {order && openRows.length > 0 && (
        <>
          <Table<SalesOrderRow>
            columns={[
              { key: "articleNumber", label: "Artikelnummer", width: "150px" },
              { key: "articleName", label: "Benämning", width: "1fr" },
              { key: "quantityOrdered", label: "Beställt", width: "100px", align: "right" },
              { key: "unitCode", label: "Enhet", width: "70px" },
              { key: "quantityDelivered", label: "Levererat", width: "100px", align: "right" },
              { key: "remaining", label: "Rest", width: "100px", align: "right" },
              { key: "id", label: "Leverera nu", width: "220px", align: "right" },
            ]}
            rows={openRows}
            renderCell={(row, key) => {
              switch (key) {
                case "quantityOrdered":
                case "quantityDelivered":
                  return toUnitQuantity(Number(row[key]), row.unitFactor);
                case "remaining":
                  return (
                    <strong>
                      {toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityDelivered), row.unitFactor)}
                    </strong>
                  );
                case "id":
                  return (
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        size="sm"
                        aria-label={`Leverera nu — ${row.articleNumber}`}
                        value={enteredQuantity(row)}
                        onChange={(e) => setQuantities((q) => ({ ...q, [row.id]: e.target.value }))}
                      />
                      {(() => {
                        const warning = configuredDeliveryWarning(
                          row,
                          toBaseQuantity(Number(enteredQuantity(row)), row.unitFactor)
                        );
                        return warning ? <FormNotice>{warning}</FormNotice> : null;
                      })()}
                      {rowErrors[row.id] && (
                        <FormError inline>{rowErrors[row.id]}</FormError>
                      )}
                    </span>
                  );
                default:
                  // E3 added non-primitive row fields (manufacturingOrders) to
                  // SalesOrderRow; the default fallback is only ever reached
                  // for plain string columns (articleNumber/articleName/
                  // unitCode) here, so String() keeps those unchanged while
                  // widening the switch's return type to something
                  // ReactNode-compatible.
                  return String(row[key as keyof SalesOrderRow] ?? "");
              }
            }}
          />

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Button type="button" variant="primary" disabled={pending} onClick={report}>
              {pending ? "Rapporterar…" : "Rapportera utleverans"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

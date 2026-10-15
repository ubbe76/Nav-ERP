"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { toBaseQuantity, toUnitQuantity } from "../../lib/units";
import { PURCHASE_ORDER_STATUS_PILL, type PurchaseOrder, type PurchaseOrderRow, type StockLocation } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { FormError } from "../ui/Form";
import styles from "./GoodsReceiptPageClient.module.css";

// Inleverans routine — report a whole goods receipt in one go. Quantities are
// prefilled with each row's remaining amount; rows set to 0 are skipped. Each
// row is booked via the existing per-row endpoint (atomic per row, order
// status recomputed per call).
export function GoodsReceiptPageClient({
  locations,
  selected,
  rows,
  openOrders,
}: {
  locations: StockLocation[];
  selected: PurchaseOrder | null;
  rows: PurchaseOrderRow[];
  // Every receivable order (status confirmed/partially_received) — browsable
  // list shown below the picker while no order is selected, so the routine
  // works without knowing the order number (like Monitor's ankomstlista).
  openOrders: PurchaseOrder[];
}) {
  const router = useRouter();
  const order = selected;
  const selectedId = order?.id ?? null;
  const openRows = useMemo(
    () => rows.filter((r) => Number(r.quantityReceived) < Number(r.quantityOrdered)),
    [rows]
  );

  const [locationId, setLocationId] = useState(""); // "" = artikelns lagerplats
  // rowId → entered quantity (string, prefilled with the remaining amount).
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Entered/displayed in the row's unit; converted to the base unit when the
  // receipt is booked (stock is always base).
  function enteredQuantity(row: PurchaseOrderRow): string {
    return (
      quantities[row.id] ??
      String(toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityReceived), row.unitFactor))
    );
  }

  // The SearchPicker also fires onChange(null) while the user is typing (it
  // invalidates the previous pick) — only a definite pick should navigate.
  function selectOrder(next: PurchaseOrder | null) {
    if (!next) return;
    setQuantities({});
    setRowErrors({});
    setDone(null);
    router.replace(`/inkop/inleverans?order=${next.id}`);
  }

  async function report() {
    setRowErrors({});
    setDone(null);
    setPending(true);
    const errors: Record<string, string> = {};
    let booked = 0;
    let reportedOperations = 0;
    for (const row of openRows) {
      const quantity = Number(enteredQuantity(row));
      if (!quantity) continue;
      try {
        const result = await runWithShortageConfirm((allowMaterialShortage) =>
          apiFetch<{ operationReport?: { ok: boolean; message?: string } }>(
            `/api/v1/purchase-orders/${selectedId}/rows/${row.id}/receive`,
            {
              method: "POST",
              body: JSON.stringify({
                locationId: locationId || undefined,
                quantity: toBaseQuantity(quantity, row.unitFactor),
                allowMaterialShortage,
              }),
            }
          )
        );
        // Declined "Rapportera ändå?": this row is left unreceived — say so on
        // the row, or it would look like it was simply forgotten.
        if (result === null) {
          errors[row.id] = "Inte inlevererad — avbröts på grund av materialbrist.";
          continue;
        }
        booked += 1;
        // Lego row: the receipt auto-reports the linked TO operation. The
        // receipt itself stands even when the report fails (e.g. the TO is
        // already done) — surface that as a row warning, not a failure.
        if (result.operationReport) {
          if (result.operationReport.ok) reportedOperations += 1;
          else {
            errors[row.id] =
              `Inlevererad, men operationen kunde inte avrapporteras: ${result.operationReport.message ?? "okänt fel"}`;
          }
        }
      } catch (err) {
        errors[row.id] = apiErrorMessage(err, "Kunde inte ta emot raden");
      }
    }
    setRowErrors(errors);
    if (booked > 0 && Object.keys(errors).length === 0) {
      setDone(
        `${booked} rad${booked === 1 ? "" : "er"} inlevererade` +
          (reportedOperations > 0
            ? ` — ${reportedOperations} legooperation${reportedOperations === 1 ? "" : "er"} avrapporterade`
            : "")
      );
      setQuantities({});
    }
    setPending(false);
    router.refresh();
  }

  const pill = order ? PURCHASE_ORDER_STATUS_PILL[order.status] : null;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inleverans</div>
          <div className={shellStyles.meta}>Rapportera mottagning mot inköpsorder</div>
        </div>
        <HelpLink chapter="inkop" anchor="inleverans" label="Hjälp om inleverans" />
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <Field label="Inköpsorder" htmlFor="receiptOrder">
          <SearchPicker
            id="receiptOrder"
            endpoint="/api/v1/purchase-orders?status=confirmed,partially_received&withOpenRows=true"
            value={order}
            onChange={selectOrder}
            formatLabel={(o) => `${o.orderNumber} — ${o.supplierName}`}
            placeholder="Sök ordernummer, leverantör, artikelnummer eller benämning…"
            emptyText="Inga inköpsordrar matchar sökningen"
            renderOption={(o) => (
              <span className={styles.optionRows}>
                <span className={styles.optionTitle}>
                  {o.orderNumber} — {o.supplierName}
                </span>
                <span className={styles.optionMeta}>
                  {new Date(o.createdAt).toLocaleDateString("sv-SE")} · {PURCHASE_ORDER_STATUS_PILL[o.status].label}
                  {o.openRowCount != null ? ` · ${o.openRowCount} restrad${o.openRowCount === 1 ? "" : "er"}` : ""}
                </span>
              </span>
            )}
          />
        </Field>
        {locations.length > 0 && (
          <Field label="Lagerplats" htmlFor="receiptLocation">
            <Select id="receiptLocation" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
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
            <Link href={`/inkop/ordrar/${order.id}`} style={{ fontWeight: 600, color: "inherit" }}>
              Öppna {order.orderNumber}
            </Link>
          </div>
        )}
      </div>

      {done && <p style={{ fontWeight: 600, marginTop: 0 }}>{done}</p>}

      {!order && (
        <div className={styles.openOrders}>
          <SectionHeading>Mottagbara ordrar</SectionHeading>
          <Table<PurchaseOrder>
            columns={[
              { key: "orderNumber", label: "Ordernummer", width: "140px" },
              { key: "supplierName", label: "Leverantör", width: "1fr" },
              { key: "createdAt", label: "Orderdatum", width: "130px" },
              { key: "status", label: "Status", width: "160px" },
              { key: "openRowCount", label: "Restrader", width: "110px", align: "right" },
            ]}
            rows={openOrders}
            emptyText="Inga ordrar väntar på inleverans."
            renderCell={(o, key) => {
              switch (key) {
                case "orderNumber":
                  return (
                    <button type="button" className={styles.rowLink} onClick={() => selectOrder(o)}>
                      {o.orderNumber}
                    </button>
                  );
                case "supplierName":
                  return o.supplierName;
                case "createdAt":
                  return new Date(o.createdAt).toLocaleDateString("sv-SE");
                case "status": {
                  const p = PURCHASE_ORDER_STATUS_PILL[o.status];
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

      {order && openRows.length === 0 && <p>Alla rader på ordern är redan mottagna.</p>}

      {order && openRows.length > 0 && (
        <>
          <Table<PurchaseOrderRow>
            columns={[
              { key: "articleNumber", label: "Artikelnummer", width: "150px" },
              { key: "articleName", label: "Benämning", width: "1fr" },
              { key: "quantityOrdered", label: "Beställt", width: "100px", align: "right" },
              { key: "unitCode", label: "Enhet", width: "70px" },
              { key: "quantityReceived", label: "Mottaget", width: "100px", align: "right" },
              { key: "remaining", label: "Rest", width: "100px", align: "right" },
              { key: "id", label: "Ta emot nu", width: "220px", align: "right" },
            ]}
            rows={openRows}
            renderCell={(row, key) => {
              switch (key) {
                case "quantityOrdered":
                case "quantityReceived":
                  return toUnitQuantity(Number(row[key]), row.unitFactor);
                case "remaining":
                  return (
                    <strong>
                      {toUnitQuantity(Number(row.quantityOrdered) - Number(row.quantityReceived), row.unitFactor)}
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
                        aria-label={`Ta emot nu — ${row.articleNumber}`}
                        value={enteredQuantity(row)}
                        onChange={(e) => setQuantities((q) => ({ ...q, [row.id]: e.target.value }))}
                      />
                      {rowErrors[row.id] && (
                        <FormError inline>{rowErrors[row.id]}</FormError>
                      )}
                    </span>
                  );
                default:
                  return row[key as keyof PurchaseOrderRow];
              }
            }}
          />

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Button type="button" variant="primary" disabled={pending} onClick={report}>
              {pending ? "Rapporterar…" : "Rapportera inleverans"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewPurchaseOrderForm } from "./NewPurchaseOrderForm";
import { FINISHED_HIDDEN_HINT, ListExportLink, ListFilterSelect, ListToolbar, Pagination, ListMultiFilter, useFinishedHidden } from "../ui/ListControls";
import { PURCHASE_ORDER_FILTER } from "../../lib/statusFilters";
import { useListColumns } from "../ui/ListColumns";
import { PURCHASE_ORDER_STATUS_PILL, type Paged, type PurchaseOrder, type SupplierConfirmation } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/inkop/ordrar/page.module.css";
import { HelpLink } from "../ui/HelpLink";

// Bekräftad av leverantör: Ja when every row still to come has a Bekräftat
// leveransdatum (its own or the order's), Delvis when some do, Nej when none
// (an Utkast too) — the CSV export's labels (export-columns.ts); – once the
// order is received, closed or cancelled. Nej and Delvis stand out: the
// supplier still owes a confirmation.
const SUPPLIER_CONFIRMATION: Record<SupplierConfirmation, string> = {
  confirmed: "Ja",
  partial: "Delvis",
  none: "Nej",
};

export function PurchaseOrdersPageClient({ orders, pageSize }: { orders: Paged<PurchaseOrder>; pageSize: number }) {
  // ?ny=1 (the "+ Ny inköpsorder" link on the Inköp page) opens the form at once.
  const [modalOpen, setModalOpen] = useState(useSearchParams().get("ny") === "1");

  const finishedHidden = useFinishedHidden(PURCHASE_ORDER_FILTER);
  const view = useListColumns([
    // As tight as the contents allow, so the table fits beside the module
    // panel at 1280 px; Leverantör takes the rest. The long heading of
    // Bekräftad av leverantör wraps over its Ja/Delvis/Nej.
    { key: "orderNumber", label: "Ordernummer", width: "100px" },
    { key: "supplierName", label: "Leverantör", width: "minmax(140px, 1fr)" },
    { key: "status", label: "Status", width: "130px" },
    { key: "currency", label: "Valuta", width: "60px" },
    { key: "expectedDeliveryDate", label: "Leveransdatum", width: "110px" },
    { key: "supplierConfirmation", label: "Bekräftad av leverantör", width: "130px" },
  ]);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inköpsordrar</div>
          <div className={shellStyles.meta}>{orders.total.toLocaleString("sv-SE")} ordrar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/leverantorer" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Leverantörer
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny inköpsorder
          </Button>
          <HelpLink chapter="inkop" anchor="inkopsorder" label="Hjälp om inköpsorder" />
        </div>
      </div>

      <ListToolbar placeholder="Sök ordernummer eller leverantör…">
        <ListMultiFilter filter={PURCHASE_ORDER_FILTER} allLabel="Alla statusar" ariaLabel="Filtrera på status" />
        <ListFilterSelect
          param="kind"
          allLabel="Alla ordertyper"
          ariaLabel="Filtrera på ordertyp"
          options={[
            { value: "lego", label: "Legoinköp" },
            { value: "regular", label: "Övriga inköp" },
          ]}
        />
        <ListExportLink endpoint="/api/v1/purchase-orders/csv" filter={PURCHASE_ORDER_FILTER} />
        {view.chooser}
      </ListToolbar>

      <Table<PurchaseOrder>
        columns={view.columns}
        onColumnResize={view.onColumnResize}
        {...view.reorder}
        rows={orders.rows}
        emptyText={`Inga ordrar matchar sökningen${finishedHidden ? `. ${FINISHED_HIDDEN_HINT}` : ""}`}
        renderCell={(order, key) => {
          switch (key) {
            case "orderNumber":
              return (
                <Link href={`/inkop/ordrar/${order.id}`} className={styles.rowLink}>
                  {order.orderNumber}
                </Link>
              );
            case "supplierName":
              return order.supplierName;
            case "status": {
              const pill = PURCHASE_ORDER_STATUS_PILL[order.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "currency":
              return order.currency;
            case "expectedDeliveryDate":
              return order.nextDeliveryDate ?? order.expectedDeliveryDate ?? "–";
            case "supplierConfirmation": {
              const state = order.supplierConfirmation;
              if (!state) return "–";
              return (
                <span className={state === "confirmed" ? undefined : styles.unconfirmed}>{SUPPLIER_CONFIRMATION[state]}</span>
              );
            }
            default:
              return null;
          }
        }}
      />

      <Pagination total={orders.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny inköpsorder">
        <NewPurchaseOrderForm />
      </Modal>
    </>
  );
}

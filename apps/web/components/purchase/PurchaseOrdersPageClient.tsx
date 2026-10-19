"use client";

import { useState } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewPurchaseOrderForm } from "./NewPurchaseOrderForm";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { PURCHASE_ORDER_STATUS_PILL, type Paged, type PurchaseOrder } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/inkop/ordrar/page.module.css";
import { HelpLink } from "../ui/HelpLink";

export function PurchaseOrdersPageClient({ orders, pageSize }: { orders: Paged<PurchaseOrder>; pageSize: number }) {
  const [modalOpen, setModalOpen] = useState(false);

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
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(PURCHASE_ORDER_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListFilterSelect
          param="kind"
          allLabel="Alla ordertyper"
          ariaLabel="Filtrera på ordertyp"
          options={[
            { value: "lego", label: "Legoinköp" },
            { value: "regular", label: "Övriga inköp" },
          ]}
        />
        <ListExportLink endpoint="/api/v1/purchase-orders/csv" />
      </ListToolbar>

      <Table<PurchaseOrder>
        columns={[
          { key: "orderNumber", label: "Ordernummer", width: "140px" },
          { key: "supplierName", label: "Leverantör", width: "1fr" },
          { key: "status", label: "Status", width: "160px" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "expectedDeliveryDate", label: "Leveransdatum", width: "170px" },
        ]}
        rows={orders.rows}
        emptyText="Inga ordrar matchar sökningen"
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

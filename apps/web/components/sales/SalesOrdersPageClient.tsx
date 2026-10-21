"use client";

import { useState } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewQuoteForm } from "./NewQuoteForm";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { SALES_ORDER_STATUS_PILL, type Paged, type SalesOrder } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/forsaljning/ordrar/page.module.css";
import { QuoteExpiredBadge, isQuoteExpired } from "./QuoteExpiredBadge";
import { HelpLink } from "../ui/HelpLink";

export function SalesOrdersPageClient({
  orders,
  pageSize,
}: {
  orders: Paged<SalesOrder>;
  pageSize: number;
}) {
  const [modalMode, setModalMode] = useState<"quote" | "order" | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Säljordrar</div>
          <div className={shellStyles.meta}>{orders.total.toLocaleString("sv-SE")} ordrar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/kunder" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Kunder
          </Link>
          <Button type="button" variant="secondary" onClick={() => setModalMode("quote")}>
            + Ny offert
          </Button>
          <Button type="button" variant="primary" onClick={() => setModalMode("order")}>
            + Ny kundorder
          </Button>
          <HelpLink chapter="forsaljning" anchor="offert-och-kundorder" label="Hjälp om offert och kundorder" />
        </div>
      </div>

      <ListToolbar placeholder="Sök ordernummer eller kund…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(SALES_ORDER_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/sales-orders/csv" />
      </ListToolbar>

      <Table<SalesOrder>
        columns={[
          { key: "orderNumber", label: "Ordernummer", width: "140px" },
          { key: "customerName", label: "Kund", width: "1fr" },
          { key: "status", label: "Status", width: "160px" },
          { key: "expectedDeliveryDate", label: "Leveransdatum", width: "150px" },
          { key: "quoteValidUntil", label: "Giltig t.o.m.", width: "170px" },
        ]}
        rows={orders.rows}
        emptyText="Inga ordrar matchar sökningen"
        renderCell={(order, key) => {
          switch (key) {
            case "orderNumber":
              return (
                <Link href={`/forsaljning/ordrar/${order.id}`} className={styles.rowLink}>
                  {order.orderNumber}
                </Link>
              );
            case "customerName":
              return order.customerName;
            case "status": {
              const pill = SALES_ORDER_STATUS_PILL[order.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "expectedDeliveryDate":
              return order.nextDeliveryDate ?? order.expectedDeliveryDate ?? "–";
            case "quoteValidUntil":
              return order.status === "quote" ? (
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="num">{order.quoteValidUntil ?? "–"}</span>
                  {isQuoteExpired(order.status, order.quoteValidUntil) && <QuoteExpiredBadge />}
                </span>
              ) : (
                ""
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={orders.total} pageSize={pageSize} />

      <Modal
        open={modalMode !== null}
        onClose={() => setModalMode(null)}
        title={modalMode === "order" ? "Ny kundorder" : "Ny offert"}
      >
        {modalMode !== null && <NewQuoteForm mode={modalMode} />}
      </Modal>
    </>
  );
}

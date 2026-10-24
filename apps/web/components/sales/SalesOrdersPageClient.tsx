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
import { SALES_ORDER_STATUS_PILL, type Paged, type SalesOrder, type SalesOrderStatus } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/forsaljning/ordrar/page.module.css";
import { QuoteExpiredBadge, isQuoteExpired } from "./QuoteExpiredBadge";
import { HelpLink } from "../ui/HelpLink";

// One list component for both routines: kind "quote" = /forsaljning/offerter,
// "order" = /forsaljning/ordrar (the page passes kind to the API as ?kind=).
const QUOTE_STATUSES: SalesOrderStatus[] = ["quote", "lost", "cancelled"];
const ORDER_STATUSES: SalesOrderStatus[] = ["confirmed", "in_production", "delivered", "invoiced", "cancelled"];

export function SalesOrdersPageClient({
  orders,
  pageSize,
  kind,
}: {
  orders: Paged<SalesOrder>;
  pageSize: number;
  kind: "quote" | "order";
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const isQuote = kind === "quote";
  const detailBase = isQuote ? "/forsaljning/offerter" : "/forsaljning/ordrar";
  const statuses = isQuote ? QUOTE_STATUSES : ORDER_STATUSES;

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{isQuote ? "Offerter" : "Kundorder"}</div>
          <div className={shellStyles.meta}>
            {orders.total.toLocaleString("sv-SE")} {isQuote ? "offerter" : "ordrar"}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/kunder" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Kunder
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            {isQuote ? "+ Ny offert" : "+ Ny kundorder"}
          </Button>
          <HelpLink
            chapter="forsaljning"
            anchor={isQuote ? "offerter" : "kundorder"}
            label={isQuote ? "Hjälp om offerter" : "Hjälp om kundorder"}
          />
        </div>
      </div>

      <ListToolbar placeholder={isQuote ? "Sök offertnummer eller kund…" : "Sök ordernummer eller kund…"}>
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={statuses.map((value) => ({ value, label: SALES_ORDER_STATUS_PILL[value].label }))}
        />
        <ListExportLink endpoint={`/api/v1/sales-orders/csv?kind=${kind}`} />
      </ListToolbar>

      <Table<SalesOrder>
        columns={[
          { key: "orderNumber", label: isQuote ? "Offert" : "Ordernummer", width: "140px" },
          { key: "customerName", label: "Kund", width: "1fr" },
          { key: "status", label: "Status", width: "160px" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "expectedDeliveryDate", label: "Leveransdatum", width: "150px" },
          ...(isQuote ? [{ key: "quoteValidUntil", label: "Giltig t.o.m.", width: "170px" }] : []),
        ]}
        rows={orders.rows}
        emptyText={isQuote ? "Inga offerter matchar sökningen" : "Inga ordrar matchar sökningen"}
        renderCell={(order, key) => {
          switch (key) {
            case "orderNumber":
              return (
                <Link href={`${detailBase}/${order.id}`} className={styles.rowLink}>
                  {isQuote ? (order.quoteNumber ?? order.orderNumber) : order.orderNumber}
                </Link>
              );
            case "customerName":
              return order.customerName;
            case "status": {
              const pill = SALES_ORDER_STATUS_PILL[order.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "currency":
              return order.currency;
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
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={isQuote ? "Ny offert" : "Ny kundorder"}
      >
        {modalOpen && <NewQuoteForm mode={kind} />}
      </Modal>
    </>
  );
}

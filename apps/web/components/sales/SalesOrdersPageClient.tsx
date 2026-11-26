"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewQuoteForm } from "./NewQuoteForm";
import { FINISHED_HIDDEN_HINT, ListExportLink, ListToolbar, Pagination, ListMultiFilter, useFinishedHidden } from "../ui/ListControls";
import { QUOTE_FILTER, SALES_ORDER_FILTER } from "../../lib/statusFilters";
import { listOutlookMark } from "../../lib/deliveryRisk";
import { useListColumns } from "../ui/ListColumns";
import { SALES_ORDER_STATUS_PILL, type Paged, type SalesOrder } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/forsaljning/ordrar/page.module.css";
import { QuoteExpiredBadge, isQuoteExpired } from "./QuoteExpiredBadge";
import { HelpLink } from "../ui/HelpLink";

// One list component for both routines: kind "quote" = /forsaljning/offerter,
// "order" = /forsaljning/ordrar (the page passes kind to the API as ?kind=).

export function SalesOrdersPageClient({
  orders,
  pageSize,
  kind,
}: {
  orders: Paged<SalesOrder>;
  pageSize: number;
  kind: "quote" | "order";
}) {
  // ?ny=1 (the "+ Ny kundorder" link on the Försäljning page) opens the form at once.
  const [modalOpen, setModalOpen] = useState(useSearchParams().get("ny") === "1");
  const isQuote = kind === "quote";
  const detailBase = isQuote ? "/forsaljning/offerter" : "/forsaljning/ordrar";
  const statusFilter = isQuote ? QUOTE_FILTER : SALES_ORDER_FILTER;
  const finishedHidden = useFinishedHidden(statusFilter);
  const view = useListColumns([
    { key: "orderNumber", label: isQuote ? "Offert" : "Ordernummer", width: "140px" },
    { key: "customerName", label: "Kund", width: "1fr" },
    // Wider on the order list: the status and the leveransläge mark side by side.
    { key: "status", label: "Status", width: isQuote ? "160px" : "280px" },
    { key: "currency", label: "Valuta", width: "90px" },
    { key: "expectedDeliveryDate", label: "Leveransdatum", width: "150px" },
    ...(isQuote ? [{ key: "quoteValidUntil", label: "Giltig t.o.m.", width: "170px" }] : []),
  ]);

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
        <ListMultiFilter filter={statusFilter} allLabel="Alla statusar" ariaLabel="Filtrera på status" />
        <ListExportLink endpoint={`/api/v1/sales-orders/csv?kind=${kind}`} filter={statusFilter} />
        {view.chooser}
      </ListToolbar>

      <Table<SalesOrder>
        columns={view.columns}
        onColumnResize={view.onColumnResize}
        {...view.reorder}
        rows={orders.rows}
        emptyText={isQuote ? "Inga offerter matchar sökningen" : `Inga ordrar matchar sökningen${finishedHidden ? `. ${FINISHED_HIDDEN_HINT}` : ""}`}
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
              // Leveransläget beside the status: only what needs a look
              // (Sen, Saknar täckning, Halvfabrikat sent, Tillgång utan datum).
              const mark = listOutlookMark(order.deliveryOutlook);
              return mark ? (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <StatusPill status={pill.status} label={pill.label} compact />
                  <StatusPill status={mark.tone} label={mark.label} compact />
                </span>
              ) : (
                <StatusPill status={pill.status} label={pill.label} compact />
              );
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

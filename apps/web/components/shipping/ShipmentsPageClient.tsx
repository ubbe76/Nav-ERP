"use client";

import Link from "next/link";
import { HelpLink } from "../ui/HelpLink";
import { ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";
import { SHIPMENT_STATUS_LABELS, SHIPMENT_STATUS_PILL } from "../../lib/shipping";
import type { Customer, Paged, ShipmentListRow } from "../../lib/types";

export function ShipmentsPageClient({
  shipments,
  customers,
  pageSize,
}: {
  shipments: Paged<ShipmentListRow>;
  customers: Customer[];
  pageSize: number;
}) {
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Försändelser</div>
          <div className={shellStyles.meta}>Transporter bokade via Sendify från följesedlar</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="frakt" label="Hjälp om frakt" />
      </div>

      <ListToolbar placeholder="Sök försändelse, kund, följesedel eller fraktsedelsnr…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(SHIPMENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListFilterSelect
          param="customerId"
          allLabel="Alla kunder"
          ariaLabel="Filtrera på kund"
          options={customers.map((c) => ({ value: c.id, label: `${c.customerNumber} ${c.name}` }))}
        />
      </ListToolbar>

      <Table<ShipmentListRow>
        columns={[
          { key: "shipmentNumber", label: "Försändelse", width: "120px" },
          { key: "customerName", label: "Kund", width: "1.4fr" },
          { key: "deliveryNumbers", label: "Följesedlar", width: "1fr" },
          { key: "carrier", label: "Transportör", width: "1.2fr" },
          { key: "trackingNumber", label: "Fraktsedelsnr", width: "1fr" },
          { key: "pickupDate", label: "Upphämtning", width: "120px" },
          { key: "status", label: "Status", width: "120px" },
          { key: "tracking", label: "Spårning", width: "1.2fr" },
        ]}
        rows={shipments.rows}
        emptyText="Inga försändelser matchar sökningen"
        renderCell={(s, key) => {
          switch (key) {
            case "shipmentNumber":
              return (
                <Link href={`/forsaljning/forsandelser/${s.id}`} className={listStyles.rowLink}>
                  {s.shipmentNumber}
                </Link>
              );
            case "customerName":
              return s.customerName;
            case "deliveryNumbers":
              return s.deliveryNumbers ?? "–";
            case "carrier":
              return s.carrierName ? `${s.carrierName} · ${s.productName}` : "–";
            case "trackingNumber":
              return s.trackingNumber ?? "–";
            case "pickupDate":
              return s.pickupDate;
            case "status":
              return <StatusPill status={SHIPMENT_STATUS_PILL[s.status]} label={SHIPMENT_STATUS_LABELS[s.status]} compact />;
            case "tracking":
              return s.trackingException ? (
                <span style={{ color: "var(--status-stopped-text)" }}>{s.trackingText ?? "–"}</span>
              ) : (
                s.trackingText ?? "–"
              );
            default:
              return null;
          }
        }}
      />
      <Pagination total={shipments.total} pageSize={pageSize} />
    </>
  );
}

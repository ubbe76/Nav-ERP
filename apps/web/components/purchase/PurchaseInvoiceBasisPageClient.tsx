"use client";

import { useState } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { NewSupplierInvoiceForm } from "./SupplierInvoicesPageClient";
import { formatMoney } from "../../lib/format";
import type { Paged, PurchaseInvoiceBasisEntry, Supplier } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";
import controlStyles from "../ui/ListControls.module.css";

export function PurchaseInvoiceBasisPageClient({
  basis,
  suppliers,
  pageSize,
}: {
  basis: Paged<PurchaseInvoiceBasisEntry>;
  suppliers: Supplier[];
  pageSize: number;
}) {
  // The order to create an invoice for (opens the create dialog prefilled).
  const [createFor, setCreateFor] = useState<PurchaseInvoiceBasisEntry | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Fakturaunderlag</div>
          <div className={shellStyles.meta}>{basis.total.toLocaleString("sv-SE")} inlevererade order</div>
        </div>
        <HelpLink chapter="inkop" anchor="fakturaunderlag" label="Hjälp om fakturaunderlag" />
      </div>

      <ListToolbar placeholder="Sök ordernummer eller leverantör…">
        <ListFilterSelect
          param="supplierId"
          allLabel="Alla leverantörer"
          ariaLabel="Filtrera på leverantör"
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <InvoicedFilter />
        <ListExportLink endpoint="/api/v1/purchase-invoice-basis/csv" />
      </ListToolbar>

      <Table<PurchaseInvoiceBasisEntry>
        columns={[
          { key: "orderNumber", label: "Ordernr", width: "140px" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "receivedAt", label: "Mottaget", width: "130px" },
          { key: "receivedValue", label: "Mottaget värde", width: "160px", align: "right" },
          { key: "invoiceStatus", label: "Fakturastatus", width: "1fr" },
          { key: "id", label: "", width: "150px", align: "right" },
        ]}
        rows={basis.rows}
        emptyText="Inga inlevererade order matchar urvalet"
        renderCell={(row, key) => {
          switch (key) {
            case "orderNumber":
              return (
                <Link href={`/inkop/ordrar/${row.id}`} className={listStyles.rowLink}>
                  {row.orderNumber}
                </Link>
              );
            case "supplierName":
              return row.supplierName;
            case "receivedAt":
              return row.receivedAt ? new Date(row.receivedAt).toLocaleDateString("sv-SE") : "–";
            case "receivedValue":
              return `${formatMoney(row.receivedValue)} ${row.currency}`;
            case "invoiceStatus":
              return row.invoiceId ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <StatusPill status="done" label="Fakturerad" compact />
                  <Link href={`/inkop/leverantorsfakturor/${row.invoiceId}`} className={listStyles.rowLink}>
                    {row.invoiceRegistrationNumber}
                  </Link>
                </span>
              ) : (
                <span style={{ color: "var(--color-text-muted)" }}>Ej fakturerad</span>
              );
            case "id":
              return row.invoiceId ? null : (
                <Button type="button" size="small" variant="primary" onClick={() => setCreateFor(row)}>
                  Skapa faktura
                </Button>
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={basis.total} pageSize={pageSize} />

      <Modal
        open={createFor !== null}
        onClose={() => setCreateFor(null)}
        title={createFor ? `Ny leverantörsfaktura — ${createFor.orderNumber}` : ""}
      >
        {createFor && (
          <NewSupplierInvoiceForm initialSupplierId={createFor.supplierId} initialOrderId={createFor.id} />
        )}
      </Modal>
    </>
  );
}

// Fakturastatus-filter — defaults to the worklist (ej fakturerade) when no
// param is set, so the list and the select agree.
function InvoicedFilter() {
  const { params, setFilter } = useListNavigation();
  const value = params.get("invoiced") ?? "uninvoiced";
  return (
    <div className={controlStyles.filter}>
      <div className={controlStyles.selectWrap}>
        <select
          className={controlStyles.select}
          value={value}
          onChange={(e) => setFilter("invoiced", e.target.value)}
          aria-label="Filtrera på fakturastatus"
        >
          <option value="uninvoiced">Ej fakturerade</option>
          <option value="invoiced">Fakturerade</option>
          <option value="all">Alla</option>
        </select>
        <span className={controlStyles.chevron}>▾</span>
      </div>
    </div>
  );
}

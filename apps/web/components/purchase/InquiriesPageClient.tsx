"use client";

import { useState } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import buttonStyles from "../ui/Button.module.css";
import { NewInquiryForm } from "./NewInquiryForm";
import { INQUIRY_STATUS_PILL, type Inquiry, type Paged } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/inkop/ordrar/page.module.css";
import { HelpLink } from "../ui/HelpLink";

export function InquiriesPageClient({ inquiries, pageSize }: { inquiries: Paged<Inquiry>; pageSize: number }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Förfrågningar</div>
          <div className={shellStyles.meta}>{inquiries.total.toLocaleString("sv-SE")} förfrågningar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/inkop/ordrar" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Inköpsorder
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny förfrågan
          </Button>
          <HelpLink chapter="inkop" anchor="forfragningar-prisforfragan" label="Hjälp om förfrågningar" />
        </div>
      </div>

      <ListToolbar placeholder="Sök förfrågansnummer eller leverantör…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(INQUIRY_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/inquiries/csv" />
      </ListToolbar>

      <Table<Inquiry>
        columns={[
          { key: "inquiryNumber", label: "Nummer", width: "140px" },
          { key: "supplierName", label: "Leverantör", width: "1fr" },
          { key: "status", label: "Status", width: "160px" },
          { key: "expectedDeliveryDate", label: "Önskat leveransdatum", width: "180px" },
        ]}
        rows={inquiries.rows}
        emptyText="Inga förfrågningar matchar sökningen"
        renderCell={(inquiry, key) => {
          switch (key) {
            case "inquiryNumber":
              return (
                <Link href={`/inkop/forfragningar/${inquiry.id}`} className={styles.rowLink}>
                  {inquiry.inquiryNumber}
                </Link>
              );
            case "supplierName":
              return inquiry.supplierName;
            case "status": {
              const pill = INQUIRY_STATUS_PILL[inquiry.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            case "expectedDeliveryDate":
              return inquiry.expectedDeliveryDate ?? "–";
            default:
              return null;
          }
        }}
      />

      <Pagination total={inquiries.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny förfrågan">
        <NewInquiryForm />
      </Modal>
    </>
  );
}

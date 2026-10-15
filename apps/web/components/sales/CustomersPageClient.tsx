"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewCustomerForm } from "./NewCustomerForm";
import { ListExportLink, ListToolbar, Pagination } from "../ui/ListControls";
import type { Customer, Paged } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function CustomersPageClient({ customers, pageSize }: { customers: Paged<Customer>; pageSize: number }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kunder</div>
          <div className={shellStyles.meta}>{customers.total.toLocaleString("sv-SE")} kunder</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/forsaljning/ordrar" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Säljordrar
          </Link>
          <Link href="/kunder/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Importera
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny kund
          </Button>
          <HelpLink chapter="forsaljning" anchor="kunder" label="Hjälp om kunder" />
        </div>
      </div>

      <ListToolbar placeholder="Sök kundnummer eller namn…">
        <ListExportLink endpoint="/api/v1/customers/csv" />
      </ListToolbar>

      <Table<Customer>
        columns={[
          { key: "customerNumber", label: "Kundnr", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "city", label: "Postort", width: "180px" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={customers.rows}
        emptyText="Inga kunder matchar sökningen"
        renderCell={(customer, key) => {
          switch (key) {
            case "customerNumber":
              return customer.customerNumber;
            case "name":
              return (
                <Link href={`/kunder/${customer.id}`} style={{ color: "inherit" }}>
                  <strong>{customer.name}</strong>
                </Link>
              );
            case "city":
              return customer.city ?? "–";
            case "active":
              return customer.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={customers.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny kund">
        <NewCustomerForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

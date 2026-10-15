"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewSupplierForm } from "./NewSupplierForm";
import { ListExportLink, ListToolbar, Pagination } from "../ui/ListControls";
import type { Paged, Supplier } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function SuppliersPageClient({ suppliers, pageSize }: { suppliers: Paged<Supplier>; pageSize: number }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Leverantörer</div>
          <div className={shellStyles.meta}>{suppliers.total.toLocaleString("sv-SE")} leverantörer</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/inkop/ordrar" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Inköpsordrar
          </Link>
          <Link href="/leverantorer/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Importera
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny leverantör
          </Button>
          <HelpLink chapter="inkop" anchor="leverantorer" label="Hjälp om leverantörer" />
        </div>
      </div>

      <ListToolbar placeholder="Sök leverantörsnummer eller namn…">
        <ListExportLink endpoint="/api/v1/suppliers/csv" />
      </ListToolbar>

      <Table<Supplier>
        columns={[
          { key: "supplierNumber", label: "Lev.nr", width: "110px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "city", label: "Postort", width: "180px" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={suppliers.rows}
        emptyText="Inga leverantörer matchar sökningen"
        renderCell={(supplier, key) => {
          switch (key) {
            case "supplierNumber":
              return supplier.supplierNumber;
            case "name":
              return (
                <Link href={`/leverantorer/${supplier.id}`} style={{ color: "inherit" }}>
                  <strong>{supplier.name}</strong>
                </Link>
              );
            case "currency":
              return supplier.currency;
            case "city":
              return supplier.city ?? "–";
            case "active":
              return supplier.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={suppliers.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny leverantör">
        <NewSupplierForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

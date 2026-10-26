"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewSupplierForm } from "./NewSupplierForm";
import { ListExportLink, ListToolbar, Pagination } from "../ui/ListControls";
import type { Paged, Supplier } from "../../lib/types";
import { safeReturnTo, SUPPLIER_PREFILL_KEYS, type SupplierPrefill } from "../../lib/invoiceScan";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

export function SuppliersPageClient({ suppliers, pageSize }: { suppliers: Paged<Supplier>; pageSize: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Skapa leverantör on a Fakturainkorg scan arrives as
  // /leverantorer?ny=1&name=…&returnTo=/inkop/fakturainkorg/<id>: the dialog
  // opens filled in and, once the supplier exists, goes back to the scan.
  const [prefill] = useState<SupplierPrefill | null>(() => {
    if (searchParams.get("ny") !== "1") return null;
    const values: SupplierPrefill = {};
    for (const key of SUPPLIER_PREFILL_KEYS) {
      const value = searchParams.get(key);
      if (value) values[key] = value;
    }
    return values;
  });
  const [returnTo] = useState(() => safeReturnTo(searchParams.get("returnTo")));
  const [modalOpen, setModalOpen] = useState(prefill !== null);
  const [usePrefill, setUsePrefill] = useState(prefill !== null);

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
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setUsePrefill(false);
              setModalOpen(true);
            }}
          >
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
          initial={usePrefill && prefill ? prefill : {}}
          onSuccess={(supplierId) => {
            setModalOpen(false);
            if (usePrefill && returnTo) {
              // The scan picks the new supplier up from ?supplierId=.
              router.push(`${returnTo}${returnTo.includes("?") ? "&" : "?"}supplierId=${supplierId}`);
              return;
            }
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

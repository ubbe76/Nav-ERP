"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewLegoWorkCenterForm } from "./NewLegoWorkCenterForm";
import type { Supplier, WorkCenter } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

// Legoresurser — subcontract resources: external suppliers performing an
// operation. Same register pattern as /tillverkning/resurser but without
// production group/hourly rate/schedule (a legoresurs is priced per
// operation, ställpris + styckpris, and never carries own capacity).
export function LegoWorkCentersPageClient({
  workCenters,
  allWorkCenters,
  suppliers,
}: {
  workCenters: WorkCenter[];
  // Every type — the form's number hint spans the shared code series.
  allWorkCenters: WorkCenter[];
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkCenter | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Legoresurser</div>
          <div className={shellStyles.meta}>{workCenters.length} legoresurser</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/tillverkning/resurser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Resurser
          </Link>
          <Link href="/tillverkning/resurser/import" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Importera
          </Link>
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny legoresurs
          </Button>
          <HelpLink chapter="tillverkning" anchor="legoresurser" label="Hjälp om legoresurser" />
        </div>
      </div>

      <Table<WorkCenter>
        columns={[
          { key: "code", label: "Nr", width: "70px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "supplierId", label: "Standardleverantör", width: "260px" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={workCenters}
        renderCell={(workCenter, key) => {
          switch (key) {
            case "code":
              return workCenter.code;
            case "name":
              return (
                <button
                  type="button"
                  onClick={() => setEditing(workCenter)}
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}
                >
                  <strong>{workCenter.name}</strong>
                </button>
              );
            case "supplierId":
              return workCenter.supplierName ?? "—";
            case "active":
              return workCenter.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny legoresurs">
        <NewLegoWorkCenterForm
          allWorkCenters={allWorkCenters}
          suppliers={suppliers}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Redigera ${editing.name}` : ""}>
        {editing && (
          <NewLegoWorkCenterForm
            workCenter={editing}
            allWorkCenters={allWorkCenters}
            suppliers={suppliers}
            onSuccess={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

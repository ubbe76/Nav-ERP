"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { NewEmployeeForm } from "./NewEmployeeForm";
import { EMPLOYMENT_TYPE_LABELS, type Employee } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/tillverkning/tidrapporter/page.module.css";
import { HelpLink } from "../ui/HelpLink";
import { useCanOpen } from "../PermissionsProvider";

export function EmployeesPageClient({ employees }: { employees: Employee[] }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  // Scheman and Tidrapporter live under Tillverkning — a Personal & lön-only
  // group can't open them, so the shortcuts are left out.
  const canOpen = useCanOpen();

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Anställda</div>
          <div className={shellStyles.meta}>{employees.length} anställda</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canOpen("/tillverkning/scheman") && (
            <Link href="/tillverkning/scheman" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Scheman
            </Link>
          )}
          {canOpen("/tillverkning/tidrapporter") && (
            <Link href="/tillverkning/tidrapporter" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Tidrapporter
            </Link>
          )}
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny anställd
          </Button>
          <HelpLink chapter="lon" anchor="anstallda" label="Hjälp om anställda" />
        </div>
      </div>

      <Table<Employee>
        columns={[
          { key: "employeeNumber", label: "Anställningsnr", width: "150px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "employmentType", label: "Anställningsform", width: "160px" },
          { key: "phone", label: "Telefon", width: "160px" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={employees}
        renderCell={(employee, key) => {
          switch (key) {
            case "employeeNumber":
              return (
                <Link href={`/personal/anstallda/${employee.id}`} className={styles.rowLink}>
                  {employee.employeeNumber}
                </Link>
              );
            case "name":
              return (
                <Link href={`/personal/anstallda/${employee.id}`} className={styles.rowLink}>
                  <strong>{employee.name}</strong>
                </Link>
              );
            case "employmentType":
              return employee.employmentType ? EMPLOYMENT_TYPE_LABELS[employee.employmentType] : "–";
            case "phone":
              return employee.phone ?? "–";
            case "active":
              return employee.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny anställd">
        <NewEmployeeForm
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

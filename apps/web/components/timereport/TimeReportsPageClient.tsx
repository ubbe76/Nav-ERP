"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ListExportLink, ListToolbar, Pagination } from "../ui/ListControls";
import buttonStyles from "../ui/Button.module.css";
import { NewTimeReportForm } from "./NewTimeReportForm";
import type { EmployeeDirectoryEntry, Paged, TimeReport } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import styles from "../../app/tillverkning/tidrapporter/page.module.css";
import { HelpLink } from "../ui/HelpLink";
import { useCanOpenPersonal } from "../PermissionsProvider";
import { formatQuantity } from "../../lib/format";

export function TimeReportsPageClient({
  reports,
  employees,
  pageSize,
}: {
  reports: Paged<TimeReport>;
  employees: EmployeeDirectoryEntry[];
  pageSize: number;
}) {
  const router = useRouter();
  const canOpenPersonal = useCanOpenPersonal();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Tidrapporter</div>
          <div className={shellStyles.meta}>{reports.total.toLocaleString("sv-SE")} rapporter</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {canOpenPersonal && (
            <Link href="/personal/anstallda" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Anställda
            </Link>
          )}
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Ny tidrapport
          </Button>
          <HelpLink chapter="tillverkning" anchor="tidrapporter" label="Hjälp om tidrapporter" />
        </div>
      </div>

      <ListToolbar placeholder="Sök anställd eller ordernummer…">
        <ListExportLink endpoint="/api/v1/time-reports/csv" />
      </ListToolbar>

      <Table<TimeReport>
        columns={[
          { key: "employeeName", label: "Anställd", width: "1fr" },
          { key: "manufacturingOrderNumber", label: "Tillverkningsorder", width: "160px" },
          { key: "operationSequenceNo", label: "Operation", width: "160px" },
          { key: "date", label: "Datum", width: "120px" },
          { key: "hours", label: "Timmar", width: "100px", align: "right" },
          { key: "source", label: "Källa", width: "110px" },
          { key: "note", label: "Anteckning", width: "1fr" },
        ]}
        rows={reports.rows}
        emptyText="Inga tidrapporter matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "manufacturingOrderNumber":
              return (
                <Link href={`/tillverkning/ordrar/${row.manufacturingOrderId}`} className={styles.rowLink}>
                  {row.manufacturingOrderNumber}
                </Link>
              );
            case "operationSequenceNo":
              return `${row.operationSequenceNo} — ${row.workCenterName}`;
            case "hours":
              return formatQuantity(row.hours);
            case "source":
              return row.source === "terminal" ? "Stämpling" : "Manuell";
            case "note":
              return row.note ?? "–";
            default:
              return row[key as keyof TimeReport];
          }
        }}
      />

      <Pagination total={reports.total} pageSize={pageSize} />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Ny tidrapport">
        <NewTimeReportForm
          employees={employees}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

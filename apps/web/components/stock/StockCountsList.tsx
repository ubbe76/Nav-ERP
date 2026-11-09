"use client";

import Link from "next/link";
import { Table } from "../ui/Table";
import { ListExportLink, ListFilterSelect, ListToolbar } from "../ui/ListControls";
import { useListColumns } from "../ui/ListColumns";
import { StatusPill } from "../ui/StatusPill";
import { formatStockholmDateTime } from "../../lib/date";
import { STOCK_COUNT_STATUS_LABELS, type StockCountSession } from "../../lib/types";

const PILL_STATUS = { open: "running", posted: "done", cancelled: "stopped" } as const;

const COLUMNS = [
  { key: "countNumber", label: "Nummer", width: "120px" },
  { key: "location", label: "Lagerplats", width: "1fr" },
  { key: "status", label: "Status", width: "130px" },
  { key: "blocksTransactions", label: "Spärr", width: "90px" },
  { key: "counted", label: "Räknade", width: "110px", align: "right" as const },
  { key: "createdAt", label: "Skapad", width: "160px" },
];

// Lager → Inventering: the toolbar and the table — a client part of the
// server page so the list has Kolumner (choice, widths, order).
export function StockCountsList({ rows }: { rows: StockCountSession[] }) {
  const view = useListColumns(COLUMNS);
  return (
    <>
      <ListToolbar placeholder="Sök INV-nummer eller lagerplats…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(STOCK_COUNT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ListExportLink endpoint="/api/v1/stock-counts/csv" />
        {view.chooser}
      </ListToolbar>

      <Table<StockCountSession>
        columns={view.columns}
        onColumnResize={view.onColumnResize}
        {...view.reorder}
        rows={rows}
        emptyText="Inga inventeringar ännu"
        renderCell={(row, key) => {
          switch (key) {
            case "countNumber":
              return <Link href={`/lager/inventering/${row.id}`}>{row.countNumber}</Link>;
            case "location":
              return `${row.warehouseName} — ${row.locationName}`;
            case "status":
              return <StatusPill status={PILL_STATUS[row.status]} label={STOCK_COUNT_STATUS_LABELS[row.status]} compact />;
            case "blocksTransactions":
              return row.blocksTransactions ? "Ja" : "Nej";
            case "counted":
              return `${row.countedCount} / ${row.rowCount}`;
            case "createdAt":
              return formatStockholmDateTime(row.createdAt);
            default:
              return null;
          }
        }}
      />
    </>
  );
}

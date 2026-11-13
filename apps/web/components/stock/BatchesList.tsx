"use client";

import Link from "next/link";
import { Table } from "../ui/Table";
import { ListToolbar } from "../ui/ListControls";
import { useListColumns } from "../ui/ListColumns";
import { GatedLink } from "../ui/GatedLink";
import { formatQuantity } from "../../lib/format";
import { formatStockholmDate } from "../../lib/date";
import { STOCK_BATCH_ORIGIN_LABELS, type StockBatchListRow } from "../../lib/types";

const COLUMNS = [
  { key: "batchNumber", label: "Batch", width: "180px" },
  { key: "article", label: "Artikel", width: "1fr" },
  { key: "origin", label: "Ursprung", width: "130px" },
  { key: "createdAt", label: "Skapad", width: "110px" },
  { key: "quantity", label: "Saldo", width: "120px", align: "right" as const },
];

// Lager → Spårbarhet without ?batch=: find a batch; the row opens its trace.
export function BatchesList({ rows }: { rows: StockBatchListRow[] }) {
  const view = useListColumns(COLUMNS);
  return (
    <>
      <ListToolbar placeholder="Sök batch, artikelnummer eller benämning…">{view.chooser}</ListToolbar>
      <Table<StockBatchListRow>
        columns={view.columns}
        onColumnResize={view.onColumnResize}
        {...view.reorder}
        rows={rows}
        emptyText="Inga batcher matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "batchNumber":
              return (
                <Link href={`/lager/sparbarhet?batch=${row.id}`} style={{ color: "var(--accent-fg)" }}>
                  {row.batchNumber}
                </Link>
              );
            case "article":
              return (
                <>
                  <GatedLink href={`/artiklar/${row.articleId}`} style={{ color: "var(--accent-fg)" }}>
                    {row.articleNumber}
                  </GatedLink>{" "}
                  {row.articleName}
                </>
              );
            case "origin":
              return STOCK_BATCH_ORIGIN_LABELS[row.origin] ?? row.origin;
            case "createdAt":
              return formatStockholmDate(row.createdAt);
            case "quantity":
              return `${formatQuantity(row.quantity)} ${row.unitCode}`;
            default:
              return "";
          }
        }}
      />
    </>
  );
}

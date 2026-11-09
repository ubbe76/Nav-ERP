"use client";

import Link from "next/link";
import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { Table } from "../ui/Table";
import { ListExportLink, ListFilterSelect, ListToolbar } from "../ui/ListControls";
import { useListColumns } from "../ui/ListColumns";
import { StatusPill } from "../ui/StatusPill";
import { formatQuantity } from "../../lib/format";
import type { StockBalance } from "../../lib/types";

export interface StockBalanceRow extends StockBalance {
  id: string;
}

const COLUMNS = [
  { key: "articleNumber", label: "Artikelnummer", width: "160px" },
  { key: "articleName", label: "Benämning", width: "1fr" },
  { key: "warehouseName", label: "Lager", width: "160px" },
  { key: "locationName", label: "Lagerplats", width: "160px" },
  { key: "quantityOnHand", label: "Saldo", width: "110px", align: "right" as const },
  { key: "id", label: "", width: "90px", align: "right" as const },
];

// Lager → Saldon: the toolbar and the table — a client part of the server
// page so the list has Kolumner (choice, widths, order) like the others.
export function StockBalancesList({ rows }: { rows: StockBalanceRow[] }) {
  const view = useListColumns(COLUMNS);
  return (
    <>
      <ListToolbar placeholder="Sök artikelnummer eller benämning…">
        <ListFilterSelect
          param="blocked"
          allLabel="Alla lagerplatser"
          ariaLabel="Filtrera på spärrade lagerplatser"
          options={[
            { value: "true", label: "Bara spärrade" },
            { value: "false", label: "Utan spärrade" },
          ]}
        />
        <ListExportLink endpoint="/api/v1/stock/balances/csv" />
        {view.chooser}
      </ListToolbar>

      <Table<StockBalanceRow>
        columns={view.columns}
        onColumnResize={view.onColumnResize}
        {...view.reorder}
        rows={rows}
        emptyText="Inga saldorader matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "articleNumber":
              return (
                <>
                  {row.articleNumber}
                  <ArticleOverviewButton articleId={row.articleId} articleNumber={row.articleNumber} />
                </>
              );
            case "articleName":
              return row.articleName;
            case "quantityOnHand":
              return formatQuantity(row.quantityOnHand);
            // Stock can be tracked without locations — those rows show "—".
            case "locationName":
              return (
                <span>
                  {row.locationName ?? "—"}
                  {row.locationBlocked && (
                    <span style={{ marginLeft: 8 }}>
                      <StatusPill status="stopped" label="Spärrad" compact />
                    </span>
                  )}
                </span>
              );
            case "warehouseName":
              return row.warehouseName ?? "—";
            case "id":
              return row.locationId ? (
                <Link href={`/lager/flytta?from=${row.locationId}&article=${row.articleId}`}>Flytta</Link>
              ) : null;
            default:
              return null;
          }
        }}
      />
    </>
  );
}

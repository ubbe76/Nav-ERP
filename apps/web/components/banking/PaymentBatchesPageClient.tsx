"use client";

import Link from "next/link";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { PAYMENT_BATCH_STATUS } from "../../lib/banking";
import { currencyLabel } from "../../lib/currency";
import { batchTotals } from "../../lib/currencyTotals";
import { formatMoney } from "../../lib/format";
import type { Paged, PaymentBatchListRow } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";

export function PaymentBatchesPageClient({ batches, pageSize }: { batches: Paged<PaymentBatchListRow>; pageSize: number }) {
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Betalfiler</div>
          <div className={shellStyles.meta}>{batches.total.toLocaleString("sv-SE")} betalningsomgångar</div>
        </div>
        <HelpLink chapter="inkop" anchor="betalfiler" label="Hjälp om betalfiler" />
      </div>
      <ListToolbar placeholder="Sök nummer…">
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(PAYMENT_BATCH_STATUS).map(([value, s]) => ({ value, label: s.label }))}
        />
        <GatedLink href="/inkop/bankfiler">Läs in bankfil</GatedLink>
      </ListToolbar>
      <Table<PaymentBatchListRow>
        columns={[
          { key: "batchNumber", label: "Nummer", width: "110px" },
          { key: "status", label: "Status", width: "140px" },
          { key: "itemCount", label: "Poster", width: "80px", align: "right" },
          { key: "totalAmount", label: "Belopp", width: "170px", align: "right" },
          { key: "earliestExecutionDate", label: "Betalningsdag", width: "130px" },
          { key: "exportedAt", label: "Exporterad", width: "130px" },
          { key: "confirmedCount", label: "Bekräftade", width: "1fr" },
        ]}
        rows={batches.rows}
        emptyText="Inga betalfiler än — skapa en från Öppna poster"
        renderCell={(row, key) => {
          switch (key) {
            case "batchNumber":
              return (
                <Link href={`/inkop/betalfiler/${row.id}`} className={listStyles.rowLink}>
                  {row.batchNumber}
                </Link>
              );
            case "status":
              return <StatusPill status={PAYMENT_BATCH_STATUS[row.status]!.pill} label={PAYMENT_BATCH_STATUS[row.status]!.label} />;
            case "itemCount":
              return row.itemCount;
            case "totalAmount":
              // One line per currency — never one sum over several.
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  {batchTotals(row).map((t) => (
                    <span key={t.currency}>
                      {formatMoney(t.amount)} {currencyLabel(t.currency)}
                    </span>
                  ))}
                </span>
              );
            case "earliestExecutionDate":
              return row.earliestExecutionDate ?? "–";
            case "exportedAt":
              return row.exportedAt ? row.exportedAt.slice(0, 10) : "–";
            case "confirmedCount":
              return row.status === "exported" ? `${row.confirmedCount} av ${row.itemCount}` : row.status === "confirmed" ? "Alla" : "–";
            default:
              return null;
          }
        }}
      />
      <Pagination total={batches.total} pageSize={pageSize} />
    </>
  );
}

"use client";

import Link from "next/link";
import { Table } from "../ui/Table";
import { ListExportLink, ListFilterSelect, ListToggleFilter, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { currencyLabel, formatRate, SEK } from "../../lib/currency";
import { formatMoney } from "../../lib/format";
import { stockholmToday } from "../../lib/date";
import { INVOICE_TYPE_LABELS, type Customer, type OpenInvoiceRow, type Paged } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";

// Today as a local YYYY-MM-DD string — same idiom as the rest of the app
// (NewTimeReportForm's today()). Only used for the "förfallen" marker; the
// server is authoritative for anything that actually blocks money movement.
function today(): string {
  return stockholmToday();
}

export function OpenInvoicesPageClient({
  openInvoices,
  customers,
  pageSize,
}: {
  openInvoices: Paged<OpenInvoiceRow>;
  customers: Customer[];
  pageSize: number;
}) {
  // Valuta: the SEK column only when the page has an item in another currency;
  // for SEK it would repeat Öppet belopp.
  const anyForeign = openInvoices.rows.some((r) => r.currency !== SEK);
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Öppna poster</div>
          <div className={shellStyles.meta}>{openInvoices.total.toLocaleString("sv-SE")} öppna poster</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="oppna-poster" label="Hjälp om öppna poster" />
      </div>

      <ListToolbar placeholder="Sök fakturanr, OCR eller kund…">
        <ListFilterSelect
          param="customerId"
          allLabel="Alla kunder"
          ariaLabel="Filtrera på kund"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <ListToggleFilter param="overdueOnly" label="Endast förfallna" />
        <ListExportLink endpoint="/api/v1/open-invoices/csv" />
      </ListToolbar>

      <Table<OpenInvoiceRow>
        columns={[
          { key: "invoiceNumber", label: "Faktura", width: "130px" },
          { key: "customerName", label: "Kund", width: "1.4fr" },
          { key: "type", label: "Typ", width: "130px" },
          { key: "dueDate", label: "Förfallodatum", width: "150px" },
          { key: "grossAmount", label: "Belopp", width: "130px", align: "right" },
          { key: "openAmount", label: "Öppet belopp", width: "130px", align: "right" },
          // Valuta: the open amount's booked SEK value — the column to add up.
          ...(anyForeign ? [{ key: "openAmountSek", label: "Öppet i SEK", width: "130px", align: "right" as const }] : []),
          { key: "reminders", label: "Påminnelser", width: "150px" },
        ]}
        rows={openInvoices.rows}
        emptyText="Inga öppna poster matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "invoiceNumber":
              return (
                <Link href={`/forsaljning/fakturor/${row.id}`} className={listStyles.rowLink}>
                  {row.invoiceNumber ?? "–"}
                </Link>
              );
            case "customerName":
              return row.customerName;
            case "type":
              return INVOICE_TYPE_LABELS[row.type];
            case "dueDate": {
              if (!row.dueDate) return "–";
              const overdue = row.dueDate < today();
              return overdue ? (
                <span style={{ color: "var(--status-stopped-text)", fontWeight: 600 }}>
                  {row.dueDate} · förfallen
                </span>
              ) : (
                row.dueDate
              );
            }
            case "grossAmount":
              return `${formatMoney(row.grossAmount)} ${currencyLabel(row.currency)}`;
            case "openAmount":
              return row.currency === SEK ? (
                `${formatMoney(row.openAmount)} kr`
              ) : (
                <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <span>
                    {formatMoney(row.openAmount)} {row.currency}
                  </span>
                  {row.exchangeRate !== null && (
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>kurs {formatRate(row.exchangeRate)}</span>
                  )}
                </span>
              );
            case "openAmountSek":
              return row.openAmountSek === null ? "–" : `${formatMoney(row.openAmountSek)} kr`;
            case "reminders":
              // Nivå (antal skickade påminnelser) + avgiftsmarkering (om
              // någon av dem någonsin tog ut en avgift) — both real columns
              // from payment.repository.ts's listOpenInvoices now.
              return row.reminderCount > 0 ? (
                <span>
                  {`Nivå ${row.reminderCount}`}
                  {row.reminderFeeCharged && (
                    <span style={{ color: "var(--status-delayed-text)" }}> · avgift</span>
                  )}
                </span>
              ) : (
                "–"
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={openInvoices.total} pageSize={pageSize} />
    </>
  );
}

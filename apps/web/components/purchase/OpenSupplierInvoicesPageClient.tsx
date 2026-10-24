"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { ListExportLink, ListFilterSelect, ListToggleFilter, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { currencyLabel, formatRate, SEK } from "../../lib/currency";
import { formatMoney } from "../../lib/format";
import { stockholmToday } from "../../lib/date";
import type { OpenSupplierInvoiceRow, Paged, Supplier } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";

// Today as a local YYYY-MM-DD string — same idiom as the AR mirror,
// OpenInvoicesPageClient's own today(). Only used for the "förfallen"
// marker; the server is authoritative for anything that actually blocks
// money movement.
function today(): string {
  return stockholmToday();
}

// Why a row cannot go into a payment file (null = it can). The server checks
// the same and is authoritative (SupplierInvoicesNotPayableError).
function unpayable(row: OpenSupplierInvoiceRow): string | null {
  if (row.paymentBatch) return `Ingår i betalfil ${row.paymentBatch.batchNumber}`;
  if (row.openAmount < 0) return "Kreditfakturor kvittas under Betalningar";
  // Valuta: the payment file carries SEK payments only until
  // utlandsbetalningarna — a foreign invoice is paid with Registrera betalning.
  if (row.currency !== SEK) return `Faktura i ${row.currency} — registrera utbetalningen under Betalningar (betalfilen tar bara SEK)`;
  if (!row.supplierPaymentMethod) return "Leverantören saknar betalningsuppgifter";
  if (row.supplierPaymentMethod === "iban" && !(row.supplierIban ?? "").startsWith("SE")) return "Utlandsbetalning stöds inte";
  return null;
}

export function OpenSupplierInvoicesPageClient({
  openInvoices,
  suppliers,
  pageSize,
  bankMissing,
}: {
  openInvoices: Paged<OpenSupplierInvoiceRow>;
  suppliers: Supplier[];
  pageSize: number;
  bankMissing: string[];
}) {
  const router = useRouter();
  const can = useCan();
  // Kept as rows (not ids) so the selection survives paging and filtering.
  const [selected, setSelected] = useState<Map<string, OpenSupplierInvoiceRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectedRows = [...selected.values()];
  const visibleIds = new Set(openInvoices.rows.map((r) => r.id));
  const offPage = selectedRows.filter((r) => !visibleIds.has(r.id)).length;
  const selectedTotal = selectedRows.reduce((sum, r) => sum + r.openAmount, 0);
  const anyForeign = openInvoices.rows.some((r) => r.currency !== SEK);

  function toggle(row: OpenSupplierInvoiceRow) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  async function createBatch() {
    setPending(true);
    setError(null);
    try {
      const batch = await apiFetch<{ id: string }>("/api/v1/payment-batches", {
        method: "POST",
        body: JSON.stringify({ invoiceIds: selectedRows.map((r) => r.id) }),
      });
      router.push(`/inkop/betalfiler/${batch.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Betalfilen kunde inte skapas."));
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Öppna poster</div>
          <div className={shellStyles.meta}>{openInvoices.total.toLocaleString("sv-SE")} öppna poster</div>
        </div>
        <HelpLink chapter="inkop" anchor="oppna-poster" label="Hjälp om öppna poster" />
      </div>

      <ListToolbar placeholder="Sök reg.nr, fakturanr eller leverantör…">
        <ListFilterSelect
          param="supplierId"
          allLabel="Alla leverantörer"
          ariaLabel="Filtrera på leverantör"
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <ListToggleFilter param="overdueOnly" label="Endast förfallna" />
        <ListExportLink endpoint="/api/v1/open-supplier-invoices/csv" />
      </ListToolbar>

      {can(["inkop"]) && bankMissing.length > 0 && (
        <FormNotice>Bankinställningarna är inte klara — be en administratör fylla i Bank under System ({bankMissing.join(", ")}).</FormNotice>
      )}
      {can(["inkop"]) && selected.size > 0 && (
        <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "12px 0" }}>
          <span>
            {selected.size} valda
            {offPage > 0 && ` (${offPage} på andra sidor)`} · {formatMoney(selectedTotal)} kr
          </span>
          <Button variant="ghost" size="small" onClick={() => setSelected(new Map())} disabled={pending}>
            Rensa val
          </Button>
          <Button onClick={createBatch} disabled={pending || bankMissing.length > 0}>
            Skapa betalfil
          </Button>
        </div>
      )}
      {error && <FormError>{error}</FormError>}

      <Table<OpenSupplierInvoiceRow>
        columns={[
          { key: "select", label: "", width: "40px" },
          { key: "registrationNumber", label: "Faktura", width: "1fr" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "dueDate", label: "Förfallodatum", width: "150px" },
          { key: "grossAmount", label: "Belopp", width: "130px", align: "right" },
          { key: "openAmount", label: "Öppet belopp", width: "130px", align: "right" },
          // Valuta: the open amount's booked SEK value — the column to add up.
          // Only when the page has an invoice in another currency; for SEK it
          // would repeat Öppet belopp.
          ...(anyForeign ? [{ key: "openAmountSek", label: "Öppet i SEK", width: "130px", align: "right" as const }] : []),
          { key: "paymentBatch", label: "Betalfil", width: "110px" },
        ]}
        rows={openInvoices.rows}
        emptyText="Inga öppna poster matchar sökningen"
        renderCell={(row, key) => {
          switch (key) {
            case "registrationNumber":
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <Link href={`/inkop/leverantorsfakturor/${row.id}`} className={listStyles.rowLink}>
                    {row.registrationNumber}
                  </Link>
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{row.invoiceNumber}</span>
                </span>
              );
            case "select": {
              const reason = unpayable(row);
              return (
                <span title={reason ?? undefined}>
                  <Checkbox
                    aria-label={`Välj ${row.registrationNumber}`}
                    checked={selected.has(row.id)}
                    disabled={reason !== null || !can(["inkop"])}
                    onChange={() => toggle(row)}
                  />
                </span>
              );
            }
            case "paymentBatch":
              return row.paymentBatch ? <GatedLink href={`/inkop/betalfiler/${row.paymentBatch.id}`}>{row.paymentBatch.batchNumber}</GatedLink> : "–";
            case "supplierName":
              return row.supplierName;
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
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>kurs {formatRate(row.exchangeRate)}</span>
                </span>
              );
            case "openAmountSek":
              return row.openAmountSek === null ? "–" : `${formatMoney(row.openAmountSek)} kr`;
            default:
              return null;
          }
        }}
      />

      <Pagination total={openInvoices.total} pageSize={pageSize} />
    </>
  );
}

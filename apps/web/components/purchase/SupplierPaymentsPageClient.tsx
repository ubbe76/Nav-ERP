"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { FormNotice } from "../ui/Form";
import { SupplierPaymentRegistrationForm } from "./SupplierPaymentRegistrationForm";
import { currencyLabel, exchangeDifferenceText, SEK } from "../../lib/currency";
import { formatMoney } from "../../lib/format";
import type { AccountOption, Paged, Supplier, SupplierPaymentDetail, SupplierPaymentHeader } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import listStyles from "../../app/inkop/ordrar/page.module.css";

// A cancelled (makulerad) payment reads as struck through, like an undone
// receipt or report elsewhere — the Makulerad pill alone is just another colour.
const CANCELLED_TEXT = { color: "var(--color-text-muted)", textDecoration: "line-through" } as const;

export function SupplierPaymentsPageClient({
  payments,
  suppliers,
  accounts,
  defaultBankAccount,
  tolerance,
  initialInvoiceId,
  canOpenVerifications,
  pageSize,
}: {
  payments: Paged<SupplierPaymentHeader>;
  suppliers: Supplier[];
  accounts: AccountOption[];
  defaultBankAccount: string;
  tolerance: number;
  initialInvoiceId?: string;
  canOpenVerifications: boolean;
  pageSize: number;
}) {
  const router = useRouter();
  // Valuta: the SEK column only when the page has a payment in another currency.
  const anyForeign = payments.rows.some((p) => p.currency !== SEK);
  // Opens straight into the registration panel when linked with ?invoice=
  // (a supplier invoice's "Registrera betalning" action).
  const [panelOpen, setPanelOpen] = useState(Boolean(initialInvoiceId));
  // What the last registration did — for a payment in another currency, its
  // kursdifferens (positive = kursvinst).
  const [registered, setRegistered] = useState<string | null>(null);

  function onRegistered(payment: SupplierPaymentDetail) {
    setPanelOpen(false);
    setRegistered(
      payment.currency === SEK
        ? `Betalning ${payment.paymentNumber} registrerades.`
        : `Betalning ${payment.paymentNumber} registrerades — ${exchangeDifferenceText(payment.exchangeRateDifferenceSek, formatMoney)}${
            Number(payment.bankFeeSek) > 0 ? `, bankavgift ${formatMoney(payment.bankFeeSek)} kr` : ""
          }.`
    );
    router.refresh();
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Betalningar</div>
          <div className={shellStyles.meta}>{payments.total.toLocaleString("sv-SE")} betalningar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "Avbryt registrering" : "+ Registrera betalning"}
          </Button>
          <HelpLink chapter="inkop" anchor="registrera-betalning" label="Hjälp om betalningar" />
        </div>
      </div>

      {registered && !panelOpen && <FormNotice style={{ marginBottom: 14 }}>{registered}</FormNotice>}

      {panelOpen && (
        <SupplierPaymentRegistrationForm
          suppliers={suppliers}
          accounts={accounts}
          defaultBankAccount={defaultBankAccount}
          tolerance={tolerance}
          initialInvoiceId={initialInvoiceId}
          onDone={onRegistered}
        />
      )}

      <ListToolbar placeholder="Sök UTB-nr eller leverantör…">
        <ListFilterSelect
          param="supplierId"
          allLabel="Alla leverantörer"
          ariaLabel="Filtrera på leverantör"
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <ListExportLink endpoint="/api/v1/supplier-payments/csv" />
      </ListToolbar>

      <Table<SupplierPaymentHeader>
        columns={[
          { key: "paymentNumber", label: "UTB-nr", width: "110px" },
          { key: "paymentDate", label: "Datum", width: "120px" },
          { key: "supplierName", label: "Leverantör", width: "1.4fr" },
          { key: "amount", label: "Belopp", width: "130px", align: "right" },
          ...(anyForeign ? [{ key: "amountSek", label: "Draget i SEK", width: "130px", align: "right" as const }] : []),
          { key: "bankAccountNumber", label: "Konto", width: "110px" },
          { key: "verificationDisplayNumber", label: "Verifikat", width: "120px" },
          { key: "status", label: "Status", width: "130px" },
        ]}
        rows={payments.rows}
        emptyText="Inga betalningar matchar sökningen"
        renderCell={(payment, key) => {
          switch (key) {
            case "paymentNumber":
              return (
                <Link style={payment.cancelledAt !== null ? CANCELLED_TEXT : undefined} href={`/inkop/betalningar/${payment.id}`} className={listStyles.rowLink}>
                  {payment.paymentNumber}
                </Link>
              );
            case "paymentDate":
              return payment.paymentDate;
            case "supplierName":
              return payment.supplierName;
            case "amount":
              return <span style={payment.cancelledAt !== null ? CANCELLED_TEXT : undefined}>{`${formatMoney(payment.amount)} ${currencyLabel(payment.currency)}`}</span>;
            case "amountSek":
              // Only a payment in another currency has a SEK figure of its own.
              return payment.currency === SEK ? "–" : `${formatMoney(payment.amountSek)} kr`;
            case "bankAccountNumber":
              return payment.bankAccountNumber;
            case "verificationDisplayNumber":
              // A pure kvittning never booked a verification — that absence
              // is meaningful, not sensitive, so it's shown regardless of
              // role. A real verifikat's number is admin-only, same gate as
              // InvoiceCard/SupplierInvoiceCard's own Verifikat span (the
              // whole /ekonomi/verifikat surface is admin-only).
              if (payment.verificationId === null) {
                return <span title="Kvittning (inget verifikat)">—</span>;
              }
              if (!canOpenVerifications) return null;
              return (
                <Link href={`/ekonomi/verifikat/${payment.verificationId}`}>
                  {payment.verificationDisplayNumber ?? "–"}
                </Link>
              );
            case "status":
              return payment.cancelledAt === null ? (
                <StatusPill status="done" label="Registrerad" compact />
              ) : (
                <StatusPill status="stopped" label="Makulerad" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={payments.total} pageSize={pageSize} />
    </>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SupplierPaymentsPageClient } from "../../../components/purchase/SupplierPaymentsPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { AccountOption, Paged, Supplier, SupplierPaymentHeader, SystemSettings } from "../../../lib/types";

export default async function SupplierPaymentsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [payments, suppliers, accounts, settings, user] = await Promise.all([
    apiGet<Paged<SupplierPaymentHeader>>(
      `/api/v1/supplier-payments${listApiQuery(searchParams, ["supplierId"], pageSize)}`,
      cookieHeader
    ),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Supplier>>("/api/v1/suppliers?limit=1000", cookieHeader),
    apiGet<AccountOption[]>("/api/v1/account-options", cookieHeader),
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
    // The whole /ekonomi/verifikat surface is admin-only — the list's own
    // Verifikat column links there, same gate as SupplierInvoiceCard's.
    getCurrentUser(cookieHeader),
  ]);
  // Prefills the registration form when linked from a supplier invoice's
  // "Registrera betalning" action — not a list filter, so it's kept out of
  // listApiQuery, same idiom as the AR mirror's own invoice param.
  const invoiceId = typeof searchParams.invoice === "string" ? searchParams.invoice : undefined;

  return (
    <AppShell active="Inköp">
      <SupplierPaymentsPageClient
        payments={payments}
        suppliers={suppliers.rows}
        accounts={accounts}
        defaultBankAccount={settings.postingBank}
        tolerance={settings.paymentTolerance}
        initialInvoiceId={invoiceId}
        canOpenVerifications={user ? canOpen(user, "/ekonomi/verifikat") : false}
        pageSize={pageSize}
      />
    </AppShell>
  );
}

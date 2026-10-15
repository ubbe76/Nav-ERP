import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PaymentsPageClient } from "../../../components/sales/PaymentsPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { AccountOption, Customer, Paged, PaymentHeader, SystemSettings } from "../../../lib/types";

export default async function PaymentsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [payments, customers, accounts, settings, user] = await Promise.all([
    apiGet<Paged<PaymentHeader>>(`/api/v1/payments${listApiQuery(searchParams, ["customerId"], pageSize)}`, cookieHeader),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
    apiGet<AccountOption[]>("/api/v1/account-options", cookieHeader),
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
    // The whole /ekonomi/verifikat surface is admin-only — the list's own
    // Verifikat column links there, same gate as InvoiceCard's.
    getCurrentUser(cookieHeader),
  ]);
  // Prefills the registration form when linked from an invoice's "Registrera
  // betalning" action (Task 8) — not a list filter, so it's kept out of
  // listApiQuery, same idiom as the fakturor page's orderId.
  const invoiceId = typeof searchParams.invoice === "string" ? searchParams.invoice : undefined;

  return (
    <AppShell active="Försäljning">
      <PaymentsPageClient
        payments={payments}
        customers={customers.rows}
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

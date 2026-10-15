import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { OpenSupplierInvoicesPageClient } from "../../../components/purchase/OpenSupplierInvoicesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { BankSettingsView, OpenSupplierInvoiceRow, Paged, Supplier } from "../../../lib/types";

export default async function OpenSupplierInvoicesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [openInvoices, suppliers, bank] = await Promise.all([
    apiGet<Paged<OpenSupplierInvoiceRow>>(
      `/api/v1/open-supplier-invoices${listApiQuery(searchParams, ["supplierId", "overdueOnly"], pageSize)}`,
      cookieHeader
    ),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Supplier>>("/api/v1/suppliers?limit=1000", cookieHeader),
    apiGet<BankSettingsView>("/api/v1/bank-settings", cookieHeader).catch(() => null),
  ]);

  return (
    <AppShell active="Inköp">
      <OpenSupplierInvoicesPageClient openInvoices={openInvoices} suppliers={suppliers.rows} pageSize={pageSize} bankMissing={bank?.missing ?? []} />
    </AppShell>
  );
}

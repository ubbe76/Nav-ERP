import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PurchaseInvoiceBasisPageClient } from "../../../components/purchase/PurchaseInvoiceBasisPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, PurchaseInvoiceBasisEntry, Supplier } from "../../../lib/types";

export default async function PurchaseInvoiceBasisPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [basis, suppliers] = await Promise.all([
    apiGet<Paged<PurchaseInvoiceBasisEntry>>(
      `/api/v1/purchase-invoice-basis${listApiQuery(searchParams, ["invoiced", "supplierId"], pageSize)}`,
      cookieHeader
    ),
    // Filter dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Supplier>>("/api/v1/suppliers?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Inköp">
      <PurchaseInvoiceBasisPageClient basis={basis} suppliers={suppliers.rows} pageSize={pageSize} />
    </AppShell>
  );
}

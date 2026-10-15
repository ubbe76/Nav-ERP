import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AnlaggningarPageClient } from "../../../components/economy/AnlaggningarPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import { fixedAssetListStatus } from "../../../lib/fixedAssets";
import type { DepreciationRun, FixedAsset, FixedAssetCategory, Paged, SupplierInvoice } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function AnlaggningarPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/anlaggningar")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  // Aktiva som förval (ingen parameter); status=all betyder alla.
  const params = { ...searchParams, status: fixedAssetListStatus(searchParams.status) };
  const [assets, categories, runs, supplierInvoices] = await Promise.all([
    apiGet<Paged<FixedAsset>>(`/api/v1/fixed-assets${listApiQuery(params, ["status", "categoryId"], pageSize)}`, cookieHeader),
    apiGet<FixedAssetCategory[]>("/api/v1/fixed-asset-categories", cookieHeader),
    apiGet<Paged<DepreciationRun>>("/api/v1/fixed-asset-depreciation-runs?limit=10", cookieHeader),
    apiGet<Paged<SupplierInvoice>>("/api/v1/supplier-invoices?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <AnlaggningarPageClient assets={assets} categories={categories} runs={runs} supplierInvoices={supplierInvoices.rows} pageSize={pageSize} />
    </AppShell>
  );
}

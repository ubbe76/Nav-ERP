import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { VerifikatPageClient } from "../../../components/economy/VerifikatPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { FiscalYear, Paged, VerificationListRow, VerificationSeries } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

// Every /verifications route is admin-gated in the API too (economy.routes.ts)
// — same page-level idiom as /ekonomi/kontoplan and /ekonomi/rakenskapsar.
export default async function VerifikatPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/verifikat")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const [verifications, fiscalYears, series] = await Promise.all([
    apiGet<Paged<VerificationListRow>>(
      `/api/v1/verifications${listApiQuery(searchParams, ["fiscalYearId", "seriesId", "status", "costCenterId", "projectId"], pageSize)}`,
      cookieHeader
    ),
    // Small registers (no pagination) — used for both the filter row and the
    // "+ Nytt verifikat" dialog's serie select.
    apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader),
    apiGet<VerificationSeries[]>("/api/v1/verification-series", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <VerifikatPageClient verifications={verifications} fiscalYears={fiscalYears} series={series} pageSize={pageSize} />
    </AppShell>
  );
}

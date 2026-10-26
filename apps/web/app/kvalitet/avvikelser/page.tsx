import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { DeviationsPageClient } from "../../../components/quality/DeviationsPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import { getResponsibleCandidates, type DeviationListRow, type DeviationReason } from "../../../lib/quality";
import type { Paged } from "../../../lib/types";

// The filters the URL carries to GET /deviations (the list toolbar owns
// type/status/reasonId/responsibleUserId/overdue; the rest arrive from links
// such as a customer card's "Visa alla").
const FILTER_KEYS = [
  "type",
  "status",
  "reasonId",
  "responsibleUserId",
  "overdue",
  "customerId",
  "supplierId",
  "articleId",
  "salesOrderId",
  "invoiceId",
  "purchaseOrderId",
  "manufacturingOrderId",
  "from",
  "to",
];

export default async function DeviationsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const user = await getCurrentUser(cookieHeader);
  const [deviations, reasons, responsible] = await Promise.all([
    apiGet<Paged<DeviationListRow>>(`/api/v1/deviations${listApiQuery(searchParams, FILTER_KEYS, pageSize)}`, cookieHeader),
    apiGet<DeviationReason[]>("/api/v1/deviation-reasons", cookieHeader),
    getResponsibleCandidates(cookieHeader, user),
  ]);

  return (
    <AppShell active="Kvalitet">
      <DeviationsPageClient deviations={deviations} pageSize={pageSize} reasons={reasons} responsible={responsible} />
    </AppShell>
  );
}

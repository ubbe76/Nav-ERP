import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ShipmentsPageClient } from "../../../components/shipping/ShipmentsPageClient";
import { apiGet } from "../../../lib/api";
import { getListPageSize } from "../../../lib/listPageSize";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import type { Customer, Paged, ShipmentListRow } from "../../../lib/types";

export default async function ShipmentsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [shipments, customers] = await Promise.all([
    apiGet<Paged<ShipmentListRow>>(`/api/v1/shipments${listApiQuery(searchParams, ["status", "customerId"], pageSize)}`, cookieHeader),
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
  ]);
  return (
    <AppShell active="Försäljning">
      <ShipmentsPageClient shipments={shipments} customers={customers.rows} pageSize={pageSize} />
    </AppShell>
  );
}

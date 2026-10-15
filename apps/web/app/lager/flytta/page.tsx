import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { StockTransferPageClient } from "../../../components/stock/StockTransferPageClient";
import { apiGet } from "../../../lib/api";
import type { Paged, StockBalance, StockLocation } from "../../../lib/types";

// Lagerflytt — pick a source location and move all or part of its balances to
// another location. ?from=<locationId>&article=<articleId> preselects (linked
// from the balance list).
export default async function StockTransferPage(props: {
  searchParams: Promise<{ from?: string; article?: string }>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const locations = await apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader);

  // Only locations that actually hold something can be moved from.
  const balances = searchParams.from
    ? await apiGet<Paged<StockBalance>>(
        `/api/v1/stock/balances?locationId=${searchParams.from}&limit=1000`,
        cookieHeader
      )
    : null;

  return (
    <AppShell active="Lager">
      <StockTransferPageClient
        locations={locations}
        fromLocationId={searchParams.from ?? null}
        preselectedArticleId={searchParams.article ?? null}
        balances={balances?.rows ?? []}
      />
    </AppShell>
  );
}

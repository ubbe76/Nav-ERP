import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { StockCountDetailClient } from "../../../../components/stock/StockCountDetailClient";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { StockCountDetail } from "../../../../lib/types";

export default async function StockCountDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Lager">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const session = await apiGet<StockCountDetail>(`/api/v1/stock-counts/${id}`, cookieHeader);

  return (
    <AppShell active="Lager">
      <StockCountDetailClient session={session} />
    </AppShell>
  );
}

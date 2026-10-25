import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { KostnadsstallenPageClient } from "../../../components/economy/DimensionRegisters";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { CostCenter } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function KostnadsstallenPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/kostnadsstallen")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const costCenters = await apiGet<{ rows: CostCenter[]; total: number }>(
    "/api/v1/cost-centers?includeInactive=true&limit=1000",
    cookieHeader
  );

  return (
    <AppShell active="Ekonomi">
      <KostnadsstallenPageClient costCenters={costCenters.rows} />
    </AppShell>
  );
}

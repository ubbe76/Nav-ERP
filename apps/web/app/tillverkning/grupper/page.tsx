import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ProductionGroupsPageClient } from "../../../components/timereport/ProductionGroupsPageClient";
import { apiGet } from "../../../lib/api";
import type { ProductionGroupListItem, WorkCenter } from "../../../lib/types";

export default async function ProductionGroupsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [groups, workCenters] = await Promise.all([
    apiGet<ProductionGroupListItem[]>("/api/v1/production-groups", cookieHeader),
    // Legoresurser have no production group — keep them out of the picker.
    apiGet<WorkCenter[]>("/api/v1/work-centers?type=machine,personnel", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <ProductionGroupsPageClient groups={groups} workCenters={workCenters} />
    </AppShell>
  );
}

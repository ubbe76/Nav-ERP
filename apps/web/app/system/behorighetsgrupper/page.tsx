import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PermissionGroupsPageClient } from "../../../components/system/PermissionGroupsPageClient";
import { apiGet } from "../../../lib/api";
import type { PermissionGroup } from "../../../lib/types";

// System is admin-only; proxy.ts refuses everyone else before this renders.
export default async function PermissionGroupsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const groups = await apiGet<PermissionGroup[]>("/api/v1/permission-groups", cookieHeader);
  return (
    <AppShell active="System">
      <PermissionGroupsPageClient groups={groups} />
    </AppShell>
  );
}

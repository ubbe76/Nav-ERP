import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { UsersPageClient } from "../../../components/system/UsersPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { AdminUser, PermissionGroup } from "../../../lib/types";

export default async function UsersPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const users = await apiGet<AdminUser[]>("/api/v1/auth/users", cookieHeader);

  const groups = await apiGet<PermissionGroup[]>("/api/v1/permission-groups", cookieHeader);

  return (
    <AppShell active="System">
      <UsersPageClient users={users} groups={groups} currentUserId={user.id} />
    </AppShell>
  );
}

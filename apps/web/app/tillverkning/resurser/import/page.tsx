import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { ResourceImportTabs } from "../../../../components/import/ResourceImportTabs";
import { getCurrentUser } from "../../../../lib/api";

// Admin-only, same gate as /leverantorer/import and /artiklar/import: the
// import endpoints require the admin role, so non-admins get the message
// instead of a wall of 403s. The topbar and help link live inside the
// client component so they can follow the active tab (Produktionsgrupper /
// Resurser / Legoresurser) — same shape as SupplierImportTabs.
export default async function ResourceImportPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Tillverkning">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Tillverkning">
      <ResourceImportTabs />
    </AppShell>
  );
}

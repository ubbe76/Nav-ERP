import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { CustomerImportTabs } from "../../../components/import/CustomerImportTabs";
import { getCurrentUser } from "../../../lib/api";

// Admin-only, same gate as /artiklar/import: the import endpoints require the
// admin role, so non-admins get the message instead of a wall of 403s. The
// topbar and help link live inside the client component so they can follow
// the active tab (Kunder / Kontakter / Leveransadresser).
export default async function CustomerImportPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Försäljning">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Försäljning">
      <CustomerImportTabs />
    </AppShell>
  );
}

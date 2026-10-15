import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SupplierImportTabs } from "../../../components/import/SupplierImportTabs";
import { getCurrentUser } from "../../../lib/api";

// Admin-only, same gate as /artiklar/import: the import endpoints require the
// admin role, so non-admins get the message instead of a wall of 403s. The
// topbar and help link live inside the client component so they can follow
// the active tab (Leverantörer / Kontakter / Leveransadresser) — same shape
// as /kunder/import.
export default async function SupplierImportPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Inköp">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Inköp">
      <SupplierImportTabs />
    </AppShell>
  );
}

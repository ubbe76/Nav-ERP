import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ApiClientsPageClient } from "../../../components/oauth/ApiClientsPageClient";
import { apiGet } from "../../../lib/api";
import type { ApiClient } from "../../../lib/types";

export default async function ApiClientsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const clients = await apiGet<ApiClient[]>("/api/v1/api-clients", cookieHeader).catch(() => null);

  if (clients === null) {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="System">
      <ApiClientsPageClient clients={clients} />
    </AppShell>
  );
}

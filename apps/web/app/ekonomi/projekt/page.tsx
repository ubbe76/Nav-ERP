import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ProjektPageClient } from "../../../components/economy/DimensionRegisters";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Customer, Paged, Project } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function ProjektPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/projekt")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [projects, customers] = await Promise.all([
    apiGet<{ rows: Project[]; total: number }>("/api/v1/projects?includeInactive=true&limit=1000", cookieHeader),
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <ProjektPageClient projects={projects.rows} customers={customers.rows.map((c) => ({ id: c.id, name: c.name }))} />
    </AppShell>
  );
}

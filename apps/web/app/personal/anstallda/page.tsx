import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { EmployeesPageClient } from "../../../components/timereport/EmployeesPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Employee } from "../../../lib/types";

// Personal is a supervisor tool, not a self-service page — users↔employees
// have no self-link, so a plain user has no legitimate own-data reason to be
// here, and the cards behind it (frånvaro) carry health data. Same
// admin/supervisor guard as /personal/attestering.
export default async function EmployeesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !["admin", "supervisor"].includes(user.role)) {
    return (
      <AppShell active="Personal & lön">
        <p>Endast arbetsledare och administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const employees = await apiGet<Employee[]>("/api/v1/employees", cookieHeader);

  return (
    <AppShell active="Personal & lön">
      <EmployeesPageClient employees={employees} />
    </AppShell>
  );
}

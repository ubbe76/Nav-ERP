import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { StampDayPageClient } from "../../../components/timereport/StampDayPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { stockholmToday } from "../../../lib/date";
import { stampDayLabel } from "../../../lib/stampDay";
import type { EmployeeDirectoryEntry } from "../../../lib/types";

// Stämplingar (2026-11-22): one employee's day — attendance, absence and work
// stamps — corrected in one place. ?employee=&date= drive the page; an
// unknown employee or a malformed date falls back to none / today.
// Admin/supervisor only, as the API.
export default async function StampDayPage(props: { searchParams: Promise<{ employee?: string; date?: string }> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !["admin", "supervisor"].includes(user.role)) {
    return (
      <AppShell>
        <p>Endast arbetsledare och administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? "") && !Number.isNaN(Date.parse(searchParams.date!)) ? searchParams.date! : stockholmToday();
  const [employees, timeSettings] = await Promise.all([
    apiGet<EmployeeDirectoryEntry[]>("/api/v1/employees/directory", cookieHeader),
    apiGet<{ timeKindSplit?: boolean }>("/api/v1/settings/terminal", cookieHeader).catch(() => ({ timeKindSplit: false })),
  ]);
  const employeeId = employees.some((e) => e.id === searchParams.employee) ? searchParams.employee! : null;

  return (
    <AppShell>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Stämplingar</div>
          <div className={shellStyles.meta}>{stampDayLabel(date)}</div>
        </div>
        <HelpLink chapter="lon" anchor="stamplingar" label="Hjälp om stämplingar" />
      </div>
      <StampDayPageClient
        key={`${employeeId ?? ""}:${date}`}
        employees={employees}
        employeeId={employeeId}
        date={date}
        timeKindSplit={timeSettings.timeKindSplit === true}
      />
    </AppShell>
  );
}

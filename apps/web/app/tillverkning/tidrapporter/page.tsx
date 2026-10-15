import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { TimeReportsPageClient } from "../../../components/timereport/TimeReportsPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { EmployeeDirectoryEntry, Paged, TimeReport } from "../../../lib/types";

export default async function TimeReportsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [reports, employees] = await Promise.all([
    apiGet<Paged<TimeReport>>(`/api/v1/time-reports${listApiQuery(searchParams, [], pageSize)}`, cookieHeader),
    apiGet<EmployeeDirectoryEntry[]>("/api/v1/employees/directory", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <TimeReportsPageClient reports={reports} employees={employees} pageSize={pageSize} />
    </AppShell>
  );
}

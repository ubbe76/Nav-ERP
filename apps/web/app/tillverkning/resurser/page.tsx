import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { WorkCentersPageClient } from "../../../components/manufacturing/WorkCentersPageClient";
import { apiGet } from "../../../lib/api";
import type { ProductionGroup, WeekSchedule, WorkCenter } from "../../../lib/types";

export default async function WorkCentersPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [workCenters, allWorkCenters, groups, weekSchedules] = await Promise.all([
    // Legoresurser live in their own register (/tillverkning/legoresurser).
    apiGet<WorkCenter[]>("/api/v1/work-centers?type=machine,personnel", cookieHeader),
    // Unfiltered: legoresurser share the 3-digit code series, so the form's
    // number hint has to list them too.
    apiGet<WorkCenter[]>("/api/v1/work-centers", cookieHeader),
    apiGet<ProductionGroup[]>("/api/v1/production-groups", cookieHeader),
    apiGet<WeekSchedule[]>("/api/v1/week-schedules", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <WorkCentersPageClient
        workCenters={workCenters}
        allWorkCenters={allWorkCenters}
        groups={groups}
        weekSchedules={weekSchedules}
      />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SchedulesPageClient } from "../../../components/timereport/SchedulesPageClient";
import { apiGet } from "../../../lib/api";
import type { DaySchedule, Holiday, WeekSchedule } from "../../../lib/types";

// Schemaregistret: dagsscheman, veckoscheman och helgdagar — grunden för
// personalens kalendrar och kommande löneunderlag.
export default async function SchedulesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [daySchedules, weekSchedules, holidays] = await Promise.all([
    apiGet<DaySchedule[]>("/api/v1/day-schedules", cookieHeader),
    apiGet<WeekSchedule[]>("/api/v1/week-schedules", cookieHeader),
    apiGet<Holiday[]>("/api/v1/holidays", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <SchedulesPageClient daySchedules={daySchedules} weekSchedules={weekSchedules} holidays={holidays} />
    </AppShell>
  );
}

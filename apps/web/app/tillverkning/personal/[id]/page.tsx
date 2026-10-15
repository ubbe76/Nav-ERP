import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { EmployeeTabs } from "../../../../components/timereport/EmployeeTabs";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { stockholmToday } from "../../../../lib/date";
import type {
  Absence,
  AbsenceType,
  AtfStatus,
  DaySchedule,
  Employee,
  EmployeeScheduleOverrides,
  ResolvedCalendarDay,
  SystemSettings,
  WeekSchedule,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

// Adds `days` days to a YYYY-MM-DD date (sv-SE formats ISO-style).
function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First day of the month `monthsBack` months before `date` (YYYY-MM-DD).
function firstOfMonthMonthsBack(date: string, monthsBack: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - monthsBack, 1);
  return d.toISOString().slice(0, 10);
}

// Personalkort — tabbed employee view (Allmänt / Anställning / Schema),
// same pattern as the article card. Admin/supervisor only: this is a
// supervisor tool (users↔employees have no self-link, so a plain user has
// no legitimate own-data path here) and the Frånvaro tab shows health data —
// same guard as the /tillverkning/personal list and /tillverkning/attestering.
export default async function EmployeeDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !["admin", "supervisor"].includes(user.role)) {
    return (
      <AppShell active="Tillverkning">
        <p>Endast arbetsledare och administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const employee = await apiGet<Employee>(`/api/v1/employees/${params.id}`, cookieHeader).catch(() => null);
  if (!employee) notFound();

  // Schema tab data: registers for the selects, the employee's calendar
  // overrides, and the resolved next four weeks as a preview. ATF tab gets
  // the derived status + the system default rate for the hint. Frånvaro tab
  // gets the active absence-type register and the last three months' bookings.
  const today = stockholmToday();
  const [weekSchedules, daySchedules, overrides, calendar, absenceTypes, absences, atf, systemSettings] =
    await Promise.all([
      apiGet<WeekSchedule[]>("/api/v1/week-schedules", cookieHeader),
      apiGet<DaySchedule[]>("/api/v1/day-schedules", cookieHeader),
      apiGet<EmployeeScheduleOverrides>(`/api/v1/employees/${params.id}/schedule-overrides`, cookieHeader),
      apiGet<ResolvedCalendarDay[]>(
        `/api/v1/employees/${params.id}/schedule-calendar?from=${today}&to=${addDays(today, 27)}`,
        cookieHeader
      ),
      apiGet<AbsenceType[]>("/api/v1/absence-types", cookieHeader),
      apiGet<Absence[]>(
        `/api/v1/employees/${params.id}/absences?from=${firstOfMonthMonthsBack(today, 3)}&to=${today}`,
        cookieHeader
      ),
      apiGet<AtfStatus>(`/api/v1/employees/${params.id}/atf`, cookieHeader),
      apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
    ]);

  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{employee.name}</div>
          <div className={`${shellStyles.meta} num`}>Anställningsnr {employee.employeeNumber}</div>
        </div>
        <HelpLink chapter="personal-tid" anchor="personal" label="Hjälp om personalkortet" />
      </div>

      <EmployeeTabs
        employee={employee}
        weekSchedules={weekSchedules}
        daySchedules={daySchedules}
        overrides={overrides}
        calendar={calendar}
        absenceTypes={absenceTypes}
        initialAbsences={absences}
        atf={atf}
        systemSettings={systemSettings}
        userRole={user?.role ?? "user"}
      />
    </AppShell>
  );
}

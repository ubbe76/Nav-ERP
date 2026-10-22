import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PayrollReportPageClient } from "../../../components/payroll/PayrollReportPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { MONTH_NAMES_SV, type PeriodSummary } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

// The month before the current one, in the server's local time — same
// default as Attestering (the running month isn't finished yet).
function previousMonth(): { year: number; month: number } {
  const now = new Date();
  // getMonth() is 0-indexed, so it already *is* the previous month's number.
  const month = now.getMonth();
  return month === 0 ? { year: now.getFullYear() - 1, month: 12 } : { year: now.getFullYear(), month };
}

// ?year=&month= drive the page; anything missing or out of range falls back to
// the default period rather than erroring (the API's own params schema uses
// the same 2000–2100 / 1–12 range).
function resolvePeriod(params: { year?: string; month?: string }): { year: number; month: number } {
  const fallback = previousMonth();
  const year = Number(params.year);
  const month = Number(params.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return fallback;
  if (!Number.isInteger(month) || month < 1 || month > 12) return fallback;
  return { year, month };
}

// Löneunderlag — the read-only monthly payroll report: the same underlag as
// Attestering, grouped by anställningsform, with CSV/PDF/PAXml downloads.
// Admin/supervisor only, same audience as the API endpoints.
export default async function PayrollReportPage(props: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !["admin", "supervisor"].includes(user.role)) {
    return (
      <AppShell active="Personal & lön">
        <p>Endast arbetsledare och administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const { year, month } = resolvePeriod(searchParams);
  const summary = await apiGet<PeriodSummary>(`/api/v1/periods/${year}/${month}`, cookieHeader);
  const monthName = MONTH_NAMES_SV[month - 1]!;
  const monthLabel = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)}`;

  return (
    <AppShell active="Personal & lön">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Löneunderlag</div>
          <div className={shellStyles.meta}>
            {monthLabel} {year} · {summary.status === "locked" ? "Låst" : "Öppen"}
          </div>
        </div>
        <HelpLink chapter="lon" anchor="loneunderlag" label="Hjälp om löneunderlag" />
      </div>

      <PayrollReportPageClient summary={summary} year={year} month={month} />
    </AppShell>
  );
}

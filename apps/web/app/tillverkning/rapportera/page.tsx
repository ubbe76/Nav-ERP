import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { OperationReportPageClient } from "../../../components/manufacturing/OperationReportPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { suggestsRest, type RestSuggestionSettings } from "../../../lib/restSuggestion";
import type { EmployeeDirectoryEntry, TerminalStation } from "../../../lib/types";

export const dynamic = "force-dynamic";

// Tillverkning → Rapportera (2026-11-24): an operation's time and quantities
// reported by hand, one at a time. The list itself is fetched by the client
// (it is refetched after every report).
export default async function OperationReportPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [employees, stations, settings, user] = await Promise.all([
    apiGet<EmployeeDirectoryEntry[]>("/api/v1/employees/directory", cookieHeader),
    apiGet<TerminalStation[]>("/api/v1/terminal/stations", cookieHeader),
    // Rest som förslag i antalsfältet → Rapportering, and Dela tid i ställ och
    // produktion; a failed read keeps the defaults.
    apiGet<RestSuggestionSettings & { timeKindSplit?: boolean }>("/api/v1/settings/terminal", cookieHeader).catch(() => null),
    getCurrentUser(cookieHeader),
  ]);

  return (
    <AppShell>
      <OperationReportPageClient
        employees={employees.filter((e) => e.active)}
        stations={stations}
        suggestRest={suggestsRest(settings, "report")}
        timeKindSplit={settings?.timeKindSplit === true}
        // Ångra rapportering removes the time report too — the TO card's rule.
        canUndo={user?.role === "admin" || user?.role === "supervisor"}
      />
    </AppShell>
  );
}

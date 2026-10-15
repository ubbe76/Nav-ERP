import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser, apiGet } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { StampTerminal } from "../../../components/timereport/StampTerminal";
import { ConfirmDialogHost } from "../../../components/ui/ConfirmDialogHost";
import type {
  AttendanceSession,
  EmployeeDirectoryEntry,
  ManufacturingOrder,
  Paged,
  StampSession,
} from "../../../lib/types";

// Fullscreen stamp terminal (stämpelterminal) for a shared shop-floor device —
// deliberately rendered without AppShell/sidebar. The device runs under a
// normal logged-in session; personnel identify per action by employee number.
export default async function StampTerminalPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");
  // proxy.ts already guards the page; this keeps a direct render honest too.
  if (!canOpen(user, "/tillverkning/terminal")) redirect("/ingen-behorighet");

  const [employees, openSessions, openAttendance, orders, settings] = await Promise.all([
    apiGet<EmployeeDirectoryEntry[]>("/api/v1/employees/directory", cookieHeader),
    apiGet<StampSession[]>("/api/v1/stamp-sessions?open=true", cookieHeader),
    apiGet<AttendanceSession[]>("/api/v1/attendance-sessions?open=true", cookieHeader),
    apiGet<Paged<ManufacturingOrder>>(
      "/api/v1/manufacturing-orders?status=released,in_progress&limit=1000&withOperations=true",
      cookieHeader
    ),
    apiGet<{ allowMultipleStamps: boolean }>("/api/v1/settings/terminal", cookieHeader),
  ]);

  const stampableOrders = orders.rows;

  // The terminal has no AppShell, so it mounts the app's confirmation dialog
  // itself — otherwise confirmDialog ("Rapportera ändå?" on a material
  // shortage) falls back to window.confirm, which Safari on iPhone can stop
  // showing and then silently answers Avbryt.
  return (
    <>
      <StampTerminal
        employees={employees.filter((e) => e.active)}
        initialOpenSessions={openSessions}
        initialOpenAttendance={openAttendance}
        initialOrders={stampableOrders}
        allowMultipleStamps={settings.allowMultipleStamps}
      />
      <ConfirmDialogHost />
    </>
  );
}

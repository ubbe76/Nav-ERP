import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../../lib/api";
import { canOpen } from "../../../../lib/pageAccess";
import { DayPlanPageClient } from "../../../../components/planning/DayPlanPageClient";
import { PermissionsProvider } from "../../../../components/PermissionsProvider";

// Dagplanens Mötesläge — for the screen on the wall at the morning meeting.
// Rendered without AppShell/sidebar, like the stamp terminal, and read-only:
// no ordering, no row menu, no dialogs (so no ConfirmDialogHost either). The
// permissions provider is mounted here because there is no AppShell.
export default async function DayPlanMeetingPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");
  // proxy.ts already guards the page; this keeps a direct render honest too.
  if (!canOpen(user, "/tillverkning/dagplan")) redirect("/ingen-behorighet");

  return (
    <PermissionsProvider role={user.role} permissions={user.permissions}>
      <DayPlanPageClient meeting />
    </PermissionsProvider>
  );
}

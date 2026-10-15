import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { InProgressPageClient } from "../../../components/timereport/InProgressPageClient";
import { apiGet } from "../../../lib/api";
import type { AttendanceSession, StampSession } from "../../../lib/types";

export const dynamic = "force-dynamic";

export default async function InProgressPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [stamps, attendance] = await Promise.all([
    apiGet<StampSession[]>("/api/v1/stamp-sessions?open=true", cookieHeader),
    apiGet<AttendanceSession[]>("/api/v1/attendance-sessions?open=true", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <InProgressPageClient stamps={stamps} attendance={attendance} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { LonekoderPageClient } from "../../../components/payroll/LonekoderPageClient";
import { getCurrentUser, apiGet } from "../../../lib/api";
import type { AbsenceType, AttendanceDeviationReason, ObRule } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

// Lönekoder: frånvarokoder och OB-tillägg, the base-data registers the
// löneunderlag/PAXml export is built from. Admin-only, same gate as the rest
// of the payroll settings (System → Inställningar → Lön & PAXml).
export default async function LonekoderPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Tillverkning">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const [absenceTypes, obRules, deviationReasons] = await Promise.all([
    apiGet<AbsenceType[]>("/api/v1/absence-types?includeInactive=true", cookieHeader),
    apiGet<ObRule[]>("/api/v1/ob-rules?includeInactive=true", cookieHeader),
    apiGet<AttendanceDeviationReason[]>("/api/v1/attendance-deviation-reasons?includeInactive=true", cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lönekoder</div>
          <div className={shellStyles.meta}>Frånvarokoder, OB-tillägg och avvikelseorsaker för löneunderlaget</div>
        </div>
        <HelpLink chapter="lon" anchor="franvarokoder" label="Hjälp om lönekoder" />
      </div>

      <LonekoderPageClient absenceTypes={absenceTypes} obRules={obRules} deviationReasons={deviationReasons} />
    </AppShell>
  );
}

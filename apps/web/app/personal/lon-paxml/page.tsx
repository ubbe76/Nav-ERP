import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PayrollSettingsForm } from "../../../components/payroll/PayrollSettingsForm";
import { getCurrentUser, apiGet } from "../../../lib/api";
import type { SystemSettings } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

// Lön & PAXml: PAXml time codes, the overtime threshold, the ATF accrual and
// the terminal's deviation/overtime questions. Admin-only, same gate as Lönekoder.
// GET /settings is readable by every logged-in user (the terminal needs it),
// so the admin gate lives here in the page.
export default async function LonPaxmlPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Personal & lön">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const settings = await apiGet<SystemSettings>("/api/v1/settings", cookieHeader);

  return (
    <AppShell active="Personal & lön">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lön &amp; PAXml</div>
          <div className={shellStyles.meta}>Tidkoder, övertidsregler, ATF-intjäning och terminalens frågor</div>
        </div>
        <HelpLink chapter="lon" anchor="lon-paxml" label="Hjälp om Lön & PAXml" />
      </div>

      <PayrollSettingsForm settings={settings} />
    </AppShell>
  );
}

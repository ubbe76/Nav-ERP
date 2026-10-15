import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { CostingSettingsForm } from "../../../components/system/CostingSettingsForm";
import { getCurrentUser, apiGet } from "../../../lib/api";
import type { SystemSettings } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function CostingSettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  // GET /settings is readable by every logged-in user, so the admin gate lives
  // here in the page, matching the rest of System.
  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const settings = await apiGet<SystemSettings>("/api/v1/settings", cookieHeader);

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kalkyler</div>
          <div className={shellStyles.meta}>Materialkostnad och påslag för för- och efterkalkyl</div>
        </div>
        <HelpLink chapter="system" anchor="kalkyler" label="Hjälp om kalkyler" />
      </div>

      <CostingSettingsForm settings={settings} />
    </AppShell>
  );
}

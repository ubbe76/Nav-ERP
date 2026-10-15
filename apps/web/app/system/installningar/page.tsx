import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SettingsForm } from "../../../components/system/SettingsForm";
import { PayrollSettingsForm } from "../../../components/system/PayrollSettingsForm";
import { SmtpSettingsForm } from "../../../components/system/SmtpSettingsForm";
import { getCurrentUser, apiGet } from "../../../lib/api";
import type { SystemSettings } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function SettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  // GET /settings is readable by every logged-in user (the terminal needs it),
  // so the admin gate lives here in the page, matching the rest of System.
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
          <div className={shellStyles.title}>Inställningar</div>
          <div className={shellStyles.meta}>Systembeteenden</div>
        </div>
        <HelpLink chapter="system" anchor="installningar" label="Hjälp om inställningar" />
      </div>

      <SettingsForm settings={settings} />
      <PayrollSettingsForm settings={settings} />
      <SmtpSettingsForm settings={settings} />
    </AppShell>
  );
}

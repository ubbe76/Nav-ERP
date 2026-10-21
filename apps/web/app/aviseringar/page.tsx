import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { AlertsPageClient } from "../../components/alerts/AlertsPageClient";
import { HelpLink } from "../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../lib/api";
import { canOpen } from "../../lib/pageAccess";
import type { AlertKind, AlertsResponse } from "../../lib/alerts";
import shellStyles from "../../components/AppShell.module.css";

interface MeSettings {
  alertDigest: boolean;
  alertDigestKinds: AlertKind[] | null;
}

export default async function AlertsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/aviseringar")) {
    return (
      <AppShell active="Aviseringar">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [alerts, settings, system] = await Promise.all([
    apiGet<AlertsResponse>("/api/v1/alerts", cookieHeader),
    apiGet<MeSettings>("/api/v1/me/settings", cookieHeader),
    // The send time is a system setting. Whether the user may read it is up
    // to the API, so a refusal just leaves the time out of the text; SMTP
    // status is only shown to administrators.
    apiGet<{ alertDigestTime?: string; smtpHost?: string }>("/api/v1/settings", cookieHeader).catch(() => null),
  ]);

  return (
    <AppShell active="Aviseringar">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Aviseringar</div>
          <div className={shellStyles.meta}>Det som behöver åtgärdas just nu</div>
        </div>
        <HelpLink chapter="aviseringar" label="Hjälp om aviseringar" />
      </div>

      <AlertsPageClient
        initial={alerts}
        digest={{ enabled: settings.alertDigest, kinds: settings.alertDigestKinds }}
        email={user.email}
        readOnly={user.readOnly}
        digestTime={system?.alertDigestTime ?? null}
        smtpMissing={user.role === "admin" && system !== null && !system.smtpHost}
      />
    </AppShell>
  );
}

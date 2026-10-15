import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HubSections } from "../../components/ui/HubSections";
import { RAPPORTER_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { HelpLink } from "../../components/ui/HelpLink";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";
import { canOpen } from "../../lib/pageAccess";

export default async function RapporterPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter")) {
    return (
      <AppShell active="Rapporter">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const sections = sectionsForUser(RAPPORTER_SECTIONS, user);

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Rapporter</div>
          <div className={shellStyles.meta}>
            Analyserande rapporter härledda ur order-, faktura- och tillverkningsdata
          </div>
        </div>
        <HelpLink chapter="rapporter" label="Hjälp om rapporter" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

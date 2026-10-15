import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HubSections } from "../../components/ui/HubSections";
import { SYSTEM_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../../components/ui/HelpLink";

export default async function SystemPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const sections = sectionsForUser(SYSTEM_SECTIONS, user);

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>System</div>
          <div className={shellStyles.meta}>Systemomfattande inställningar</div>
        </div>
        <HelpLink chapter="system" label="Hjälp om systemmodulen" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

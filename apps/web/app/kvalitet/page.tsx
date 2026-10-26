import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { HubSections } from "../../components/ui/HubSections";
import { KVALITET_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";

// Module menu for Kvalitet: the avvikelseregister, the follow-up reports and
// the Kvalitetsorsaker register. Filtered by the page-access table like every
// hub, so a report the user's group can't open is not offered.
export default async function QualityPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  const sections = sectionsForUser(KVALITET_SECTIONS, user ?? { role: "user", permissions: [] });

  return (
    <AppShell active="Kvalitet">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kvalitet</div>
          <div className={shellStyles.meta}>Reklamationer och avvikelser</div>
        </div>
        <HelpLink chapter="kvalitet" label="Hjälp om kvalitet" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { withPluginPages } from "../../lib/pluginHub";
import { HubSections } from "../../components/ui/HubSections";
import { PERSONAL_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";

// Module menu for Personal & lön. Filtered both by role (Anställda, Attestering
// and Löneunderlag need arbetsledare, Lönekoder and Lön & PAXml admin) and by
// permission group (pageAccess.ts) in sectionsForUser.
export default async function PersonalPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  // AppShell redirects an unauthenticated visitor to /login before this
  // renders; "user" as the fallback role is simply the least-privileged one.
  const sections = await withPluginPages(sectionsForUser(PERSONAL_SECTIONS, user ?? { role: "user", permissions: [] }), "personal", cookieHeader);

  return (
    <AppShell active="Personal & lön">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Personal &amp; lön</div>
          <div className={shellStyles.meta}>Anställda, attestering och löneunderlag</div>
        </div>
        <HelpLink chapter="lon" anchor="anstallda" label="Hjälp om Personal & lön" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

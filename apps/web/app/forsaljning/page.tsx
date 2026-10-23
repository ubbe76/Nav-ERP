import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { HelpLink } from "../../components/ui/HelpLink";
import { withPluginPages } from "../../lib/pluginHub";
import { HubSections } from "../../components/ui/HubSections";
import { getCurrentUser } from "../../lib/api";
import { FORSALJNING_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import shellStyles from "../../components/AppShell.module.css";

// The module's own page is its menu (TODO2 #14): the sidebar carries one
// entry per module, and everything inside it is reached from the grid here.
// The sections are filtered by role and permission group (sectionsForUser).
export default async function SalesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  const sections = await withPluginPages(sectionsForUser(FORSALJNING_SECTIONS, user ?? { role: "user", permissions: [] }), "forsaljning", cookieHeader);

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Försäljning</div>
          <div className={shellStyles.meta}>Kundordrar, fakturor och reskontra</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/forsaljning/ordrar">
            <Button variant="primary">+ Ny kundorder</Button>
          </Link>
          <HelpLink chapter="forsaljning" anchor="oversikt" label="Hjälp om försäljningsmodulen" />
        </div>
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

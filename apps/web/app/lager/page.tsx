import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { withPluginPages } from "../../lib/pluginHub";
import { HubSections } from "../../components/ui/HubSections";
import { LAGER_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";

// Module menu (TODO2 #14). The balance list that used to live here moved to
// /lager/saldon so the module root behaves like every other module's — the
// old address still resolves, it just shows this menu instead of the list.
export default async function StockPage() {
  // Some routines in this module are admin-only (see the roles flags in
  // moduleNav.ts). The module itself is open to everyone, so the filtering
  // has to happen here — an unfiltered card would be the only visible route
  // to a page that just answers "Endast administratörer …".
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  const sections = await withPluginPages(sectionsForUser(LAGER_SECTIONS, user ?? { role: "user", permissions: [] }), "lager", cookieHeader);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lager</div>
          <div className={shellStyles.meta}>Saldon, transaktioner, lagerplatser och inventering</div>
        </div>
        <HelpLink chapter="lager" label="Hjälp om lagermodulen" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

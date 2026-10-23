import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { withPluginPages } from "../../lib/pluginHub";
import { HubSections } from "../../components/ui/HubSections";
import { ARTIKLAR_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";

// Module menu (TODO2 #14). The article register moved to /artiklar/register;
// the article card stays at /artiklar/[id], and the static "register"
// sibling wins over the dynamic segment (same routing rule the legacy
// /forsaljning/[id] redirect stub relies on).
export default async function ArticlesPage() {
  // Some routines in this module are admin-only (see the roles flags in
  // moduleNav.ts). The module itself is open to everyone, so the filtering
  // has to happen here — an unfiltered card would be the only visible route
  // to a page that just answers "Endast administratörer …".
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  const sections = await withPluginPages(sectionsForUser(ARTIKLAR_SECTIONS, user ?? { role: "user", permissions: [] }), "artiklar", cookieHeader);

  return (
    <AppShell active="Artiklar">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Artiklar</div>
          <div className={shellStyles.meta}>Artikelregister, artikelgrupper och import</div>
        </div>
        <HelpLink chapter="artiklar" label="Hjälp om artikelmodulen" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

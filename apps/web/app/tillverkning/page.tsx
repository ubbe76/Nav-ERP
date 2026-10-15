import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { HubSections } from "../../components/ui/HubSections";
import { TILLVERKNING_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";

// Module menu (TODO2 #14). Filtered both by role (Personal, Attestering and
// Löneunderlag need arbetsledare, Lönekoder admin) and by permission group
// (pageAccess.ts) in sectionsForUser. With the sidebar submenu gone the grid is the only way in, so an
// unfiltered card would be the sole visible route to a page that answers
// "Endast arbetsledare och administratörer har åtkomst till den här sidan."
export default async function ManufacturingPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  // AppShell redirects an unauthenticated visitor to /login before this
  // renders; "user" as the fallback role is simply the least-privileged one.
  const sections = sectionsForUser(TILLVERKNING_SECTIONS, user ?? { role: "user", permissions: [] });

  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Tillverkning</div>
          <div className={shellStyles.meta}>Tillverkningsorder, resurser och tidrapportering</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="oversikt" label="Hjälp om tillverkningsmodulen" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

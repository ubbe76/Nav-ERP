import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { HelpLink } from "../../components/ui/HelpLink";
import { HubSections } from "../../components/ui/HubSections";
import { EKONOMI_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import { getCurrentUser } from "../../lib/api";
import shellStyles from "../../components/AppShell.module.css";
import { canOpen } from "../../lib/pageAccess";

// Module menu (TODO2 #14). Ekonomi had no page of its own before — the
// sidebar pointed straight at /ekonomi/verifikat. Admin-gated as a whole,
// the same shape as /system and /rapporter: the economy module is admin-only
// end to end (every /accounts, /fiscal-years and /verifications route
// requires the admin role), so no per-item roles are needed in the grid.
export default async function EconomyPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const sections = sectionsForUser(EKONOMI_SECTIONS, user);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Ekonomi</div>
          <div className={shellStyles.meta}>Bokföring, rapporter och grunddata</div>
        </div>
        <HelpLink chapter="ekonomi" label="Hjälp om ekonomimodulen" />
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

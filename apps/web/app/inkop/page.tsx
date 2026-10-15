import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../components/AppShell";
import { Button } from "../../components/ui/Button";
import { HelpLink } from "../../components/ui/HelpLink";
import { HubSections } from "../../components/ui/HubSections";
import { getCurrentUser } from "../../lib/api";
import { INKOP_SECTIONS, sectionsForUser } from "../../lib/moduleNav";
import shellStyles from "../../components/AppShell.module.css";

// Module menu — see the sales mirror for why this page carries no KPIs
// (TODO2 #14). The grid is filtered by role and permission group.
export default async function PurchasePage() {
  const user = await getCurrentUser((await headers()).get("cookie") ?? undefined);
  const sections = sectionsForUser(INKOP_SECTIONS, user ?? { role: "user", permissions: [] });

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inköp</div>
          <div className={shellStyles.meta}>Inköpsordrar, förfrågningar och leverantörsfakturor</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/inkop/ordrar">
            <Button variant="primary">+ Ny inköpsorder</Button>
          </Link>
          <HelpLink chapter="inkop" anchor="oversikt" label="Hjälp om inköpsmodulen" />
        </div>
      </div>

      <HubSections sections={sections} />
    </AppShell>
  );
}

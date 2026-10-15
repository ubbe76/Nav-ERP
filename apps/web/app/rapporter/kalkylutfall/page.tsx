import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { KalkylutfallPageClient } from "../../../components/reports/KalkylutfallPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /rapporter pages — GET
// /reports/calculation-outcome requires the admin role in the API too.
export default async function KalkylutfallPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/kalkylutfall")) {
    return (
      <AppShell active="Rapporter">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kalkylutfall</div>
          <div className={shellStyles.meta}>Förkalkyl mot efterkalkyl per tillverkningsorder</div>
        </div>
        <HelpLink chapter="rapporter" anchor="kalkylutfall" label="Hjälp om kalkylutfall" />
      </div>

      <KalkylutfallPageClient
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
      />
    </AppShell>
  );
}

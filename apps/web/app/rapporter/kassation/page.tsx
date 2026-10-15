import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { KassationPageClient } from "../../../components/reports/KassationPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /rapporter pages — GET /reports/scrap-statistics
// requires the admin role in the API too.
export default async function KassationPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/kassation")) {
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
          <div className={shellStyles.title}>Kassationsstatistik</div>
          <div className={shellStyles.meta}>Kassationer per månad, artikel, resurs eller orsak</div>
        </div>
        <HelpLink chapter="rapporter" anchor="kassationsstatistik" label="Hjälp om kassationsstatistik" />
      </div>

      <KassationPageClient
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}

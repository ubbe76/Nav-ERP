import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { StatisticsPageClient } from "../../../components/reports/StatisticsPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /rapporter pages — GET /reports/sales-statistics
// requires the admin role in the API too.
export default async function ForsaljningsstatistikPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/forsaljningsstatistik")) {
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
          <div className={shellStyles.title}>Försäljningsstatistik</div>
          <div className={shellStyles.meta}>Fakturerad nettoomsättning per månad, kund eller artikel</div>
        </div>
        <HelpLink chapter="rapporter" anchor="forsaljningsstatistik" label="Hjälp om försäljningsstatistik" />
      </div>

      <StatisticsPageClient
        kind="sales"
        endpoint="/api/v1/reports/sales-statistics"
        entityLabel="Kund"
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}

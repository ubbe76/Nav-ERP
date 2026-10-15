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

// Admin-gated like the sibling /rapporter pages — GET
// /reports/purchase-statistics requires the admin role in the API too.
export default async function InkopsstatistikPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/inkopsstatistik")) {
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
          <div className={shellStyles.title}>Inköpsstatistik</div>
          <div className={shellStyles.meta}>Leverantörsfakturor per månad, leverantör eller artikel</div>
        </div>
        <HelpLink chapter="rapporter" anchor="inkopsstatistik" label="Hjälp om inköpsstatistik" />
      </div>

      <StatisticsPageClient
        kind="purchase"
        endpoint="/api/v1/reports/purchase-statistics"
        entityLabel="Leverantör"
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}

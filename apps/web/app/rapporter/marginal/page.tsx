import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { MarginalPageClient } from "../../../components/reports/MarginalPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /rapporter pages — GET /reports/order-margin
// requires the admin role in the API too.
export default async function MarginalPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/marginal")) {
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
          <div className={shellStyles.title}>Marginal</div>
          <div className={shellStyles.meta}>Täckningsbidrag på fakturerad omsättning per månad, kund eller artikel</div>
        </div>
        <HelpLink chapter="rapporter" anchor="marginal" label="Hjälp om marginalrapporten" />
      </div>

      <MarginalPageClient
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}

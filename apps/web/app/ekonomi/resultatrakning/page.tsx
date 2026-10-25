import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ResultatrakningPageClient } from "../../../components/economy/ResultatrakningPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { FiscalYear } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /ekonomi pages — /income-statement requires
// the admin role in the API too (economy.routes.ts).
export default async function ResultatrakningPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/resultatrakning")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Resultaträkning</div>
          <div className={shellStyles.meta}>Rörelsens intäkter och kostnader för en period</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="resultatrakning" label="Hjälp om resultaträkningen" />
      </div>

      <ResultatrakningPageClient
        fiscalYears={fiscalYears}
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        defaultCostCenterId={singleParam(searchParams.costCenterId)}
        defaultProjectId={singleParam(searchParams.projectId)}
        defaultGroupBy={singleParam(searchParams.groupBy)}
      />
    </AppShell>
  );
}

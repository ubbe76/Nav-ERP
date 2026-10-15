import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { MomsrapportPageClient } from "../../../components/economy/MomsrapportPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { FiscalYear } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /ekonomi pages — every /vat-report route
// requires the admin role in the API too (economy.routes.ts).
export default async function MomsrapportPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/momsrapport")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Ordered newest-first (economy.repository.ts's listFiscalYears).
  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Momsrapport</div>
          <div className={shellStyles.meta}>Momsdeklarationens rutor per månad eller kvartal, med momsomföring</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="momsrapport" label="Hjälp om momsrapporten" />
      </div>

      <MomsrapportPageClient
        fiscalYears={fiscalYears}
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
      />
    </AppShell>
  );
}

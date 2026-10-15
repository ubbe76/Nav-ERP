import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BalansrakningPageClient } from "../../../components/economy/BalansrakningPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { FiscalYear } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /ekonomi pages — /balance-sheet requires the
// admin role in the API too (economy.routes.ts).
export default async function BalansrakningPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/balansrakning")) {
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
          <div className={shellStyles.title}>Balansräkning</div>
          <div className={shellStyles.meta}>Tillgångar, eget kapital och skulder per ett datum</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="balansrakning" label="Hjälp om balansräkningen" />
      </div>

      <BalansrakningPageClient fiscalYears={fiscalYears} defaultAsOf={singleParam(searchParams.asOf)} />
    </AppShell>
  );
}

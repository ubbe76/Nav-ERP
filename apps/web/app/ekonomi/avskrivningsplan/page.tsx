import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AvskrivningsplanPageClient } from "../../../components/economy/AvskrivningsplanPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { FiscalYear, FixedAssetPlan } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

export default async function AvskrivningsplanPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/avskrivningsplan")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Newest first (economy.repository.ts's listFiscalYears) — the newest is the default.
  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);
  const requested = typeof searchParams.fiscalYearId === "string" ? searchParams.fiscalYearId : undefined;
  const selectedId = fiscalYears.find((year) => year.id === requested)?.id ?? fiscalYears[0]?.id ?? null;
  const plan = selectedId ? await apiGet<FixedAssetPlan>(`/api/v1/fixed-asset-plan?fiscalYearId=${selectedId}`, cookieHeader) : null;

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Avskrivningsplan</div>
          <div className={shellStyles.meta}>Anskaffningsvärden, avskrivningar och bokfört värde per räkenskapsår</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="avskrivningsplan" label="Hjälp om avskrivningsplanen" />
      </div>
      <AvskrivningsplanPageClient fiscalYears={fiscalYears} selectedId={selectedId} plan={plan} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { MomsrapportPageClient } from "../../../components/economy/MomsrapportPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { FiscalYear, VatReportingSettings } from "../../../lib/types";
import type { VatCodeView } from "../../../lib/vatCodes";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Gated by the Ekonomi permission like the sibling /ekonomi pages — every
// /vat-report route requires it in the API too (economy.routes.ts).
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
  // The company's Redovisningsperiod för moms picks the preselected period;
  // the page works without it (months), so a failed read is not fatal. The
  // momskoder feed the Bokför importmoms dialog's preview.
  const [reporting, vatCodes] = await Promise.all([
    apiGet<VatReportingSettings>("/api/v1/settings/vat-reporting", cookieHeader).catch(() => null),
    apiGet<VatCodeView[]>("/api/v1/vat-codes", cookieHeader).catch(() => [] as VatCodeView[]),
  ]);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Momsrapport</div>
          <div className={shellStyles.meta}>
            Momsdeklarationens alla rutor per månad, kvartal eller helår — med fil till Skatteverket och momsomföring
          </div>
        </div>
        <HelpLink chapter="ekonomi" anchor="momsrapport" label="Hjälp om momsrapporten" />
      </div>

      <MomsrapportPageClient
        fiscalYears={fiscalYears}
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
        reporting={reporting}
        vatCodes={vatCodes}
      />
    </AppShell>
  );
}

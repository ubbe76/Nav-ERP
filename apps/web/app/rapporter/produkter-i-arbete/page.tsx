import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ProdukterIArbetePageClient } from "../../../components/reports/ProdukterIArbetePageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like Lagervärdering — GET /costing/work-in-progress requires
// the admin role in the API too (costing.routes.ts).
export default async function ProdukterIArbetePage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Rapporter">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Produkter i arbete</div>
          <div className={shellStyles.meta}>Upparbetat minus avräknat per öppen tillverkningsorder, per valfritt datum</div>
        </div>
        <HelpLink chapter="rapporter" anchor="produkter-i-arbete" label="Hjälp om produkter i arbete" />
      </div>

      <ProdukterIArbetePageClient
        defaultAsOf={singleParam(searchParams.asOf)} defaultBasis={singleParam(searchParams.basis)}
        defaultDetail={singleParam(searchParams.kostnadsslag) === "1"}
      />
    </AppShell>
  );
}

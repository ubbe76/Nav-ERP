import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { LeveransprecisionPageClient } from "../../../components/reports/LeveransprecisionPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Admin-gated like the sibling /ekonomi and /lager/vardering reports — GET
// /reports/delivery-precision requires the admin role in the API too.
export default async function LeveransprecisionPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/leveransprecision")) {
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
          <div className={shellStyles.title}>Leveransprecision</div>
          <div className={shellStyles.meta}>Hur väl lovade leveransdatum hålls, kundordrar och inköpsordrar</div>
        </div>
        <HelpLink chapter="rapporter" anchor="leveransprecision" label="Hjälp om leveransprecision" />
      </div>

      <LeveransprecisionPageClient
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
      />
    </AppShell>
  );
}

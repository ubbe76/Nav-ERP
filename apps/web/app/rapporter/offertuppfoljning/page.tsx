import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { QuoteFollowupPageClient } from "../../../components/reports/QuoteFollowupPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";
import { stockholmToday } from "../../../lib/date";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function OffertuppfoljningPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/offertuppfoljning")) {
    return (
      <AppShell active="Rapporter">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Default period: the current calendar year (Stockholm).
  const year = stockholmToday().slice(0, 4);

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Offertuppföljning</div>
          <div className={shellStyles.meta}>Hur stor andel av offerterna som blir order — hit rate</div>
        </div>
        <HelpLink chapter="rapporter" anchor="offertuppfoljning" label="Hjälp om offertuppföljningen" />
      </div>

      <QuoteFollowupPageClient
        defaults={{
          from: singleParam(searchParams.from) ?? `${year}-01-01`,
          to: singleParam(searchParams.to) ?? `${year}-12-31`,
          customerId: singleParam(searchParams.customerId),
        }}
      />
    </AppShell>
  );
}

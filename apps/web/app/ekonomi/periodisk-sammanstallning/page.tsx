import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PeriodiskSammanstallningPageClient } from "../../../components/economy/PeriodiskSammanstallningPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { stockholmToday } from "../../../lib/date";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Periodisk sammanställning — EU-försäljning per köparens momsnummer. Gated by
// the Ekonomi permission like the rest of /ekonomi: GET /periodic-summary
// requires it in the API too.
export default async function PeriodiskSammanstallningPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/periodisk-sammanstallning")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Periodisk sammanställning</div>
          <div className={shellStyles.meta}>
            EU-försäljning per köparens momsnummer — avstämd mot momsrapporten, med fil till Skatteverket
          </div>
        </div>
        <HelpLink
          chapter="ekonomi"
          anchor="periodisk-sammanstallning"
          label="Hjälp om periodisk sammanställning"
        />
      </div>

      {/* "Today" is taken here, on the server in Swedish time, so the period
          list and the preselected month are the same on server and client. */}
      <PeriodiskSammanstallningPageClient
        today={stockholmToday()}
        defaultFrom={singleParam(searchParams.from)}
        defaultTo={singleParam(searchParams.to)}
      />
    </AppShell>
  );
}

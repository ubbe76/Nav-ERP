import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { HuvudbokPageClient } from "../../../components/economy/HuvudbokPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { stockholmToday } from "../../../lib/date";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { Account, FiscalYear, Paged } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

// Fallback when there is no fiscal year yet — the current calendar year,
// same "1 Jan – 31 Dec" convention as RakenskapsarPageClient's
// nextCalendarYearBounds (this one is the CURRENT year, not next).
function currentCalendarYearBounds(): { start: string; end: string } {
  const year = new Date().getFullYear();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Every /ledger route is admin-gated in the API too (economy.routes.ts) —
// same page-level idiom as /ekonomi/kontoplan, /ekonomi/rakenskapsar and
// /ekonomi/verifikat.
export default async function HuvudbokPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/huvudbok")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [accounts, fiscalYears] = await Promise.all([
    // Form dropdown data, fetched in full (same "?limit=1000" convention as
    // the verification card's account picker). includeInactive is deliberate:
    // a deactivated account can still carry booked history, and a ledger that
    // silently hides it is a reporting bug. Inactive options are labelled.
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000&includeInactive=true", cookieHeader),
    // Ordered newest-first (economy.repository.ts's listFiscalYears) — [0] is
    // the latest fiscal year, used to prefill the date range below.
    apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader),
  ]);

  // Default to the fiscal year covering TODAY, not fiscalYears[0] (newest
  // first, so [0] can be a pre-registered FUTURE year — defaulting to it
  // would silently render an empty ledger). Same covering-year idiom as
  // MomsrapportPageClient's initialYearId. Falls back to the latest year
  // when none covers today (e.g. no fiscal year registered yet).
  const today = stockholmToday();
  const currentYear = fiscalYears.find((year) => year.startDate <= today && today <= year.endDate);
  const latestYear = currentYear ?? fiscalYears[0];
  const calendarYear = currentCalendarYearBounds();

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Huvudbok</div>
          <div className={shellStyles.meta}>Ingående, löpande och utgående saldo per konto</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="huvudbok" label="Hjälp om huvudbok" />
      </div>

      <HuvudbokPageClient
        accounts={accounts.rows}
        defaultAccountId={singleParam(searchParams.accountId) ?? accounts.rows[0]?.id ?? ""}
        defaultFrom={singleParam(searchParams.from) ?? latestYear?.startDate ?? calendarYear.start}
        defaultTo={singleParam(searchParams.to) ?? latestYear?.endDate ?? calendarYear.end}
      />
    </AppShell>
  );
}

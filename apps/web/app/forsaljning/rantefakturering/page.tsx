import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { LateInterestPageClient } from "../../../components/sales/LateInterestPageClient";
import { apiGet } from "../../../lib/api";
import { stockholmToday } from "../../../lib/date";
import type { Customer, LateInterestCandidates, Paged, SystemSettings } from "../../../lib/types";

// Räntefakturering: overdue and late-paid invoices with dröjsmålsränta and
// förseningsersättning, one räntefaktura per customer. The URL carries the
// selection (?asOf=&customerId=&includeUnpaid=false), so the list can be
// reloaded and linked. While Debitera dröjsmålsränta is off the API refuses
// the list (409 late-interest-disabled) — the settings are read first and the
// page then only explains where to switch it on.
export default async function RantefaktureringPage(props: {
  searchParams: Promise<{ asOf?: string; customerId?: string; includeUnpaid?: string }>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const settings = await apiGet<SystemSettings>("/api/v1/settings", cookieHeader);

  if (!settings.lateInterestEnabled) {
    return (
      <AppShell active="Försäljning">
        <LateInterestPageClient enabled={false} />
      </AppShell>
    );
  }

  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.asOf ?? "") ? searchParams.asOf! : stockholmToday();
  const customerId = typeof searchParams.customerId === "string" && searchParams.customerId !== "" ? searchParams.customerId : "";
  const includeUnpaid = searchParams.includeUnpaid !== "false";

  const query = new URLSearchParams({ asOf, includeUnpaid: String(includeUnpaid) });
  if (customerId) query.set("customerId", customerId);

  const [candidates, customers] = await Promise.all([
    apiGet<LateInterestCandidates>(`/api/v1/late-interest/candidates?${query.toString()}`, cookieHeader),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Försäljning">
      <LateInterestPageClient
        // Remount on a new urval so the selection and results start over.
        key={`${asOf}|${customerId}|${includeUnpaid}`}
        enabled
        asOf={asOf}
        customerId={customerId}
        includeUnpaid={includeUnpaid}
        initial={candidates}
        customers={customers.rows}
        lateFeeEnabled={settings.lateFeeEnabled}
        minAmount={settings.lateInterestMinAmount}
      />
    </AppShell>
  );
}

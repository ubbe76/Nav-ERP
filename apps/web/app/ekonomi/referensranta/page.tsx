import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ReferenceRatesPageClient } from "../../../components/economy/ReferenceRatesPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { canOpen } from "../../../lib/pageAccess";
import { stockholmToday } from "../../../lib/date";
import type { Paged, ReferenceRateEntry } from "../../../lib/types";

// Referensränta: Riksbankens referensränta per kalenderhalvår — grunden för
// dröjsmålsräntan (räntelagen 6 §). The API follows the customer invoices'
// rule (read office, write forsaljning), so the page opens for Ekonomi and
// Försäljning alike (pageAccess.ts) and the buttons follow the write rule.
export default async function ReferensrantaPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/referensranta")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const rates = await apiGet<Paged<ReferenceRateEntry>>("/api/v1/reference-rates", cookieHeader);

  return (
    <AppShell active="Ekonomi">
      <ReferenceRatesPageClient rates={rates} today={stockholmToday()} />
    </AppShell>
  );
}

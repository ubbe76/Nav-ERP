import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { RakenskapsarPageClient } from "../../../components/economy/RakenskapsarPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { FiscalYear } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

// Every /fiscal-years and /accounting-periods route is admin-gated in the
// API too (economy.routes.ts) — same page-level idiom as /system/anvandare
// and /ekonomi/kontoplan.
export default async function RakenskapsarPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/rakenskapsar")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Small register (one row per accounting year the company has ever had) —
  // no search/pagination, same convention as GET /verification-series.
  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);

  return (
    <AppShell active="Ekonomi">
      <RakenskapsarPageClient fiscalYears={fiscalYears} />
    </AppShell>
  );
}

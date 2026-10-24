import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { VerifikatmallarPageClient } from "../../../components/economy/VerifikatmallarPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, Paged, VerificationSeries, VerificationTemplate } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function VerifikatmallarPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/verifikatmallar")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [templates, accounts, series] = await Promise.all([
    apiGet<{ rows: VerificationTemplate[]; total: number }>("/api/v1/verification-templates?includeInactive=true", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
    apiGet<VerificationSeries[]>("/api/v1/verification-series", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <VerifikatmallarPageClient templates={templates.rows} accounts={accounts.rows} series={series} />
    </AppShell>
  );
}

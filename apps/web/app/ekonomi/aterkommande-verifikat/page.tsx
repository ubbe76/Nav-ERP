import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AterkommandeVerifikatPageClient } from "../../../components/economy/AterkommandeVerifikatPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { RecurringVerification, VerificationTemplate } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function AterkommandeVerifikatPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/aterkommande-verifikat")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [recurring, templates] = await Promise.all([
    apiGet<{ rows: RecurringVerification[]; total: number }>("/api/v1/recurring-verifications", cookieHeader),
    apiGet<{ rows: VerificationTemplate[]; total: number }>("/api/v1/verification-templates", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <AterkommandeVerifikatPageClient recurring={recurring.rows} templates={templates.rows} />
    </AppShell>
  );
}

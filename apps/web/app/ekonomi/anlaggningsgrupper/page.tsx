import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AnlaggningsgrupperPageClient } from "../../../components/economy/AnlaggningsgrupperPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, FixedAssetCategory, Paged } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function AnlaggningsgrupperPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/anlaggningsgrupper")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [categories, accounts] = await Promise.all([
    apiGet<FixedAssetCategory[]>("/api/v1/fixed-asset-categories", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <AnlaggningsgrupperPageClient categories={categories} accounts={accounts.rows} />
    </AppShell>
  );
}

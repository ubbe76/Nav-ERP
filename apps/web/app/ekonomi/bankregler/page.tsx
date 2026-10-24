import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BankreglerPageClient } from "../../../components/economy/BankreglerPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, BankRule, Paged } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function BankreglerPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/bankregler")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [rules, accounts] = await Promise.all([
    apiGet<{ rows: BankRule[]; total: number }>("/api/v1/bank-rules", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <BankreglerPageClient rules={rules.rows} accounts={accounts.rows} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { MomskoderPageClient } from "../../../components/economy/MomskoderPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, Paged } from "../../../lib/types";
import type { VatCodeView } from "../../../lib/vatCodes";
import { canOpen } from "../../../lib/pageAccess";

// Momskoder: the fixed catalog with the company's own accounts, invoice text
// and active flag. Gated by the Ekonomi permission like the rest of /ekonomi
// — PATCH /vat-codes/:id requires it in the API too.
export default async function MomskoderPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/momskoder")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // GET /vat-codes answers with a plain array in catalog order.
  const [codes, accounts] = await Promise.all([
    apiGet<VatCodeView[]>("/api/v1/vat-codes", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Ekonomi">
      <MomskoderPageClient codes={codes} accounts={accounts.rows} />
    </AppShell>
  );
}

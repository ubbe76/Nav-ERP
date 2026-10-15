import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SiePageClient } from "../../../components/economy/SiePageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { FiscalYear } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

// Admin-gated like the sibling /ekonomi pages — /sie/export and
// /sie/opening-balances both require the admin role in the API too
// (economy.routes.ts's "--- SIE (B6b) ---" section).
export default async function SiePage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/sie")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  // Newest-first, same ordering as /ekonomi/rakenskapsar (economy.repository.ts's listFiscalYears).
  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);

  return (
    <AppShell active="Ekonomi">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>SIE-filer</div>
          <div className={shellStyles.meta}>Export av räkenskapsår och import av ingående balanser</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="sie-filer" label="Hjälp om SIE-filer" />
      </div>

      <SiePageClient fiscalYears={fiscalYears} />
    </AppShell>
  );
}

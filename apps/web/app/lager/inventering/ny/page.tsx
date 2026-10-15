import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { NewStockCountForm } from "../../../../components/stock/NewStockCountForm";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { StockLocation } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function NewStockCountPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Lager">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const locations = await apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Ny inventering</div>
        </div>
        <HelpLink chapter="lager" anchor="inventering" label="Hjälp om inventering" />
      </div>

      <NewStockCountForm locations={locations} />
    </AppShell>
  );
}

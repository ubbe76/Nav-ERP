import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { NewAdjustmentForm } from "../../../components/stock/NewAdjustmentForm";
import { apiGet } from "../../../lib/api";
import type { StockLocation } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function NewAdjustmentPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const locations = await apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Justering</div>
        </div>
        <HelpLink chapter="lager" anchor="justering" label="Hjälp om justeringar" />
      </div>

      <NewAdjustmentForm locations={locations} />
    </AppShell>
  );
}

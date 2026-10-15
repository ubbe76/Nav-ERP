import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { WarehousesSection } from "../../../components/stock/WarehousesSection";
import { LocationsSection } from "../../../components/stock/LocationsSection";
import { apiGet } from "../../../lib/api";
import type { StockLocation, Warehouse } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function StockPlacesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [warehouses, locations] = await Promise.all([
    apiGet<Warehouse[]>("/api/v1/stock/warehouses", cookieHeader),
    // The register is the one place that shows deactivated locations — a
    // location emptied by a move or a delivery is deactivated, not deleted.
    apiGet<StockLocation[]>("/api/v1/stock/locations?includeInactive=true", cookieHeader),
  ]);

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lagerplatser</div>
        </div>
        <HelpLink chapter="lager" anchor="lagerplatser" label="Hjälp om lagerplatser" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        <WarehousesSection warehouses={warehouses} />
        <LocationsSection locations={locations} warehouses={warehouses} />
      </div>
    </AppShell>
  );
}

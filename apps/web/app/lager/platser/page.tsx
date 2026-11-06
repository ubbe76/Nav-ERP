import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { WarehousesSection } from "../../../components/stock/WarehousesSection";
import { LocationsSection } from "../../../components/stock/LocationsSection";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, StockLocationRegisterRow, Warehouse } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function StockPlacesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const pageSize = await getListPageSize();
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [warehouses, locationsPage] = await Promise.all([
    apiGet<Warehouse[]>("/api/v1/stock/warehouses", cookieHeader),
    // The register is the one place that shows deactivated locations (status
    // filter) — a location emptied by a move or a delivery is deactivated.
    apiGet<Paged<StockLocationRegisterRow>>(
      `/api/v1/stock/locations/register${listApiQuery(searchParams, ["warehouseId", "status", "blocked"], pageSize)}`,
      cookieHeader
    ),
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
        <LocationsSection locations={locationsPage.rows} total={locationsPage.total} pageSize={pageSize} warehouses={warehouses} />
      </div>
    </AppShell>
  );
}

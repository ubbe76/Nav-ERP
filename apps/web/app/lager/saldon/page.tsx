import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { Pagination } from "../../../components/ui/ListControls";
import { StockBalancesList, type StockBalanceRow } from "../../../components/stock/StockBalancesList";
import buttonStyles from "../../../components/ui/Button.module.css";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, StockBalance } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";


export default async function StockPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  // Inventering is admin-only (the page and the API), so the button is too.
  const user = await getCurrentUser(cookieHeader);
  const balancesPage = await apiGet<Paged<StockBalance>>(
    `/api/v1/stock/balances${listApiQuery(searchParams, ["blocked", "locationId"], pageSize)}`,
    cookieHeader
  );
  const balances: StockBalanceRow[] = balancesPage.rows.map((b) => ({ ...b, id: `${b.articleId}-${b.locationId}` }));

  // ?locationId= (from Visa saldon in Lagerplatser): say which place is shown.
  const locationId = typeof searchParams.locationId === "string" ? searchParams.locationId : undefined;
  const shown = locationId ? balancesPage.rows.find((b) => b.locationId === locationId) : undefined;
  const locationLabel = shown ? `${shown.warehouseName ?? "—"} — ${shown.locationName ?? "—"}` : "vald lagerplats";

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Lager</div>
          <div className={shellStyles.meta}>{balancesPage.total.toLocaleString("sv-SE")} saldorader</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/lager/platser" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Lagerplatser
          </Link>
          <Link href="/lager/transaktioner" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Transaktioner
          </Link>
          <Link href="/lager/flytta" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            Lagerflytt
          </Link>
          <Link href="/lager/justering" className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
            + Justering
          </Link>
          {user?.role === "admin" && (
            <Link href="/lager/inventering" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
              Inventering
            </Link>
          )}
          <HelpLink chapter="lager" anchor="saldon" label="Hjälp om lagersaldon" />
        </div>
      </div>

      {locationId && (
        <p style={{ margin: "0 0 12px" }}>
          Visar saldot på lagerplatsen <strong>{locationLabel}</strong>.{" "}
          <Link href="/lager/saldon">Visa alla lagerplatser</Link>
        </p>
      )}

      <StockBalancesList rows={balances} />

      <Pagination total={balancesPage.total} pageSize={pageSize} />
    </AppShell>
  );
}

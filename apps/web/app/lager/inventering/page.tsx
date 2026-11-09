import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { Pagination } from "../../../components/ui/ListControls";
import { StockCountsList } from "../../../components/stock/StockCountsList";
import buttonStyles from "../../../components/ui/Button.module.css";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, StockCountSession } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";
import { StockCountScanPanel } from "../../../components/stock/StockCountScanPanel";

// Admin-gated like /lager/vardering — the API requires admin on /stock-counts.
export default async function StockCountListPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || user.role !== "admin") {
    return (
      <AppShell active="Lager">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const sessions = await apiGet<Paged<StockCountSession>>(
    `/api/v1/stock-counts${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Inventering</div>
          <div className={shellStyles.meta}>{sessions.total.toLocaleString("sv-SE")} inventeringar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Link href="/lager/inventering/ny" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
            + Ny inventering
          </Link>
          <HelpLink chapter="lager" anchor="inventering" label="Hjälp om inventering" />
        </div>
      </div>

      <StockCountScanPanel />

      <StockCountsList rows={sessions.rows} />

      <Pagination total={sessions.total} pageSize={pageSize} />
    </AppShell>
  );
}

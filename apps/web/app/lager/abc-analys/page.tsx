import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AbcPageClient } from "../../../components/stock/AbcPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { AbcResponse } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";

// ABC-analys (#10): every active purchased/manufactured article classed on its
// consumption value over the period in System → Inställningar. Office users
// (the planning module's read rule), like Behovsberäkning.
export default async function AbcPage(props: {
  searchParams: Promise<PageSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const data = await apiGet<AbcResponse>(
    `/api/v1/planning/abc${listApiQuery(searchParams, ["class", "type"], pageSize)}`,
    cookieHeader,
  );

  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>ABC-analys</div>
          <div className={shellStyles.meta}>
            Artiklarna klassade på förbrukningsvärde — vilka som förtjänar
            beställningspunkt och säkerhetslager
          </div>
        </div>
        <HelpLink
          chapter="lager"
          anchor="abc-analys"
          label="Hjälp om ABC-analys"
        />
      </div>

      <AbcPageClient data={data} pageSize={pageSize} />
    </AppShell>
  );
}

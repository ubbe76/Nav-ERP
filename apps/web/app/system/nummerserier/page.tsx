import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { NumberSeriesList } from "../../../components/system/NumberSeriesList";
import { apiGet } from "../../../lib/api";
import type { NumberSeries } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

export default async function NumberSeriesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const series = await apiGet<NumberSeries[]>("/api/v1/number-series", cookieHeader).catch(() => null);

  if (series === null) {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Nummerserier</div>
          <div className={shellStyles.meta}>Prefix och löpnummer för order och artiklar</div>
        </div>
        <HelpLink chapter="system" anchor="nummerserier" label="Hjälp om nummerserier" />
      </div>

      <NumberSeriesList series={series} />
    </AppShell>
  );
}

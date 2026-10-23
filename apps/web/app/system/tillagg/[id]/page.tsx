import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../../components/AppShell";
import { PluginDetailClient } from "../../../../components/plugins/PluginDetailClient";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet } from "../../../../lib/api";
import type { PluginDeliveryRow, PluginDetail } from "../../../../lib/plugins";
import shellStyles from "../../../../components/AppShell.module.css";

export default async function PluginCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [plugin, deliveries] = await Promise.all([
    apiGet<PluginDetail>(`/api/v1/plugins/${id}`, cookieHeader).catch(() => null),
    apiGet<PluginDeliveryRow[]>(`/api/v1/plugins/${id}/deliveries`, cookieHeader).catch(() => []),
  ]);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{plugin ? plugin.name : "Tillägg"}</div>
          <div className={shellStyles.meta}>
            <Link href="/system/tillagg">Tillägg</Link>
          </div>
        </div>
        <HelpLink chapter="tillagg" label="Hjälp om tillägg" />
      </div>
      {plugin ? <PluginDetailClient initialPlugin={plugin} initialDeliveries={deliveries} /> : <p>Tillägget finns inte.</p>}
    </AppShell>
  );
}

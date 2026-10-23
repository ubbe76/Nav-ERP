import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PluginsPageClient } from "../../../components/plugins/PluginsPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import type { PluginListRow } from "../../../lib/plugins";
import shellStyles from "../../../components/AppShell.module.css";

// System is admin-only; proxy.ts refuses everyone else before this renders.
export default async function PluginsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const plugins = await apiGet<PluginListRow[]>("/api/v1/plugins", cookieHeader);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Tillägg</div>
          <div className={shellStyles.meta}>Externa program som läser Nav via API:t och tar emot händelser</div>
        </div>
        <HelpLink chapter="tillagg" label="Hjälp om tillägg" />
      </div>
      <PluginsPageClient initialPlugins={plugins} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { PluginFrame } from "../../../../components/plugins/PluginFrame";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { satisfiesRule } from "../../../../lib/permissions";
import { PLUGIN_MODULE_NAV, type PluginUi } from "../../../../lib/plugins";
import shellStyles from "../../../../components/AppShell.module.css";

// A plugin's page, embedded. The route is open to every office user
// (pageAccess.ts); the module's own permission is checked here, because it
// depends on which module the plugin put the page under — the same rule as
// the API's POST /plugins/:id/context (satisfiesRule on the page's module).
export default async function PluginPage({ params }: { params: Promise<{ plugin: string; page: string }> }) {
  const { plugin, page } = await params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");

  const ui = await apiGet<PluginUi>("/api/v1/plugin-ui", cookieHeader).catch(() => null);
  const entry = ui?.pages.find((p) => p.pluginKey === plugin && p.key === page) ?? null;
  if (entry && !satisfiesRule(user, [entry.module])) redirect("/ingen-behorighet");

  return (
    <AppShell active={entry ? (PLUGIN_MODULE_NAV[entry.module] as Parameters<typeof AppShell>[0]["active"]) : "Översikt"}>
      {entry ? (
        <>
          <div className={shellStyles.topbar}>
            <div>
              <div className={shellStyles.title}>{entry.title}</div>
              <div className={shellStyles.meta}>Tillägget {entry.pluginName}</div>
            </div>
          </div>
          <PluginFrame pluginId={entry.pluginId} title={entry.title} request={{ page: entry.key }} mode="page" />
        </>
      ) : (
        <p>Sidan finns inte, eller tillägget är pausat.</p>
      )}
    </AppShell>
  );
}

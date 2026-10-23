import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ThemesPageClient } from "../../../components/system/ThemesPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import type { SystemSettings, ThemeListRow } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";

// System is admin-only; proxy.ts refuses everyone else before this renders.
export default async function ThemesPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [themes, settings] = await Promise.all([
    apiGet<ThemeListRow[]>("/api/v1/themes", cookieHeader),
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
  ]);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Teman</div>
          <div className={shellStyles.meta}>Förvalt tema, lås och egna färgteman</div>
        </div>
        <HelpLink chapter="system" anchor="teman" label="Hjälp om teman" />
      </div>
      <ThemesPageClient
        initialThemes={themes}
        defaultTheme={settings.defaultTheme}
        themeChoiceLocked={settings.themeChoiceLocked}
      />
    </AppShell>
  );
}

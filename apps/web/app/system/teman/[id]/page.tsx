import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { ThemeEditor } from "../../../../components/system/ThemeEditor";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet } from "../../../../lib/api";
import type { ThemeDetail } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";

export default async function EditThemePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const theme = await apiGet<ThemeDetail>(`/api/v1/themes/${id}`, cookieHeader).catch(() => null);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{theme ? theme.name : "Tema"}</div>
          <div className={shellStyles.meta}>Temaredigerare</div>
        </div>
        <HelpLink chapter="system" anchor="teman" label="Hjälp om teman" />
      </div>
      {theme ? <ThemeEditor theme={theme} copyOf={null} /> : <p>Temat finns inte.</p>}
    </AppShell>
  );
}

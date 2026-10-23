import { AppShell } from "../../../../components/AppShell";
import { ThemeEditor } from "../../../../components/system/ThemeEditor";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";

export default async function NewThemePage({ searchParams }: { searchParams: Promise<{ kopia?: string }> }) {
  const { kopia } = await searchParams;
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Nytt tema</div>
          <div className={shellStyles.meta}>Välj grundfärger — Nav räknar fram resten</div>
        </div>
        <HelpLink chapter="system" anchor="teman" label="Hjälp om teman" />
      </div>
      <ThemeEditor theme={null} copyOf={kopia ?? null} />
    </AppShell>
  );
}

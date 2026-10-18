import { AppShell } from "../../components/AppShell";
import { HubSections, type HubSection } from "../../components/ui/HubSections";
import { MANUAL_CHAPTERS } from "../../lib/manual";
import { ManualSearch } from "../../components/help/ManualSearch";
import shellStyles from "../../components/AppShell.module.css";

const GROUP_ORDER = ["Komma igång", "Register", "Flöden", "System"] as const;

export default async function ManualHubPage(props: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await props.searchParams;
  const query = Array.isArray(q) ? (q[0] ?? "") : (q ?? "");
  const sections: HubSection[] = GROUP_ORDER.map((group) => ({
    title: group,
    items: MANUAL_CHAPTERS.filter((c) => c.group === group).map((c) => ({
      href: `/hjalp/${c.slug}`,
      title: c.title,
      description: c.description,
    })),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell active="Hjälp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Hjälp</div>
          <div className={shellStyles.meta}>Användarmanual för alla rutiner och inställningar</div>
        </div>
      </div>

      <ManualSearch query={query} />

      {!query.trim() && <HubSections sections={sections} icons={false} />}
    </AppShell>
  );
}

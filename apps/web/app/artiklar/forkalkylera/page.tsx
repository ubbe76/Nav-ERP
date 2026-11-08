import { AppShell } from "../../../components/AppShell";
import { PreCalculationBatchPageClient } from "../../../components/articles/PreCalculationBatchPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Förkalkylera flera (#27) — pre-calculate many articles at once from the
// user's Kopierat list or a filter, review the figures, save the marked rows.
// ?urval=kopierat preselects Kopierat (the link in the article register).
export default async function PreCalculationBatchPage(props: { searchParams: Promise<{ urval?: string }> }) {
  const { urval } = await props.searchParams;
  return (
    <AppShell active="Artiklar">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Förkalkylera flera</div>
          <div className={shellStyles.meta}>Förkalkylera ett urval artiklar, jämför mot förra förkalkylen och spara de markerade</div>
        </div>
        <HelpLink chapter="artiklar" anchor="forkalkylera-flera" label="Hjälp om Förkalkylera flera" />
      </div>
      <PreCalculationBatchPageClient initialSource={urval === "kopierat" ? "copied" : "filter"} />
    </AppShell>
  );
}

import { AppShell } from "../../../components/AppShell";
import { RunPlanPageClient } from "../../../components/manufacturing/RunPlanPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Körplan — the waiting operations on one resource, by week. Fetches client
// side (URL-driven ?resurs=&tom=); this server component owns the topbar.
export default function RunPlanPage() {
  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Körplan</div>
          <div className={shellStyles.meta}>Kommande arbeten på en resurs, vecka för vecka</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="korplan" label="Hjälp om körplan" />
      </div>

      <RunPlanPageClient />
    </AppShell>
  );
}

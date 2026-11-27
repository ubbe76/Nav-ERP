import { AppShell } from "../../../components/AppShell";
import { DayPlanPageClient } from "../../../components/planning/DayPlanPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Dagplan — every resource's work one day, in körordning. Fetches client side
// (URL-driven ?dag=&grupp=); this server component owns the topbar.
export default function DayPlanPage() {
  return (
    <AppShell>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Dagplan</div>
          <div className={shellStyles.meta}>Dagens arbeten per resurs, i körordning</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="dagplan" label="Hjälp om dagplan" />
      </div>

      <DayPlanPageClient />
    </AppShell>
  );
}

import { AppShell } from "../../../components/AppShell";
import { BelaggningPageClient } from "../../../components/planning/BelaggningPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Beläggning (E2, capacity load matrix) — like Behovsberäkning, the routine
// fetches and reacts to filter changes entirely client-side (URL-driven
// weeks/produktionsgrupp params, inline cell drill-down with no extra
// fetch), so this server component only owns the shell/topbar. Not
// admin-gated — any user who can plan production.
export default function BelaggningPage() {
  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Beläggning</div>
          <div className={shellStyles.meta}>Beläggning per resurs och vecka från släppta tillverkningsordrar</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="belaggning" label="Hjälp om beläggning" />
      </div>

      <BelaggningPageClient />
    </AppShell>
  );
}

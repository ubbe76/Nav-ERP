import { AppShell } from "../../../components/AppShell";
import { StructurePageClient } from "../../../components/planning/StructurePageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Struktur — one order's whole tree (a kundorder's rows or a TO at the top)
// with its planned days. Fetches client side (URL-driven ?to=<id> / ?ko=<id>);
// this server component owns the topbar. Reached from the cards, not the menu.
export default function StructurePage() {
  return (
    <AppShell>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Struktur</div>
          <div className={shellStyles.meta}>En orders hela träd med planerade dagar</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="struktur" label="Hjälp om strukturvyn" />
      </div>

      <StructurePageClient />
    </AppShell>
  );
}

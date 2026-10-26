import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { RegisterTab } from "../../../components/partners/GrunddataPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import type { RegisterEntry } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";

// Kvalitetsorsaker — the same register as Grunddata → Kvalitetsorsaker,
// opened from the Kvalitet menu. Both use the one RegisterTab.
export default async function QualityReasonsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const reasons = await apiGet<RegisterEntry[]>("/api/v1/deviation-reasons", cookieHeader);

  return (
    <AppShell active="Kvalitet">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kvalitetsorsaker</div>
          <div className={shellStyles.meta}>Orsakerna som avvikelser och kassationer väljer ur</div>
        </div>
        <HelpLink chapter="kvalitet" anchor="kvalitetsorsaker" label="Hjälp om kvalitetsorsaker" />
      </div>

      <RegisterTab tab="Kvalitetsorsaker" entries={reasons} />
    </AppShell>
  );
}

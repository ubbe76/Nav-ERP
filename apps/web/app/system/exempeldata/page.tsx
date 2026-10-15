import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import shellStyles from "../../../components/AppShell.module.css";
import { DemoDataSection } from "../../../components/system/DemoDataSection";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet } from "../../../lib/api";
import type { DemoDataStatus } from "../../../lib/types";

export default async function DemoDataPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  // A failing API must not become Next's error page — same as Nummerserier.
  const status = await apiGet<DemoDataStatus>("/api/v1/demo-data", cookieHeader).catch(() => null);
  if (status === null) {
    return (
      <AppShell active="System">
        <p>Kunde inte hämta exempeldatans status. Försök igen om en stund.</p>
      </AppShell>
    );
  }
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Exempeldata</div>
          <div className={shellStyles.meta}>Ett påhittat företag att prova systemet med</div>
        </div>
        <HelpLink chapter="system" anchor="exempeldata" label="Hjälp om exempeldata" />
      </div>
      <DemoDataSection initial={status} />
    </AppShell>
  );
}

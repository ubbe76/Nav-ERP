import { AppShell } from "../../../components/AppShell";
import { ScanPageClient } from "../../../components/stock/ScanPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

export default function ScanPage() {
  return (
    <AppShell active="Lager">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Skanna</div>
          <div className={shellStyles.meta}>Skanna en artikel, en lagerplats eller en order</div>
        </div>
        <HelpLink chapter="lager" anchor="skanna" label="Hjälp om skanning" />
      </div>

      <ScanPageClient />
    </AppShell>
  );
}

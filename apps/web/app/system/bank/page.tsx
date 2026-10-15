import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BankSettingsForm } from "../../../components/banking/BankSettingsForm";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";
import { apiGet } from "../../../lib/api";
import type { BankSettingsView } from "../../../lib/types";

export default async function BankSettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const settings = await apiGet<BankSettingsView>("/api/v1/bank-settings", cookieHeader);
  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Bank</div>
          <div className={shellStyles.meta}>Betalfiler (pain.001) och bankavier (camt.054)</div>
        </div>
        <HelpLink chapter="system" anchor="bank" label="Hjälp om bankinställningar" />
      </div>
      <BankSettingsForm initial={settings} />
    </AppShell>
  );
}

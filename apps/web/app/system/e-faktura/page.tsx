import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { EInvoiceSettingsForm } from "../../../components/einvoice/EInvoiceSettingsForm";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";
import { apiGet } from "../../../lib/api";
import type { EInvoiceSettings } from "../../../lib/einvoice";

export default async function EInvoiceSettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const settings = await apiGet<EInvoiceSettings>("/api/v1/einvoice-settings", cookieHeader).catch(() => null);
  if (settings === null) {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="System">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>E-faktura</div>
          <div className={shellStyles.meta}>Fakturor via Peppol och B2Brouter</div>
        </div>
        <HelpLink chapter="system" anchor="e-faktura" label="Hjälp om e-faktura" />
      </div>
      <EInvoiceSettingsForm initial={settings} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { InvoiceScanSettingsForm } from "../../../components/system/InvoiceScanSettingsForm";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";
import { apiGet } from "../../../lib/api";
import type { InvoiceScanSettings } from "../../../lib/invoiceScan";

export default async function InvoiceScanSettingsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const settings = await apiGet<InvoiceScanSettings>("/api/v1/settings/invoice-scan", cookieHeader).catch(() => null);
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
          <div className={shellStyles.title}>Fakturaskanning</div>
          <div className={shellStyles.meta}>Tolkning av inkomna leverantörsfakturor till Fakturainkorgen</div>
        </div>
        <HelpLink chapter="system" anchor="fakturaskanning" label="Hjälp om fakturaskanning" />
      </div>
      <InvoiceScanSettingsForm initial={settings} />
    </AppShell>
  );
}

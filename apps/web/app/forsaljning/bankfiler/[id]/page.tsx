import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { IncomingBankFileCard } from "../../../../components/banking/IncomingBankFileCard";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet } from "../../../../lib/api";
import type { BankFileDetail, Customer, IncomingEntryView, Paged, SystemSettings } from "../../../../lib/types";

export default async function SalesBankFilePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const file = await apiGet<BankFileDetail>(`/api/v1/bank-files/${id}`, cookieHeader).catch(() => null);
  if (!file) notFound();
  const [entries, customers, settings] = await Promise.all([
    apiGet<IncomingEntryView[]>(`/api/v1/bank-files/${id}/incoming`, cookieHeader),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
    apiGet<SystemSettings>("/api/v1/settings", cookieHeader),
  ]);
  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{file.filename}</div>
          <div className={shellStyles.meta}>Bankfil · inbetalningar</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="matchning" label="Hjälp om inbetalningsfiler" />
      </div>
      <IncomingBankFileCard file={file} entries={entries} customers={customers.rows} tolerance={settings.paymentTolerance} />
    </AppShell>
  );
}

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { OutgoingBankFileCard } from "../../../../components/banking/OutgoingBankFileCard";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet } from "../../../../lib/api";
import type { BankFileDetail, OutgoingEntryView } from "../../../../lib/types";

export default async function PurchaseBankFilePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const file = await apiGet<BankFileDetail>(`/api/v1/bank-files/${id}`, cookieHeader).catch(() => null);
  if (!file) notFound();
  const entries = await apiGet<OutgoingEntryView[]>(`/api/v1/bank-files/${id}/outgoing`, cookieHeader);
  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{file.filename}</div>
          <div className={shellStyles.meta}>Bankfil · debiteringar och returer</div>
        </div>
        <HelpLink chapter="inkop" anchor="bekrafta-betalningar" label="Hjälp om bankfiler" />
      </div>
      <OutgoingBankFileCard file={file} entries={entries} />
    </AppShell>
  );
}

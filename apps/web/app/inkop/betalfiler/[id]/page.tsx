import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { PaymentBatchCard } from "../../../../components/banking/PaymentBatchCard";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet } from "../../../../lib/api";
import type { BankSettingsView, PaymentBatchDetail } from "../../../../lib/types";

export default async function PaymentBatchPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const batch = await apiGet<PaymentBatchDetail>(`/api/v1/payment-batches/${id}`, cookieHeader).catch(() => null);
  if (!batch) notFound();
  const bank = await apiGet<BankSettingsView>("/api/v1/bank-settings", cookieHeader).catch(() => null);
  const profile = bank?.profiles.find((p) => p.id === (batch.bankProfile ?? bank.profile)) ?? null;
  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Betalfil {batch.batchNumber}</div>
          <div className={shellStyles.meta}>{profile ? `${profile.name} · betalkonto ${batch.bankAccountNumber}` : `Betalkonto ${batch.bankAccountNumber}`}</div>
        </div>
        <HelpLink chapter="inkop" anchor={batch.status === "draft" ? "skapa-betalfil" : "bekrafta-betalningar"} label="Hjälp om betalfiler" />
      </div>
      <PaymentBatchCard batch={batch} unverifiedBank={profile !== null && !profile.verified} />
    </AppShell>
  );
}

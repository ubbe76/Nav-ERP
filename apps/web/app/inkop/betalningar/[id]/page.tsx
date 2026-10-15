import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { SupplierPaymentCard } from "../../../../components/purchase/SupplierPaymentCard";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { canOpen } from "../../../../lib/pageAccess";
import type { SupplierPaymentDetail } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function SupplierPaymentDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const [payment, user] = await Promise.all([
    apiGet<SupplierPaymentDetail>(`/api/v1/supplier-payments/${params.id}`, cookieHeader).catch(() => null),
    getCurrentUser(cookieHeader),
  ]);
  if (!payment) notFound();

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{payment.paymentNumber}</div>
          <div className={shellStyles.meta}>Betalning · {payment.supplierName}</div>
        </div>
        <HelpLink chapter="inkop" anchor="makulera-betalning" label="Hjälp om betalningar" />
      </div>

      <SupplierPaymentCard payment={payment} canOpenVerifications={user ? canOpen(user, "/ekonomi/verifikat") : false} />
    </AppShell>
  );
}

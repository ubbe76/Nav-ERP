import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { PaymentCard } from "../../../../components/sales/PaymentCard";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { canOpen } from "../../../../lib/pageAccess";
import type { PaymentDetail } from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function PaymentDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const [payment, user] = await Promise.all([
    apiGet<PaymentDetail>(`/api/v1/payments/${params.id}`, cookieHeader).catch(() => null),
    getCurrentUser(cookieHeader),
  ]);
  if (!payment) notFound();

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{payment.paymentNumber}</div>
          <div className={shellStyles.meta}>Betalning · {payment.customerName}</div>
        </div>
        <HelpLink chapter="forsaljning" anchor="makulera-betalning" label="Hjälp om betalningar" />
      </div>

      <PaymentCard payment={payment} canOpenVerifications={user ? canOpen(user, "/ekonomi/verifikat") : false} />
    </AppShell>
  );
}

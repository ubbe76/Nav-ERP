import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { OrderRegisterPageClient } from "../../../components/reports/OrderRegisterPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getCurrentUser } from "../../../lib/api";
import type { PageSearchParams } from "../../../lib/listQuery";
import shellStyles from "../../../components/AppShell.module.css";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function OrderforteckningKundorderPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/rapporter/orderforteckning-kundorder")) {
    return (
      <AppShell active="Rapporter">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  return (
    <AppShell active="Rapporter">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Orderförteckning kundorder</div>
          <div className={shellStyles.meta}>Kundordrar med ordervärde och restvärde, per order eller med rader</div>
        </div>
        <HelpLink chapter="rapporter" anchor="orderforteckning" label="Hjälp om orderförteckningen" />
      </div>

      <OrderRegisterPageClient
        kind="sales"
        defaults={{
          dateBasis: singleParam(searchParams.dateBasis),
          from: singleParam(searchParams.from),
          to: singleParam(searchParams.to),
          partnerId: singleParam(searchParams.partnerId),
          status: singleParam(searchParams.status),
          openOnly: singleParam(searchParams.openOnly),
          articleId: singleParam(searchParams.articleId),
          articleGroupId: singleParam(searchParams.articleGroupId),
          articleCodeId: singleParam(searchParams.articleCodeId),
          withRows: singleParam(searchParams.withRows),
        }}
      />
    </AppShell>
  );
}

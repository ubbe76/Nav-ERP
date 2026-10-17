import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { PartnerTabs } from "../../../components/partners/PartnerTabs";
import { NewQuoteFromCustomerButton } from "../../../components/sales/NewQuoteFromCustomerButton";
import { apiGet } from "../../../lib/api";
import type {
  ArticleGroup,
  Customer,
  CustomerDeliveryAddress,
  CustomerPrice,
  Paged,
  PartnerContact,
  PriceList,
  RegisterEntry,
  SystemSettings,
} from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

// Kundkort — tabbed customer view (Allmänt / Villkor & frakt), same pattern
// as the article and employee cards.
export default async function CustomerDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const customer = await apiGet<Customer>(`/api/v1/customers/${params.id}`, cookieHeader).catch(() => null);
  if (!customer) notFound();

  const [deliveryTerms, paymentTerms, carriers, contacts, deliveryAddresses, priceLists, customerPrices, articleGroups, settings] =
    await Promise.all([
      apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
      apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
      apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
      apiGet<PartnerContact[]>(`/api/v1/customers/${params.id}/contacts`, cookieHeader),
      apiGet<CustomerDeliveryAddress[]>(`/api/v1/customers/${params.id}/delivery-addresses`, cookieHeader),
      apiGet<Paged<PriceList>>("/api/v1/price-lists?limit=1000", cookieHeader),
      apiGet<CustomerPrice[]>(`/api/v1/customers/${params.id}/prices`, cookieHeader),
      apiGet<ArticleGroup[]>("/api/v1/article-groups", cookieHeader),
      // Only names the delivery-day defaults on Villkor & frakt — the card
      // works without them.
      apiGet<SystemSettings>("/api/v1/settings", cookieHeader).catch(() => null),
    ]);

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{customer.name}</div>
          <div className={shellStyles.meta}>Kund</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <NewQuoteFromCustomerButton customer={customer} />
          <HelpLink chapter="forsaljning" anchor="kunder" label="Hjälp om kunder" />
        </div>
      </div>

      <PartnerTabs
        partner={customer}
        endpointBase="/api/v1/customers"
        kind="customer"
        registers={{ deliveryTerms, paymentTerms, carriers }}
        contacts={contacts}
        deliveryAddresses={deliveryAddresses}
        priceLists={priceLists.rows}
        customerPrices={customerPrices}
        articleGroups={articleGroups}
        deliveryDayDefaults={
          settings ? { mode: settings.customerDeliveryDayMode, transitDays: settings.customerTransitDays } : null
        }
      />
    </AppShell>
  );
}

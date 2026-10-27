import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { PartnerTabs } from "../../../components/partners/PartnerTabs";
import { NewQuoteFromCustomerButton } from "../../../components/sales/NewQuoteFromCustomerButton";
import { apiGet } from "../../../lib/api";
import type {
  ArticleGroup,
  Customer,
  CustomerArticleNumber,
  CustomerDeliveryAddress,
  CustomerPrice,
  Paged,
  PartnerContact,
  PriceList,
  RegisterEntry,
  SystemSettings,
} from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { DeviationsSection } from "../../../components/quality/DeviationsSection";
import { HelpLink } from "../../../components/ui/HelpLink";

// Kundkort — tabbed customer view (Allmänt / Villkor & frakt), same pattern
// as the article and employee cards.
export default async function CustomerDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const customer = await apiGet<Customer>(`/api/v1/customers/${params.id}`, cookieHeader).catch(() => null);
  if (!customer) notFound();

  const [deliveryTerms, paymentTerms, carriers, contacts, deliveryAddresses, priceLists, customerPrices, customerArticleNumbers, articleGroups, settings] =
    await Promise.all([
      apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
      apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
      apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
      apiGet<PartnerContact[]>(`/api/v1/customers/${params.id}/contacts`, cookieHeader),
      apiGet<CustomerDeliveryAddress[]>(`/api/v1/customers/${params.id}/delivery-addresses`, cookieHeader),
      apiGet<Paged<PriceList>>("/api/v1/price-lists?limit=1000", cookieHeader),
      apiGet<CustomerPrice[]>(`/api/v1/customers/${params.id}/prices`, cookieHeader),
      apiGet<CustomerArticleNumber[]>(`/api/v1/customers/${params.id}/article-numbers`, cookieHeader),
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
        showCurrency
        registers={{ deliveryTerms, paymentTerms, carriers }}
        contacts={contacts}
        deliveryAddresses={deliveryAddresses}
        priceLists={priceLists.rows}
        customerPrices={customerPrices}
        customerArticleNumbers={customerArticleNumbers}
        articleGroups={articleGroups}
        deliveryDayDefaults={
          settings ? { mode: settings.customerDeliveryDayMode, transitDays: settings.customerTransitDays } : null
        }
      />

      <DeviationsSection
        filter={{ customerId: customer.id }}
        newDeviation={{ type: "customer", customerId: customer.id }}
        buttonLabel="Ny reklamation"
      />
    </AppShell>
  );
}

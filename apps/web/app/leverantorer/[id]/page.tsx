import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { PartnerTabs } from "../../../components/partners/PartnerTabs";
import { NewOrderFromSupplierButton } from "../../../components/purchase/NewOrderFromSupplierButton";
import { apiGet } from "../../../lib/api";
import type { PartnerContact, RegisterEntry, Supplier, SupplierDeliveryAddress } from "../../../lib/types";
import shellStyles from "../../../components/AppShell.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";

// Leverantörskort — tabbed supplier view (Allmänt / Villkor & frakt), same
// pattern as the customer card.
export default async function SupplierDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const supplier = await apiGet<Supplier>(`/api/v1/suppliers/${params.id}`, cookieHeader).catch(() => null);
  if (!supplier) notFound();

  const [deliveryTerms, paymentTerms, carriers, contacts, deliveryAddresses] = await Promise.all([
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
    apiGet<PartnerContact[]>(`/api/v1/suppliers/${params.id}/contacts`, cookieHeader),
    apiGet<SupplierDeliveryAddress[]>(`/api/v1/suppliers/${params.id}/delivery-addresses`, cookieHeader),
  ]);

  return (
    <AppShell active="Inköp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{supplier.name}</div>
          <div className={shellStyles.meta}>Leverantör</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <NewOrderFromSupplierButton supplier={supplier} />
          <HelpLink chapter="inkop" anchor="leverantorer" label="Hjälp om leverantörer" />
        </div>
      </div>

      <PartnerTabs
        partner={supplier}
        endpointBase="/api/v1/suppliers"
        kind="supplier"
        showCurrency
        registers={{ deliveryTerms, paymentTerms, carriers }}
        contacts={contacts}
        deliveryAddresses={deliveryAddresses}
      />
    </AppShell>
  );
}

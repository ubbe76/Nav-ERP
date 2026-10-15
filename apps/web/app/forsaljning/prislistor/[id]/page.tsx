import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { PriceListDetail } from "../../../../components/sales/PriceListDetail";
import { apiGet } from "../../../../lib/api";
import type { PriceListWithRows } from "../../../../lib/types";

// Prislistekort — köns/rader redigerbara direkt på kortet, ingen flikstruktur
// (bara ett register-objekt, till skillnad från kund-/leverantörskortets tre
// villkorsflikar).
export default async function PriceListDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const priceList = await apiGet<PriceListWithRows>(`/api/v1/price-lists/${params.id}`, cookieHeader).catch(
    () => null
  );
  if (!priceList) notFound();

  return (
    <AppShell active="Försäljning">
      <PriceListDetail priceList={priceList} />
    </AppShell>
  );
}

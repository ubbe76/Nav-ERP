import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { GrunddataPageClient } from "../../components/partners/GrunddataPageClient";
import { apiGet } from "../../lib/api";
import type { RegisterEntry } from "../../lib/types";

// Grunddata — shared base-data registers used by both customers and
// suppliers: leveransvillkor, betalningsvillkor, speditörer, enheter, kollityper,
// förlustorsaker and kvalitetsorsaker.
export default async function GrunddataPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [deliveryTerms, paymentTerms, carriers, units, packageTypes, lossReasons, deviationReasons] = await Promise.all([
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/units", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/package-types", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/quote-loss-reasons", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/deviation-reasons", cookieHeader),
  ]);

  return (
    <AppShell active="Försäljning">
      <GrunddataPageClient
        deliveryTerms={deliveryTerms}
        paymentTerms={paymentTerms}
        carriers={carriers}
        units={units}
        packageTypes={packageTypes}
        lossReasons={lossReasons}
        deviationReasons={deviationReasons}
      />
    </AppShell>
  );
}

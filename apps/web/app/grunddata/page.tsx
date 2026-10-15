import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { GrunddataPageClient } from "../../components/partners/GrunddataPageClient";
import { apiGet } from "../../lib/api";
import type { RegisterEntry } from "../../lib/types";

// Grunddata — shared base-data registers used by both customers and
// suppliers: leveransvillkor, betalningsvillkor, speditörer and enheter.
export default async function GrunddataPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [deliveryTerms, paymentTerms, carriers, units, packageTypes] = await Promise.all([
    apiGet<RegisterEntry[]>("/api/v1/delivery-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/payment-terms", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/units", cookieHeader),
    apiGet<RegisterEntry[]>("/api/v1/package-types", cookieHeader),
  ]);

  return (
    <AppShell active="Försäljning">
      <GrunddataPageClient
        deliveryTerms={deliveryTerms}
        paymentTerms={paymentTerms}
        carriers={carriers}
        units={units}
        packageTypes={packageTypes}
      />
    </AppShell>
  );
}

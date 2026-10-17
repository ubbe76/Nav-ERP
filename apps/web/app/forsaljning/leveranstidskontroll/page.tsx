import { AppShell } from "../../../components/AppShell";
import { DeliveryTimeCheckPageClient } from "../../../components/sales/DeliveryTimeCheckPageClient";

export default function LeveranstidskontrollPage() {
  return (
    <AppShell active="Försäljning">
      <DeliveryTimeCheckPageClient />
    </AppShell>
  );
}

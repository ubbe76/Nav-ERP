import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { ShipmentCard } from "../../../../components/shipping/ShipmentCard";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { ShipmentDetail } from "../../../../lib/types";

export default async function ShipmentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [shipment, user] = await Promise.all([
    apiGet<ShipmentDetail>(`/api/v1/shipments/${id}`, cookieHeader).catch(() => null),
    getCurrentUser(cookieHeader),
  ]);
  if (!shipment) notFound();

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Försändelse {shipment.shipmentNumber}</div>
          <div className={shellStyles.meta}>
            {shipment.customerName} · upphämtning {shipment.pickupDate} {shipment.pickupFrom}–{shipment.pickupTo}
          </div>
        </div>
        <HelpLink chapter="forsaljning" anchor="frakt" label="Hjälp om frakt" />
      </div>
      <ShipmentCard key={shipment.id} initial={shipment} />
      {user?.role === "admin" && <AuditTrailSection entityType="shipment" entityId={shipment.id} />}
    </AppShell>
  );
}

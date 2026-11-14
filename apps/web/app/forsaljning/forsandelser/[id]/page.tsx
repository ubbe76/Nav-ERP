import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { ShipmentCard } from "../../../../components/shipping/ShipmentCard";
import { ManualShipmentCard } from "../../../../components/shipping/ManualShipmentCard";
import { AuditTrailSection } from "../../../../components/system/AuditTrailSection";
import { HelpLink } from "../../../../components/ui/HelpLink";
import shellStyles from "../../../../components/AppShell.module.css";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { formatStockholmDate } from "../../../../lib/date";
import type { RegisterEntry, ShipmentDetail } from "../../../../lib/types";

export default async function ShipmentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const [shipment, user] = await Promise.all([
    apiGet<ShipmentDetail>(`/api/v1/shipments/${id}`, cookieHeader).catch(() => null),
    getCurrentUser(cookieHeader),
  ]);
  if (!shipment) notFound();
  // Eget fraktsätt: its card picks among the Speditörer.
  const manual = shipment.provider === "manual";
  const carriers = manual ? await apiGet<RegisterEntry[]>("/api/v1/carriers", cookieHeader).catch(() => []) : [];

  return (
    <AppShell active="Försäljning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Försändelse {shipment.shipmentNumber}</div>
          <div className={shellStyles.meta}>
            {manual
              ? `${shipment.customerName} · ${shipment.carrier?.name ?? "eget fraktsätt"} · skickad ${formatStockholmDate(shipment.pickupDate)}`
              : `${shipment.customerName} · upphämtning ${shipment.pickupDate} ${shipment.pickupFrom}–${shipment.pickupTo}`}
          </div>
        </div>
        <HelpLink chapter="forsaljning" anchor="frakt" label="Hjälp om frakt" />
      </div>
      {manual ? (
        <ManualShipmentCard key={shipment.id} initial={shipment} carriers={carriers} />
      ) : (
        <ShipmentCard key={shipment.id} initial={shipment} />
      )}
      {user?.role === "admin" && <AuditTrailSection entityType="shipment" entityId={shipment.id} />}
    </AppShell>
  );
}

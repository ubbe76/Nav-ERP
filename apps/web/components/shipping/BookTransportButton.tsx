"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { shippingErrorText, SHIPMENT_STATUS_LABELS } from "../../lib/shipping";
import type { DeliveryShipmentInfo, ShipmentDetail } from "../../lib/types";

// "Boka transport" for one följesedel, or the link to its live shipment.
// Hidden when frakten is not enabled or the user lacks Försäljning.
export function BookTransportButton({
  deliveryId,
  shipment,
  enabled,
}: {
  deliveryId: string;
  shipment: DeliveryShipmentInfo | null;
  enabled: boolean;
}) {
  const router = useRouter();
  const can = useCan();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (shipment) {
    return (
      <Link href={`/forsaljning/forsandelser/${shipment.shipmentId}`}>
        {shipment.shipmentNumber}
        {shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ` · ${SHIPMENT_STATUS_LABELS[shipment.status]}`}
      </Link>
    );
  }
  if (!enabled || !can(["forsaljning"])) return null;

  async function book() {
    setPending(true);
    setError(null);
    try {
      const { shipment: created } = await apiFetch<{ shipment: ShipmentDetail; warnings: string[] }>(
        "/api/v1/shipments",
        {
          method: "POST",
          body: JSON.stringify({ deliveryIds: [deliveryId] }),
        }
      );
      router.push(`/forsaljning/forsandelser/${created.id}`);
    } catch (err) {
      setError(shippingErrorText(err, "Kunde inte skapa försändelsen"));
      setPending(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <Button type="button" variant="secondary" size="small" disabled={pending} onClick={book}>
        {pending ? "Skapar…" : "Boka transport"}
      </Button>
      {error && <span style={{ color: "var(--status-stopped-text)", fontSize: 13 }}>{error}</span>}
    </span>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { openDocument } from "../../lib/tabNavigation";
import { shippingErrorText, shipmentStatusLabel } from "../../lib/shipping";
import type { DeliveryShipmentInfo, RegisterEntry, ShipmentDetail } from "../../lib/types";
import { ManualShipmentForm, type ManualShipmentPayload } from "./ManualShipmentForm";

// "Boka transport" (Sendify) and "Eget fraktsätt" for one följesedel, or the
// link to its live shipment. Boka transport only when frakten is enabled;
// Eget fraktsätt always (Egen bil, Kunden hämtar, an own agreement). Both
// need Försäljning.
export function BookTransportButton({
  deliveryId,
  shipment,
  enabled,
  carriers,
  defaultCarrierId = null,
}: {
  deliveryId: string;
  shipment: DeliveryShipmentInfo | null;
  enabled: boolean;
  // The Speditörer register (fetched when Eget fraktsätt opens if not
  // given) and the order's (else the customer's) Speditör.
  carriers?: RegisterEntry[];
  defaultCarrierId?: string | null;
}) {
  const router = useRouter();
  const can = useCan();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [carrierList, setCarrierList] = useState<RegisterEntry[] | null>(carriers ?? null);
  // The shipment this button created: a second click would be refused (the
  // delivery is on a shipment), so the link replaces the button at once — also
  // when the shipment opened in a new tab and this page stays.
  const [created, setCreated] = useState<{ id: string; number: string } | null>(null);

  if (!shipment && created) {
    return <Link href={`/forsaljning/forsandelser/${created.id}`}>{created.number}</Link>;
  }
  if (shipment) {
    return (
      <Link href={`/forsaljning/forsandelser/${shipment.shipmentId}`}>
        {shipment.shipmentNumber}
        {shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ` · ${shipmentStatusLabel(shipment.status, shipment.provider)}`}
      </Link>
    );
  }
  if (!can(["forsaljning"])) return null;

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
      setCreated({ id: created.id, number: created.shipmentNumber });
      if (openDocument(`/forsaljning/forsandelser/${created.id}`, (href) => router.push(href), "Försändelse")) {
        setPending(false);
        router.refresh();
      }
    } catch (err) {
      setError(shippingErrorText(err, "Kunde inte skapa försändelsen"));
      setPending(false);
    }
  }

  // Eget fraktsätt: registered at once; the card stays (the row shows the
  // new FR number).
  async function registerManual(payload: ManualShipmentPayload) {
    setPending(true);
    setManualError(null);
    try {
      const { shipment: created } = await apiFetch<{ shipment: ShipmentDetail; warnings: string[] }>(
        "/api/v1/shipments/manual",
        { method: "POST", body: JSON.stringify({ deliveryIds: [deliveryId], ...payload }) }
      );
      setCreated({ id: created.id, number: created.shipmentNumber });
      setManualOpen(false);
      router.refresh();
    } catch (err) {
      setManualError(shippingErrorText(err, "Kunde inte registrera frakten"));
    } finally {
      setPending(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {enabled && (
        <Button type="button" variant="secondary" size="small" disabled={pending} onClick={book}>
          {pending && !manualOpen ? "Skapar…" : "Boka transport"}
        </Button>
      )}
      <Button
        type="button"
        variant={enabled ? "ghost" : "secondary"}
        size="small"
        disabled={pending}
        onClick={() => {
          setManualError(null);
          setManualOpen(true);
          if (!carrierList) {
            apiFetch<RegisterEntry[]>("/api/v1/carriers")
              .then(setCarrierList)
              .catch((err) => setManualError(shippingErrorText(err, "Kunde inte hämta speditörerna")));
          }
        }}
      >
        Eget fraktsätt
      </Button>
      {error && <span style={{ color: "var(--status-stopped-text)", fontSize: 13 }}>{error}</span>}
      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="Eget fraktsätt">
        <ManualShipmentForm
          carriers={carrierList ?? []}
          initial={{ carrierId: defaultCarrierId, trackingNumber: null, customerPrice: null, shippedDate: null }}
          submitLabel="Registrera"
          pending={pending}
          error={manualError}
          onSubmit={registerManual}
          onCancel={() => setManualOpen(false)}
        />
      </Modal>
    </span>
  );
}

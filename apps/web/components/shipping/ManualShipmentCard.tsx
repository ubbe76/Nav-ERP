"use client";

import { useState } from "react";
import Link from "next/link";
import { useCan } from "../PermissionsProvider";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormError, FormHint } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { formatDate, formatDateTime, formatSek, SHIPMENT_STATUS_PILL, shipmentStatusLabel, shippingErrorText } from "../../lib/shipping";
import type { RegisterEntry, ShipmentDetail } from "../../lib/types";
import { ManualShipmentForm, type ManualShipmentPayload } from "./ManualShipmentForm";
import { Facts, postalLine } from "./ShipmentCard";
import styles from "./ShipmentCard.module.css";

// Försändelse med eget fraktsätt (Egen bil, Kunden hämtar, an own agreement):
// registered as Skickad, never booked anywhere. Ändra (Speditör,
// fraktsedelsnummer, kundpris, Skickad) while it is on no invoice,
// Markera levererad, Makulera.
export function ManualShipmentCard({ initial, carriers }: { initial: ShipmentDetail; carriers: RegisterEntry[] }) {
  const [s, setS] = useState(initial);
  const canSell = useCan()(["forsaljning"]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const open = s.status === "booked" || s.status === "delivered";
  const editable = canSell && open && s.invoice === null;

  async function run(path: string, fallback: string, init: RequestInit = { method: "POST" }) {
    setPending(true);
    setError(null);
    try {
      setS(await apiFetch<ShipmentDetail>(`/api/v1/shipments/${s.id}${path}`, init));
      return true;
    } catch (err) {
      setError(shippingErrorText(err, fallback));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function save(payload: ManualShipmentPayload) {
    setPending(true);
    setEditError(null);
    try {
      setS(
        await apiFetch<ShipmentDetail>(`/api/v1/shipments/${s.id}/manual`, { method: "PATCH", body: JSON.stringify(payload) })
      );
      setEditOpen(false);
    } catch (err) {
      setEditError(shippingErrorText(err, "Kunde inte spara ändringen"));
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    if (!(await confirmDialog(`Makulera försändelse ${s.shipmentNumber}?`, { confirmLabel: "Makulera", danger: true }))) return;
    await run("/cancel", "Kunde inte makulera försändelsen");
  }

  return (
    <>
      <div className={styles.toolbar}>
        <StatusPill status={SHIPMENT_STATUS_PILL[s.status]} label={shipmentStatusLabel(s.status, s.provider)} />
        <GatedLink href={`/kunder/${s.customerId}`}>{s.customerName}</GatedLink>
        <span className={styles.toolbarSpacer} />
        {editable && (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => setEditOpen(true)}>
            Ändra
          </Button>
        )}
        {canSell && s.status === "booked" && (
          <>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => run("/delivered", "Kunde inte markera försändelsen")}>
              Markera levererad
            </Button>
            <Button type="button" variant="danger" disabled={pending} onClick={cancel}>
              Makulera
            </Button>
          </>
        )}
      </div>
      <div className={styles.messages}>
        <FormError>{error}</FormError>
        {open && s.invoice !== null && (
          <FormHint>Försändelsen ligger på en faktura och kan inte ändras.</FormHint>
        )}
        {s.status === "cancelled" && <FormHint>Makulerad {s.cancelledAt ? formatDateTime(s.cancelledAt) : ""}.</FormHint>}
      </div>

      <div className={styles.layout}>
        <div className={styles.column}>
          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Frakt</SectionHeading>
            <Facts
              rows={[
                { label: "Fraktsätt", value: "Eget fraktsätt" },
                { label: "Speditör", value: s.carrier?.name ?? "–" },
                { label: "Fraktsedelsnr", value: s.trackingNumber ?? "–" },
                { label: "Skickad", value: formatDate(s.pickupDate) },
                { label: "Levererad", value: s.tracking.deliveredAt ? formatDateTime(s.tracking.deliveredAt) : null },
                { label: "Kundpris", value: s.customerPrice === null ? "Ingen frakt att fakturera" : formatSek(s.customerPrice) },
                {
                  label: "Faktura",
                  value:
                    s.customerPrice === null ? null : s.invoice ? (
                      <GatedLink href={`/forsaljning/fakturor/${s.invoice.invoiceId}`}>{s.invoice.invoiceNumber ?? "Utkast"}</GatedLink>
                    ) : (
                      "Ej fakturerad"
                    ),
                },
              ]}
            />
          </Card>
        </div>

        <div className={styles.column}>
          <Card maxWidth="none" className={styles.panel}>
            <SectionHeading>Följesedlar</SectionHeading>
            <ul className={styles.deliveries}>
              {s.deliveries
                .filter((d) => d.active || s.status === "cancelled")
                .map((d) => (
                  <li key={d.id} className={styles.delivery}>
                    <a href={`/api/v1/deliveries/${d.id}/pdf`} target="_blank" rel="noopener noreferrer">
                      {d.deliveryNumber}
                    </a>
                    <span className={styles.muted}>·</span>
                    <GatedLink href={`/forsaljning/ordrar/${d.orderId}`}>{d.orderNumber}</GatedLink>
                  </li>
                ))}
            </ul>

            <SectionHeading spaced>Mottagare</SectionHeading>
            <Facts
              rows={[
                { label: "Namn", value: s.recipientName },
                {
                  label: "Adress",
                  value: (
                    <span className={styles.address}>
                      {[s.recipientAddressLine1, s.recipientAddressLine2, postalLine(s.recipientPostalCode, s.recipientCity), s.recipientCountry]
                        .filter(Boolean)
                        .join("\n")}
                    </span>
                  ),
                },
                { label: "Kontakt", value: s.recipientContactName },
                { label: "Telefon", value: s.recipientPhone },
              ]}
            />
          </Card>
        </div>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Ändra ${s.shipmentNumber}`}>
        <ManualShipmentForm
          carriers={carriers}
          initial={{
            carrierId: s.carrier?.id ?? null,
            trackingNumber: s.trackingNumber,
            customerPrice: s.customerPrice,
            shippedDate: s.pickupDate,
          }}
          submitLabel="Spara"
          pending={pending}
          error={editError}
          onSubmit={save}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>

      <p className={styles.back}>
        <Link href="/forsaljning/forsandelser">← Alla försändelser</Link>
      </p>
    </>
  );
}

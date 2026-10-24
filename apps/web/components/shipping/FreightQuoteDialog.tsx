"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { FormError, FormHint } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { ParcelsTable, newParcelDraft, toParcelPayload, type ParcelDraft } from "./ParcelsTable";
import { RatesTable } from "./RatesDialog";
import { apiFetch } from "../../lib/api";
import { shippingErrorText } from "../../lib/shipping";
import { formatRate } from "../../lib/currency";
import type { ShipmentParcel, ShipmentRates } from "../../lib/types";

// Fraktpris för en offert/kundorder: kolliförslaget från raderna (justerbart),
// Sendifys priser och "Lägg till frakt" — fraktraden läggs till eller får nytt pris.
export function FreightQuoteDialog({
  orderId,
  currency = "SEK",
  exchangeRate,
  open,
  onClose,
  onAdded,
}: {
  orderId: string;
  // Valuta: the order's currency and rate — the freight prices are SEK, the
  // freight row is added to the order converted with its rate.
  currency?: string;
  exchangeRate?: string;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [parcels, setParcels] = useState<ParcelDraft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [rates, setRates] = useState<ShipmentRates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The parcel suggestion is in flight: Hämta priser waits for it.
  const [loading, setLoading] = useState(false);
  // Request sequence for the two POSTs: bumped before each one and on every
  // open/close, so a response that lands after the dialog was closed (or
  // reopened for new parcels) is ignored instead of showing stale prices.
  const requestSeq = useRef(0);

  // Every (re)open starts clean and fetches a fresh suggestion; a response
  // that arrives after the dialog was closed or reopened is dropped.
  useEffect(() => {
    requestSeq.current++;
    if (!open) return;
    let active = true;
    setParcels([]);
    setWarnings([]);
    setRates(null);
    setError(null);
    setPending(false);
    setLoading(true);
    apiFetch<{ parcels: Omit<ShipmentParcel, "id" | "position">[]; warnings: string[] }>(`/api/v1/sales-orders/${orderId}/freight-parcels`)
      .then((r) => {
        if (!active) return;
        setParcels(
          r.parcels.map((p) => ({
            ...newParcelDraft(),
            parcelKind: p.parcelKind,
            lengthCm: String(p.lengthCm),
            widthCm: String(p.widthCm),
            heightCm: String(p.heightCm),
            weightKg: String(p.weightKg),
            quantity: String(p.quantity),
            stackable: p.stackable,
            loadingMeters: p.loadingMeters === null ? "" : String(p.loadingMeters),
            description: p.description ?? "",
          }))
        );
        setWarnings(r.warnings);
      })
      .catch((err) => {
        if (active) setError(shippingErrorText(err, "Kunde inte föreslå kollin"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, orderId]);

  async function fetchRates() {
    const seq = ++requestSeq.current;
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<ShipmentRates>(`/api/v1/sales-orders/${orderId}/freight-rates`, {
        method: "POST",
        body: JSON.stringify({ parcels: parcels.map(toParcelPayload) }),
      });
      if (seq !== requestSeq.current) return;
      setRates(result);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(shippingErrorText(err, "Kunde inte hämta priser"));
    } finally {
      if (seq === requestSeq.current) setPending(false);
    }
  }

  async function addFreight(rateId: string) {
    const seq = ++requestSeq.current;
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/sales-orders/${orderId}/freight`, { method: "POST", body: JSON.stringify({ rateId }) });
      // The row IS on the order now, so the card reloads even when the
      // dialog was closed meanwhile — only the dialog's own state is stale.
      onAdded();
      if (seq !== requestSeq.current) return;
      onClose();
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(shippingErrorText(err, "Kunde inte lägga till frakten"));
    } finally {
      if (seq === requestSeq.current) setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Fraktpris" wide>
      <FormError>{error}</FormError>
      {warnings.length > 0 && <FormHint>{warnings.join(" · ")}</FormHint>}
      {currency !== "SEK" && (
        <FormHint>
          Fraktpriserna är i SEK. Fraktraden läggs på ordern omräknad till {currency}
          {exchangeRate ? ` med orderns kurs (${formatRate(exchangeRate)})` : ""}.
        </FormHint>
      )}
      <ParcelsTable parcels={parcels} editable disabled={pending || loading} onChange={setParcels} />
      <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
        <Button type="button" variant="ghost" size="small" disabled={pending || loading} onClick={() => setParcels([...parcels, newParcelDraft()])}>
          + Kolli
        </Button>
        <Button type="button" variant="primary" disabled={pending || loading || parcels.length === 0} onClick={fetchRates}>
          {pending ? "Hämtar…" : "Hämta priser"}
        </Button>
      </div>
      {rates && (
        <RatesTable
          rates={rates}
          selectedProductKey={null}
          actions={(r) => (
            <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => addFreight(r.id)}>
              Lägg till frakt
            </Button>
          )}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <Button type="button" variant="ghost" onClick={onClose}>
          Stäng
        </Button>
      </div>
    </Modal>
  );
}

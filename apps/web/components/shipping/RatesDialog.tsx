"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { FormError, FormHint } from "../ui/Form";
import { Table } from "../ui/Table";
import { formatSek } from "../../lib/shipping";
import type { ShipmentRate, ShipmentRates } from "../../lib/types";

// Alla transportörers priser för försändelsen, sorterade på pris (the API
// sorts). Boka / Spara val per rad; Sendify's warnings under the table.
export function RatesDialog({
  open,
  rates,
  selectedProductKey,
  pending,
  message,
  onClose,
  onBook,
  onSave,
}: {
  open: boolean;
  rates: ShipmentRates | null;
  selectedProductKey: string | null; // `${carrierCode}|${productName}` of the saved choice
  pending: boolean;
  message: string | null;
  onClose: () => void;
  onBook: (rateId: string) => void;
  onSave: (rateId: string) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Priser" wide>
      <FormError>{message}</FormError>
      {rates && (
        <>
          <RatesTable
            rates={rates}
            selectedProductKey={selectedProductKey}
            actions={(r) => (
              <span style={{ display: "inline-flex", gap: 6 }}>
                <Button type="button" size="small" variant="primary" disabled={pending} onClick={() => onBook(r.id)}>
                  Boka
                </Button>
                <Button type="button" size="small" variant="secondary" disabled={pending} onClick={() => onSave(r.id)}>
                  Spara val
                </Button>
              </span>
            )}
          />
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <Button type="button" variant="ghost" onClick={onClose}>
          Stäng
        </Button>
      </div>
    </Modal>
  );
}

// Rates table + Sendify's warnings; the last column is whatever `actions` renders
// for SEK rates (other currencies cannot be booked or quoted).
export function RatesTable({
  rates,
  selectedProductKey,
  actions,
}: {
  rates: ShipmentRates;
  selectedProductKey: string | null;
  actions: (rate: ShipmentRate) => ReactNode;
}) {
  const days = (r: ShipmentRate) =>
    r.daysMin === null ? "–" : r.daysMax !== null && r.daysMax !== r.daysMin ? `${r.daysMin}–${r.daysMax}` : String(r.daysMin);
  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <Table<ShipmentRate>
          columns={[
            { key: "carrier", label: "Transportör", width: "1.2fr" },
            { key: "product", label: "Produkt", width: "1.4fr" },
            { key: "price", label: "Pris", width: "100px", align: "right" },
            { key: "customerPrice", label: "Kundpris", width: "100px", align: "right" },
            { key: "days", label: "Ledtid (dagar)", width: "90px", align: "right" },
            { key: "pickup", label: "Upphämtning", width: "110px" },
            { key: "delivery", label: "Beräknad leverans", width: "120px" },
            { key: "actions", label: "", width: "190px", align: "right" },
          ]}
          rows={rates.rates}
          emptyText="Inga priser — se varningarna nedan"
          renderCell={(r, key) => {
            const chosen = selectedProductKey === `${r.carrierCode}|${r.productName}`;
            switch (key) {
              case "carrier":
                return chosen ? <strong>{r.carrierName}</strong> : r.carrierName;
              case "product":
                return chosen ? <strong>{r.productName} (valt)</strong> : r.productName;
              case "price":
                return r.currency === "SEK" ? formatSek(r.price) : `${r.price} ${r.currency}`;
              case "customerPrice":
                return formatSek(r.customerPrice);
              case "days":
                return days(r);
              case "pickup":
                return r.pickupDate ?? "–";
              case "delivery":
                return r.estimatedDeliveryDate ?? "–";
              case "actions":
                return r.currency === "SEK" ? actions(r) : "Bara SEK";
              default:
                return null;
            }
          }}
        />
      </div>
      {rates.warnings.length > 0 && (
        <FormHint>
          {rates.warnings.map((w) => (
            <span key={w} style={{ display: "block" }}>
              {w}
            </span>
          ))}
        </FormHint>
      )}
    </>
  );
}

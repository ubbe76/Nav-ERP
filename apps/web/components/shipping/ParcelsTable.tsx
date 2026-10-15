"use client";

import { Button } from "../ui/Button";
import { Checkbox, Input, Select } from "../ui/Field";
import { Table } from "../ui/Table";
import { PARCEL_KIND_LABELS } from "../../lib/shipping";
import type { ParcelKind } from "../../lib/types";

export type ParcelDraft = {
  key: string;
  parcelKind: ParcelKind;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
  quantity: string;
  stackable: boolean;
  loadingMeters: string;
  description: string;
};

// React key for a parcel added by hand (+ Kolli). A plain counter, not
// crypto.randomUUID: that API is undefined outside a secure context, and the
// LAN address (plain http) is one — the button silently threw on mobile.
let newParcelSeq = 0;
const newParcelKey = () => `new-${++newParcelSeq}`;

export function newParcelDraft(): ParcelDraft {
  return {
    key: newParcelKey(),
    parcelKind: "package",
    lengthCm: "0",
    widthCm: "0",
    heightCm: "0",
    weightKg: "0",
    quantity: "1",
    stackable: false,
    loadingMeters: "",
    description: "",
  };
}

// The PUT/POST body shape for one parcel (empty loadingMeters → null).
export function toParcelPayload(p: ParcelDraft) {
  return {
    parcelKind: p.parcelKind,
    lengthCm: p.lengthCm,
    widthCm: p.widthCm,
    heightCm: p.heightCm,
    weightKg: p.weightKg,
    quantity: p.quantity,
    stackable: p.stackable,
    loadingMeters: p.loadingMeters.trim() === "" ? null : p.loadingMeters,
    description: p.description,
  };
}

// `editable` false renders the rows as plain text (a booked shipment);
// `disabled` keeps the inputs but locks them while a request runs, so the
// table doesn't flip to text for the duration of a save.
export function ParcelsTable({
  parcels,
  editable,
  disabled,
  onChange,
}: {
  parcels: ParcelDraft[];
  editable: boolean;
  disabled?: boolean;
  onChange: (next: ParcelDraft[]) => void;
}) {
  const ro = disabled === true;
  const setParcel = (key: string, change: Partial<ParcelDraft>) => onChange(parcels.map((p) => (p.key === key ? { ...p, ...change } : p)));
  return (
    <div style={{ overflowX: "auto" }}>
      <Table<ParcelDraft & { id: string }>
        columns={[
          { key: "parcelKind", label: "Kolliart", width: "110px" },
          { key: "lengthCm", label: "L (cm)", width: "80px" },
          { key: "widthCm", label: "B (cm)", width: "80px" },
          { key: "heightCm", label: "H (cm)", width: "80px" },
          { key: "weightKg", label: "Vikt (kg)", width: "90px" },
          { key: "quantity", label: "Antal", width: "70px" },
          { key: "stackable", label: "Stapelbar", width: "80px" },
          { key: "loadingMeters", label: "Flakmeter", width: "90px" },
          { key: "description", label: "Beskrivning", width: "1fr" },
          { key: "remove", label: "", width: "60px" },
        ]}
        rows={parcels.map((p) => ({ ...p, id: p.key }))}
        emptyText="Inga kollin"
        renderCell={(p, key) => {
          // Read mode (bokad/levererad/avbruten): plain values instead of a
          // row of locked inputs.
          if (!editable) {
            switch (key) {
              case "parcelKind":
                return PARCEL_KIND_LABELS[p.parcelKind];
              case "lengthCm":
              case "widthCm":
              case "heightCm":
              case "weightKg":
              case "quantity":
                return p[key];
              case "stackable":
                return p.parcelKind === "package" || p.stackable ? "Ja" : "Nej";
              case "loadingMeters":
                return p.loadingMeters.trim() === "" ? "–" : p.loadingMeters;
              case "description":
                return p.description.trim() === "" ? "–" : p.description;
              default:
                return null;
            }
          }
          const numeric = (field: "lengthCm" | "widthCm" | "heightCm" | "weightKg" | "loadingMeters") => (
            <Input type="number" size="xs" min="0" step="any" disabled={ro} value={p[field]} onChange={(e) => setParcel(p.key, { [field]: e.target.value })} />
          );
          switch (key) {
            case "parcelKind":
              return (
                <Select
                  size="sm"
                  disabled={ro}
                  value={p.parcelKind}
                  onChange={(e) => {
                    const kind = e.target.value as ParcelKind;
                    // A Paket is always stackable at Sendify.
                    setParcel(p.key, { parcelKind: kind, ...(kind === "package" ? { stackable: true } : {}) });
                  }}
                >
                  {Object.entries(PARCEL_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              );
            case "lengthCm":
            case "widthCm":
            case "heightCm":
            case "weightKg":
            case "loadingMeters":
              return numeric(key);
            case "quantity":
              return <Input type="number" size="xs" min="0" step="any" disabled={ro} value={p.quantity} onChange={(e) => setParcel(p.key, { quantity: e.target.value })} />;
            case "stackable":
              return <Checkbox disabled={ro || p.parcelKind === "package"} checked={p.parcelKind === "package" || p.stackable} onChange={(e) => setParcel(p.key, { stackable: e.target.checked })} />;
            case "description":
              return <Input disabled={ro} value={p.description} maxLength={100} onChange={(e) => setParcel(p.key, { description: e.target.value })} />;
            case "remove":
              return (
                <Button type="button" size="small" variant="ghost" disabled={ro} onClick={() => onChange(parcels.filter((x) => x.key !== p.key))}>
                  ✕
                </Button>
              );
            default:
              return null;
          }
        }}
      />
    </div>
  );
}

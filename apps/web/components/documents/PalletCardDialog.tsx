"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormActions, FormError } from "../ui/Form";
import { apiFetch } from "../../lib/api";

// Pallkort: one card per kolli, each kolli with its own quantity. "single" =
// one operation or report; "delivery" = a block per delivery row (0 kolli
// skips the row). A summary line warns when the kolli don't add up to the
// total; printing then needs the system setting that allows a mismatch.

interface DeliveryRowsResponse {
  deliveryNumber: string;
  rows: { id: string; articleNumber: string; articleName: string; quantity: number; unit: string }[];
}

export type PalletCardTarget =
  | { kind: "single"; url: string; quantity: number | null; unit?: string }
  | { kind: "delivery"; deliveryId: string };

const MAX_PARCELS = 50;

function num(value: string): number {
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Even split: whole totals round down per kolli with the rest on the last one;
// fractional totals — and whole totals smaller than the kolli count, which
// would otherwise leave empty kolli — split to 4 decimals with the rest on
// the last.
function split(total: number, count: number): string[] {
  if (count < 1) return [];
  if (!(total > 0)) return Array.from({ length: count }, () => "");
  const each = Number.isInteger(total) && total >= count ? Math.floor(total / count) : round4(total / count);
  const parts = Array.from({ length: count }, () => each);
  parts[count - 1] = round4(total - each * (count - 1));
  return parts.map(String);
}

// Resize the list: manual edits survive; only added/removed rows change. Until
// something is typed by hand the whole list is redistributed.
function resize(parcels: string[], count: number, total: number, manual: boolean): string[] {
  if (!manual) return split(total, count);
  if (count <= parcels.length) return parcels.slice(0, count);
  return [...parcels, ...Array.from({ length: count - parcels.length }, () => "")];
}

function fmt(n: number): string {
  return round4(n).toLocaleString("sv-SE");
}

// Whether a mismatching sum may still be printed (system setting, allowed
// by default); a failed fetch keeps the default.
function useAllowMismatch(): boolean {
  const [allow, setAllow] = useState(true);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ allowQuantityMismatch: boolean }>("/api/v1/settings/pallet-card")
      .then((res) => {
        if (!cancelled) setAllow(res.allowQuantityMismatch !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return allow;
}

function matches(total: number, parcels: string[]): boolean {
  return round4(total - parcels.reduce((s, p) => s + num(p), 0)) === 0;
}

function Summary({
  total,
  parcels,
  unit,
  allowMismatch,
}: {
  total: number;
  parcels: string[];
  unit?: string;
  allowMismatch: boolean;
}) {
  const sum = round4(parcels.reduce((s, p) => s + num(p), 0));
  const diff = round4(total - sum);
  const u = unit ? ` ${unit}` : "";
  let tone: "ok" | "short" | "over" = "ok";
  let text = `Kollina stämmer med totalt antal (${fmt(total)}${u})`;
  if (parcels.some((p) => !(num(p) > 0))) {
    // Skriv ut is disabled for an empty kolli — say why.
    tone = "over";
    text = "Varje kolli måste ha ett antal";
  } else if (diff > 0) {
    tone = "short";
    text = `${fmt(diff)}${u} kvar att fördela`;
  } else if (diff < 0) {
    tone = "over";
    text = `${fmt(-diff)}${u} för mycket`;
  }
  if (diff !== 0 && tone !== "ok" && !allowMismatch && parcels.every((p) => num(p) > 0)) text += ". Utskrift kräver att kollina stämmer med totalt antal";
  const colors = {
    ok: ["var(--status-running-bg)", "var(--status-running-text)"],
    short: ["var(--status-delayed-bg)", "var(--status-delayed-text)"],
    over: ["var(--status-stopped-bg)", "var(--status-stopped-text)"],
  }[tone];
  return (
    <div
      role="status"
      style={{ background: colors[0], color: colors[1], padding: "6px 10px", borderRadius: "var(--radius-control-sm)", margin: "8px 0", fontWeight: 600 }}
    >
      {text}
    </div>
  );
}

// Total + kolli count + one field per kolli. Controlled by the parent so the
// parent can read the values when printing.
interface ParcelState {
  total: string;
  count: string;
  parcels: string[];
  manual: boolean;
}

function initialParcels(total: number | null): ParcelState {
  const t = total !== null && total > 0 ? total : 0;
  return { total: t > 0 ? String(t) : "", count: "1", parcels: split(t, 1), manual: false };
}

function ParcelEditor({
  state,
  onChange,
  idPrefix,
  unit,
  allowZeroCount,
  allowMismatch,
}: {
  state: ParcelState;
  onChange: (next: ParcelState) => void;
  idPrefix: string;
  unit?: string;
  allowZeroCount?: boolean;
  allowMismatch: boolean;
}) {
  const countNum = Math.floor(num(state.count));
  const validCount = Math.max(allowZeroCount ? 0 : 1, Math.min(MAX_PARCELS, countNum));
  function setTotal(total: string) {
    onChange({ ...state, total, parcels: state.manual ? state.parcels : split(num(total), validCount) });
  }
  function setCount(count: string) {
    const n = Math.max(allowZeroCount ? 0 : 1, Math.min(MAX_PARCELS, Math.floor(num(count))));
    onChange({ ...state, count, parcels: resize(state.parcels, n, num(state.total), state.manual) });
  }
  return (
    <>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Field label="Totalt antal" htmlFor={`${idPrefix}-total`}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <Input id={`${idPrefix}-total`} type="number" min="0" step="any" size="sm" value={state.total} onChange={(e) => setTotal(e.target.value)} />
            {unit}
          </span>
        </Field>
        <Field label="Antal kolli" htmlFor={`${idPrefix}-count`}>
          <Input
            id={`${idPrefix}-count`}
            type="number"
            min={allowZeroCount ? "0" : "1"}
            max={MAX_PARCELS}
            step="1"
            size="xs"
            value={state.count}
            onChange={(e) => setCount(e.target.value)}
          />
        </Field>
      </div>
      {state.parcels.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "4px 12px" }}>
          {state.parcels.map((value, i) => (
            <Field key={i} label={`Kolli ${i + 1}`} htmlFor={`${idPrefix}-parcel-${i}`}>
              <Input
                id={`${idPrefix}-parcel-${i}`}
                type="number"
                min="0"
                step="any"
                size="sm"
                value={value}
                onChange={(e) =>
                  onChange({ ...state, manual: true, parcels: state.parcels.map((p, k) => (k === i ? e.target.value : p)) })
                }
              />
            </Field>
          ))}
        </div>
      )}
      {state.parcels.length > 0 && <Summary total={num(state.total)} parcels={state.parcels} unit={unit} allowMismatch={allowMismatch} />}
    </>
  );
}

const parcelsValid = (s: ParcelState) => s.parcels.every((p) => num(p) > 0);

export function PalletCardDialog({ target, onClose }: { target: PalletCardTarget | null; onClose: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title="Pallkort" wide>
      {target?.kind === "single" && <SingleForm target={target} onClose={onClose} />}
      {target?.kind === "delivery" && <DeliveryForm deliveryId={target.deliveryId} onClose={onClose} />}
    </Modal>
  );
}

function SingleForm({ target, onClose }: { target: Extract<PalletCardTarget, { kind: "single" }>; onClose: () => void }) {
  const [state, setState] = useState<ParcelState>(() => initialParcels(target.quantity));
  const allowMismatch = useAllowMismatch();

  function print() {
    const params = new URLSearchParams();
    for (const p of state.parcels) params.append("quantity", String(num(p)));
    window.open(`${target.url}?${params.toString()}`, "_blank", "noopener");
    onClose();
  }

  return (
    <>
      <ParcelEditor state={state} onChange={setState} idPrefix="palletCard" unit={target.unit} allowMismatch={allowMismatch} />
      <FormActions>
        <Button type="button" disabled={state.parcels.length === 0 || !parcelsValid(state) || (!allowMismatch && !matches(num(state.total), state.parcels))} onClick={print}>
          Skriv ut
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </>
  );
}

function DeliveryForm({ deliveryId, onClose }: { deliveryId: string; onClose: () => void }) {
  const [data, setData] = useState<DeliveryRowsResponse | null>(null);
  const [states, setStates] = useState<Record<string, ParcelState>>({});
  const [error, setError] = useState<string | null>(null);
  const allowMismatch = useAllowMismatch();

  useEffect(() => {
    let cancelled = false;
    apiFetch<DeliveryRowsResponse>(`/api/v1/deliveries/${deliveryId}/rows`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStates(Object.fromEntries(res.rows.map((r) => [r.id, initialParcels(r.quantity)])));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Kunde inte hämta följesedelns rader");
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryId]);

  const active = (data?.rows ?? []).filter((r) => (states[r.id]?.parcels.length ?? 0) > 0);
  const canPrint = active.length > 0 && active.every((r) => {
      const st = states[r.id] ?? initialParcels(null);
      return parcelsValid(st) && (allowMismatch || matches(num(st.total), st.parcels));
    });

  function print() {
    const params = new URLSearchParams();
    for (const row of active) params.append("row", `${row.id}:${(states[row.id]?.parcels ?? []).map((p) => num(p)).join(",")}`);
    window.open(`/api/v1/deliveries/${deliveryId}/pallet-card?${params.toString()}`, "_blank", "noopener");
    onClose();
  }

  return (
    <>
      <FormError margin="below">{error}</FormError>
      {!data && !error && <p>Hämtar rader…</p>}
      {data && (
        <>
          <p style={{ marginTop: 0 }}>Följesedel {data.deliveryNumber}. Antal kolli 0 hoppar över raden.</p>
          {data.rows.map((row) => (
            <fieldset key={row.id} style={{ border: "1px solid var(--color-border)", borderRadius: 6, marginBottom: 12 }}>
              <legend>
                {row.articleNumber} {row.articleName}
              </legend>
              <ParcelEditor
                state={states[row.id] ?? initialParcels(row.quantity)}
                onChange={(next) => setStates((prev) => ({ ...prev, [row.id]: next }))}
                idPrefix={`palletCard-${row.id}`}
                unit={row.unit}
                allowZeroCount
                allowMismatch={allowMismatch}
              />
            </fieldset>
          ))}
        </>
      )}
      <FormActions>
        <Button type="button" disabled={!data || !canPrint} onClick={print}>
          Skriv ut
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </>
  );
}

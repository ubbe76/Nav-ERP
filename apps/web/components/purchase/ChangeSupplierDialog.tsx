"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { SearchPicker } from "../ui/SearchPicker";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatRate } from "../../lib/currency";
import { formatUnitPrice } from "../../lib/format";
import { toUnitPrice } from "../../lib/units";
import type { PurchaseOrder, Supplier } from "../../lib/types";
import styles from "./ChangeSupplierDialog.module.css";

// Byt leverantör på en inköpsorder (Utkast/Bekräftad): choose the supplier,
// read what the change does (POST …/change-supplier/preview — the new
// currency and rate, every row's old → new price and where it comes from,
// why it cannot be done) and save with exactly what was shown. The server
// refuses a preview that no longer holds and answers with the new one.
// Mirrors SupplierChangePreview in packages/shared/src/purchase.ts.
export interface SupplierChangePreview {
  orderNumber: string;
  revertsToDraft: boolean;
  clearsConfirmedDates: boolean;
  from: { supplierId: string; supplierName: string; currency: string; exchangeRate: number };
  to: { supplierId: string; supplierName: string; currency: string; exchangeRate: number };
  terms: {
    deliveryTerm: string | null;
    paymentTerm: string | null;
    carrier: string | null;
    freightPaidByUs: boolean;
    yourReference: string | null;
  };
  blockers: { code: string; message: string }[];
  rows: {
    rowId: string;
    articleNumber: string;
    articleName: string;
    unitCode: string;
    unitFactor: number | null;
    lego: boolean;
    before: { unitPrice: number; setupPrice: number | null };
    after: { unitPrice: number; setupPrice: number | null };
    origin: "catalog" | "converted" | "unchanged";
    review: boolean;
    operationSupplierDiffers: boolean;
  }[];
}

const ORIGIN_LABEL: Record<SupplierChangePreview["rows"][number]["origin"], string> = {
  catalog: "katalog",
  converted: "omräknat",
  unchanged: "oförändrat",
};

interface ChangeSupplierDialogProps {
  order: PurchaseOrder;
  onCancel: () => void;
  onDone: (change: SupplierChangePreview) => void;
}

export function ChangeSupplierDialog({ order, onCancel, onDone }: ChangeSupplierDialogProps) {
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [preview, setPreview] = useState<SupplierChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Today's rate is missing for the new currency: the user types one.
  const [rateNeeded, setRateNeeded] = useState(false);
  const [rate, setRate] = useState("");
  const seq = useRef(0);

  const typedRate = () => (rateNeeded && rate.trim() !== "" ? { exchangeRate: rate.replace(",", ".") } : {});

  async function loadPreview(next: Supplier, extra: Record<string, string> = {}) {
    const mine = ++seq.current;
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const result = await apiFetch<SupplierChangePreview>(`/api/v1/purchase-orders/${order.id}/change-supplier/preview`, {
        method: "POST",
        body: JSON.stringify({ supplierId: next.id, ...extra }),
      });
      if (mine !== seq.current) return;
      setPreview(result);
    } catch (err) {
      if (mine !== seq.current) return;
      if (err instanceof ApiError && err.code === "exchange-rate-unavailable") setRateNeeded(true);
      setError(apiErrorMessage(err, "Förhandsvisningen kunde inte hämtas"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  function pickSupplier(next: Supplier | null) {
    setSupplier(next);
    setRateNeeded(false);
    setRate("");
    setPreview(null);
    setError(null);
    seq.current++;
    setLoading(false);
    if (next) void loadPreview(next);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!supplier || !preview || preview.blockers.length > 0) return;
    setError(null);
    setSaving(true);
    try {
      const result = await apiFetch<{ change: SupplierChangePreview }>(`/api/v1/purchase-orders/${order.id}/change-supplier`, {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplier.id,
          ...typedRate(),
          expected: {
            supplierId: preview.from.supplierId,
            currency: preview.to.currency,
            exchangeRate: preview.to.exchangeRate,
            rows: preview.rows.map((r) => ({ rowId: r.rowId, unitPrice: r.after.unitPrice, setupPrice: r.after.setupPrice })),
          },
        }),
      });
      onDone(result.change);
    } catch (err) {
      // The preview no longer holds: show the new one, nothing was saved.
      const fresh = err instanceof ApiError ? (err.body as { preview?: SupplierChangePreview } | undefined)?.preview : undefined;
      if (fresh) setPreview(fresh);
      setError(apiErrorMessage(err, "Leverantören kunde inte bytas"));
    } finally {
      setSaving(false);
    }
  }

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const reviewCount = preview?.rows.filter((r) => r.review).length ?? 0;
  const currencyChanges = preview !== null && preview.from.currency !== preview.to.currency;
  const price = (value: number, factor: number | null) => formatUnitPrice(toUnitPrice(value, factor));

  return (
    <Form onSubmit={save}>
      <Field label="Ny leverantör" htmlFor="changeSupplierId">
        <SearchPicker
          id="changeSupplierId"
          endpoint="/api/v1/suppliers"
          value={supplier}
          onChange={pickSupplier}
          excludeId={order.supplierId}
          formatLabel={(s) => `${s.supplierNumber} — ${s.name} (${s.currency})`}
          placeholder="Sök leverantörnummer eller namn…"
          emptyText="Inga leverantörer matchar sökningen"
        />
      </Field>
      <FormHint attached>Nuvarande leverantör: {order.supplierName}</FormHint>

      {rateNeeded && supplier && (
        <>
          <Field label={`Växelkurs (SEK per ${supplier.currency})`} htmlFor="changeSupplierRate">
            <Input id="changeSupplierRate" type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              disabled={loading || rate.trim() === ""}
              onClick={() => void loadPreview(supplier, { exchangeRate: rate.replace(",", ".") })}
            >
              Förhandsvisa
            </Button>
          </FormActions>
        </>
      )}

      <FormError>{error}</FormError>
      {loading && <FormHint>Hämtar förhandsvisning…</FormHint>}

      {preview && (
        <>
          {preview.blockers.map((b) => (
            <FormError key={b.code}>{b.message}</FormError>
          ))}

          {preview.revertsToDraft && !blocked && (
            <FormNotice>
              Ordern går tillbaka till Utkast. Meddela {preview.from.supplierName} att ordern inte gäller längre.
            </FormNotice>
          )}

          {preview.clearsConfirmedDates && !blocked && (
            <FormHint>Bekräftat leveransdatum tas bort — den nya leverantören bekräftar sitt eget.</FormHint>
          )}

          <dl className={styles.summary}>
            <dt>Valuta och kurs</dt>
            <dd>
              {currencyChanges
                ? `${preview.from.currency} → ${preview.to.currency}, kurs ${formatRate(preview.to.exchangeRate)}`
                : `${preview.to.currency}, kurs ${formatRate(preview.to.exchangeRate)} (oförändrad)`}
            </dd>
            <dt>Från den nya leverantören</dt>
            <dd>
              Leveransvillkor: {preview.terms.deliveryTerm ?? "–"} · Betalningsvillkor: {preview.terms.paymentTerm ?? "–"} · Speditör:{" "}
              {preview.terms.carrier ?? "–"} · Frakt på vårt konto: {preview.terms.freightPaidByUs ? "Ja" : "Nej"} · Er referens:{" "}
              {preview.terms.yourReference ?? "–"}
            </dd>
          </dl>

          {preview.rows.length > 0 && (
            <ul className={styles.rows}>
              {preview.rows.map((r) => (
                <li key={r.rowId} className={styles.row}>
                  <span className={styles.article}>
                    {r.articleNumber}
                    {r.review && <span className={styles.review}>Se över priset</span>}
                    <span className={styles.articleName}>{r.lego ? `Lego · ${r.articleName}` : r.articleName}</span>
                  </span>
                  <span className={styles.price}>
                    {price(r.before.unitPrice, r.unitFactor)} {preview.from.currency} → {price(r.after.unitPrice, r.unitFactor)}{" "}
                    {preview.to.currency}/{r.unitCode}
                    <span className={styles.origin}>
                      {ORIGIN_LABEL[r.origin]}
                      {r.after.setupPrice !== null &&
                        ` · ställpris ${formatUnitPrice(r.before.setupPrice ?? 0)} → ${formatUnitPrice(r.after.setupPrice)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {reviewCount > 0 && !blocked && (
            <FormHint>
              {reviewCount === 1 ? "1 rad saknar" : `${reviewCount} rader saknar`} pris hos {preview.to.supplierName} i leverantörskatalogen och
              behåller sitt pris{currencyChanges ? " (omräknat till den nya valutan)" : ""} — se över dem efter bytet.
            </FormHint>
          )}
          {preview.rows.some((r) => r.operationSupplierDiffers) && !blocked && (
            <FormHint>
              Tillverkningsorderns legooperation har kvar sin leverantör — ändra den på tillverkningsordern om kommande legoinköp också ska gå till{" "}
              {preview.to.supplierName}.
            </FormHint>
          )}
        </>
      )}

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={!preview || blocked || saving || loading}>
          {saving ? "Byter…" : "Byt leverantör"}
        </Button>
      </FormActions>
    </Form>
  );
}

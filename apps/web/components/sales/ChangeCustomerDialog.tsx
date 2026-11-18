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
import type { Customer, SalesOrder } from "../../lib/types";
import styles from "./ChangeCustomerDialog.module.css";

// Byt kund på en offert eller kundorder (Offert/Bekräftad/Under
// tillverkning): choose the customer, read what the change does (POST
// …/change-customer/preview — the new currency and rate, what the order
// takes from the customer and what is cleared, every row's old → new price
// and where it comes from, why it cannot be done) and save with exactly what
// was shown. The server refuses a preview that no longer holds and answers
// with the new one. Mirrors CustomerChangePreview in
// packages/shared/src/customer-change.ts.
type Review = "manual" | "setup" | "configured" | "freight" | "no-price";
export interface CustomerChangePreview {
  orderNumber: string;
  documentKind: "quote" | "order";
  from: { customerId: string; customerNumber: string; customerName: string; currency: string; exchangeRate: number };
  to: { customerId: string; customerNumber: string; customerName: string; currency: string; exchangeRate: number };
  header: {
    deliveryAddress: string | null;
    deliveryTerm: string | null;
    paymentTerm: string | null;
    carrier: string | null;
    customerReference: string | null;
    invoiceCustomer: string | null;
  };
  clears: { customerOrderNumber: string | null; customerInquiryNumber: string | null; freight: boolean; oneOffDeliveryAddress: boolean };
  blockers: { code: string; message: string }[];
  rows: {
    rowId: string;
    articleNumber: string;
    articleName: string;
    unitCode: string;
    unitFactor: number | null;
    kind: "article" | "setup" | "configured" | "freight";
    before: { unitPrice: number; discountPercent: number };
    after: { unitPrice: number; discountPercent: number };
    origin: "chain" | "converted" | "unchanged";
    review: Review | null;
  }[];
}

const ORIGIN_LABEL: Record<CustomerChangePreview["rows"][number]["origin"], string> = {
  chain: "kundens pris",
  converted: "omräknat",
  unchanged: "oförändrat",
};

// Why a row kept its price — shown next to the origin.
export const CUSTOMER_CHANGE_REVIEW_LABEL: Record<Review, string> = {
  manual: "handskrivet pris",
  setup: "ställkostnad",
  configured: "konfigurerad rad",
  freight: "frakt",
  "no-price": "inget pris hos kunden",
};

// What the old customer's order carried and the change removes, as a list
// of the card's own field names.
function customerChangeClearsText(clears: CustomerChangePreview["clears"]): string | null {
  const parts = [
    clears.customerOrderNumber ? `Kundens ordernummer (${clears.customerOrderNumber})` : null,
    clears.customerInquiryNumber ? `Kundens förfrågan (${clears.customerInquiryNumber})` : null,
    clears.freight ? "fraktvalet" : null,
    clears.oneOffDeliveryAddress ? "orderns engångsadress" : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

interface ChangeCustomerDialogProps {
  order: SalesOrder;
  onCancel: () => void;
  onDone: (change: CustomerChangePreview) => void;
}

export function ChangeCustomerDialog({ order, onCancel, onDone }: ChangeCustomerDialogProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [preview, setPreview] = useState<CustomerChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Today's rate is missing for the new currency: the user types one.
  const [rateNeeded, setRateNeeded] = useState(false);
  const [rate, setRate] = useState("");
  const seq = useRef(0);

  const typedRate = () => (rateNeeded && rate.trim() !== "" ? { exchangeRate: rate.replace(",", ".") } : {});

  async function loadPreview(next: Customer, extra: Record<string, string> = {}) {
    const mine = ++seq.current;
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const result = await apiFetch<CustomerChangePreview>(`/api/v1/sales-orders/${order.id}/change-customer/preview`, {
        method: "POST",
        body: JSON.stringify({ customerId: next.id, ...extra }),
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

  function pickCustomer(next: Customer | null) {
    setCustomer(next);
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
    if (!customer || !preview || preview.blockers.length > 0) return;
    setError(null);
    setSaving(true);
    try {
      const result = await apiFetch<{ change: CustomerChangePreview }>(`/api/v1/sales-orders/${order.id}/change-customer`, {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          ...typedRate(),
          expected: {
            customerId: preview.from.customerId,
            currency: preview.to.currency,
            exchangeRate: preview.to.exchangeRate,
            rows: preview.rows.map((r) => ({ rowId: r.rowId, unitPrice: r.after.unitPrice, discountPercent: r.after.discountPercent })),
          },
        }),
      });
      onDone(result.change);
    } catch (err) {
      // The preview no longer holds: show the new one, nothing was saved.
      const fresh = err instanceof ApiError ? (err.body as { preview?: CustomerChangePreview } | undefined)?.preview : undefined;
      if (fresh) setPreview(fresh);
      setError(apiErrorMessage(err, "Kunden kunde inte bytas"));
    } finally {
      setSaving(false);
    }
  }

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const reviewCount = preview?.rows.filter((r) => r.review).length ?? 0;
  const currencyChanges = preview !== null && preview.from.currency !== preview.to.currency;
  const price = (value: number, factor: number | null) => formatUnitPrice(toUnitPrice(value, factor));
  const discount = (value: number) => (value > 0 ? `, rabatt ${value.toLocaleString("sv-SE")} %` : "");
  const cleared = preview ? customerChangeClearsText(preview.clears) : null;
  const isQuote = preview?.documentKind === "quote";

  return (
    <Form onSubmit={save}>
      <Field label="Ny kund" htmlFor="changeCustomerId">
        <SearchPicker
          id="changeCustomerId"
          endpoint="/api/v1/customers"
          value={customer}
          onChange={pickCustomer}
          excludeId={order.customerId}
          formatLabel={(c) => `${c.customerNumber} — ${c.name} (${c.currency})`}
          placeholder="Sök kundnummer eller namn…"
          emptyText="Inga kunder matchar sökningen"
        />
      </Field>
      <FormHint attached>Nuvarande kund: {order.customerName}</FormHint>

      {rateNeeded && customer && (
        <>
          <Field label={`Växelkurs (SEK per ${customer.currency})`} htmlFor="changeCustomerRate">
            <Input id="changeCustomerRate" type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              disabled={loading || rate.trim() === ""}
              onClick={() => void loadPreview(customer, { exchangeRate: rate.replace(",", ".") })}
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

          {!blocked && (
            <FormNotice>
              {isQuote
                ? `Offerten behåller sin status. Skicka en ny offert till ${preview.to.customerName} efter bytet.`
                : `Ordern behåller sin status. Skicka en ny orderbekräftelse till ${preview.to.customerName} efter bytet.`}
            </FormNotice>
          )}

          <dl className={styles.summary}>
            <dt>Valuta och kurs</dt>
            <dd>
              {currencyChanges
                ? `${preview.from.currency} → ${preview.to.currency}, kurs ${formatRate(preview.to.exchangeRate)}`
                : `${preview.to.currency}, kurs ${formatRate(preview.to.exchangeRate)} (oförändrad)`}
            </dd>
            <dt>Från den nya kunden</dt>
            <dd>
              Leveransadress: {preview.header.deliveryAddress ?? "–"} · Leveransvillkor: {preview.header.deliveryTerm ?? "–"} · Betalningsvillkor:{" "}
              {preview.header.paymentTerm ?? "–"} · Speditör: {preview.header.carrier ?? "–"} · Referens: {preview.header.customerReference ?? "–"} ·
              Fakturakund: {preview.header.invoiceCustomer ?? "–"}
            </dd>
            {cleared && (
              <>
                <dt>Tas bort — gällde den gamla kunden</dt>
                <dd>{cleared}</dd>
              </>
            )}
          </dl>

          {preview.rows.length > 0 && (
            <ul className={styles.rows}>
              {preview.rows.map((r) => (
                <li key={r.rowId} className={styles.row}>
                  <span className={styles.article}>
                    {r.articleNumber}
                    {r.review && <span className={styles.review}>Se över priset</span>}
                    <span className={styles.articleName}>{r.articleName}</span>
                  </span>
                  <span className={styles.price}>
                    {price(r.before.unitPrice, r.unitFactor)} {preview.from.currency}
                    {discount(r.before.discountPercent)} → {price(r.after.unitPrice, r.unitFactor)} {preview.to.currency}/{r.unitCode}
                    {discount(r.after.discountPercent)}
                    <span className={styles.origin}>
                      {ORIGIN_LABEL[r.origin]}
                      {r.review && ` · ${CUSTOMER_CHANGE_REVIEW_LABEL[r.review]}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {reviewCount > 0 && !blocked && (
            <FormHint>
              {reviewCount === 1 ? "1 rad behåller" : `${reviewCount} rader behåller`} sitt pris
              {currencyChanges ? " (omräknat till den nya valutan)" : ""} — handskrivna priser, ställkostnader, konfigurerade rader, frakt och
              artiklar utan pris hos {preview.to.customerName} prissätts inte om. Se över dem efter bytet.
            </FormHint>
          )}
        </>
      )}

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={!preview || blocked || saving || loading}>
          {saving ? "Byter…" : "Byt kund"}
        </Button>
      </FormActions>
    </Form>
  );
}

"use client";

import { confirmDialog } from "../../lib/confirm";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import {
  currencyLabel,
  exchangeDifferenceText,
  formatRate,
  receiptExchangeDifference,
  releasedSek,
  SEK,
  toleranceInCurrency,
  toSek,
} from "../../lib/currency";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { stockholmToday } from "../../lib/date";
import { applyPaymentTolerance, paymentPreview, PREVIEW_TONE_COLOR } from "../../lib/paymentTolerance";
import { useExchangeRateLookup } from "../../lib/useExchangeRate";
import {
  INVOICE_TYPE_LABELS,
  type AccountOption,
  type Customer,
  type OpenInvoiceRow,
  type Paged,
  type PaymentDetail,
} from "../../lib/types";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";

function today(): string {
  return stockholmToday();
}

function accountLabel(a: AccountOption): string {
  return `${a.number} · ${a.name}`;
}

// Pins the configured betalkonto into the options even if it has since gone
// inactive (and dropped out of /account-options, which lists active accounts
// only) — same defensive idiom as VerificationCard's withCurrentAccount, just
// keyed on the account number instead of an id.
function accountOptionsWithCurrent(accounts: AccountOption[], current: string): AccountOption[] {
  if (!current || accounts.some((a) => a.number === current)) return accounts;
  return [{ number: current, name: current }, ...accounts];
}

// Registration form: pick a customer (or scan/enter an OCR reference), tick
// off the open items this payment settles, and submit. The matching table
// shows every open item for the selected customer — Monitor-style, so a
// payment covering several invoices at once is one screen, not several.
//
// Valuta: the amounts are in the invoices' currency, and one payment never
// mixes currencies (a ticked invoice locks out the other currencies). For an
// invoice in another currency than SEK the payment also takes Belopp i SEK
// (what actually reached the bank account, prefilled from the rate for the
// payment date) and Bankavgift, and previews the kursdifferens the API will
// book — the same arithmetic as the API (lib/currency.ts).
export function PaymentRegistrationForm({
  customers,
  accounts,
  defaultBankAccount,
  tolerance,
  initialInvoiceId,
  onDone,
}: {
  customers: Customer[];
  accounts: AccountOption[];
  defaultBankAccount: string;
  tolerance: number;
  initialInvoiceId?: string;
  // The registered payment (its kursdifferens is shown by the caller).
  onDone: (payment: PaymentDetail) => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [rows, setRows] = useState<OpenInvoiceRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [ocrValue, setOcrValue] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [bankAccountNumber, setBankAccountNumber] = useState(defaultBankAccount);
  const [paymentDate, setPaymentDate] = useState(today());
  // Valuta: Belopp i SEK (insatt på kontot) follows the rate for the payment
  // date until it is typed in (manuellt vinner), Bankavgift is part of it.
  const [amountSek, setAmountSek] = useState("");
  const [amountSekTouched, setAmountSekTouched] = useState(false);
  const [bankFee, setBankFee] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Consumed once the matching invoice shows up in the fetched open items —
  // same "pending" pattern as InvoicesPageClient's pendingOrderRef.
  const pendingPreselectRef = useRef<string | null>(initialInvoiceId ?? null);

  function includeRow(row: OpenInvoiceRow) {
    setIncludedIds((prev) => new Set(prev).add(row.id));
    setAmounts((prev) => (prev[row.id] !== undefined ? prev : { ...prev, [row.id]: String(row.openAmount) }));
  }

  // Resolve ?invoice=<id>'s customer once on mount — /open-invoices is keyed
  // by customer, not invoice, so the invoice's own customerId has to be
  // fetched first. Same "resolve then let the customer-effect load rows"
  // pattern as NewInvoiceForm's initialOrderId.
  useEffect(() => {
    if (!initialInvoiceId) return;
    apiFetch<{ customerId: string }>(`/api/v1/invoices/${initialInvoiceId}`)
      .then((invoice) => setCustomerId(invoice.customerId))
      .catch(() => {
        pendingPreselectRef.current = null;
        setError("Kunde inte hämta fakturan att förifylla");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the selected customer's open items whenever the customer changes.
  useEffect(() => {
    setRows([]);
    setIncludedIds(new Set());
    setAmounts({});
    setAmountSek("");
    setAmountSekTouched(false);
    setBankFee("");
    if (!customerId) return;
    let cancelled = false;
    setRowsLoading(true);
    apiFetch<Paged<OpenInvoiceRow>>(`/api/v1/open-invoices?customerId=${customerId}&limit=1000`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        const pending = pendingPreselectRef.current;
        if (pending) {
          const row = res.rows.find((r) => r.id === pending);
          if (row) includeRow(row);
        }
        pendingPreselectRef.current = null;
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function toggleRow(row: OpenInvoiceRow) {
    setIncludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    setAmounts((prev) => (prev[row.id] !== undefined ? prev : { ...prev, [row.id]: String(row.openAmount) }));
  }

  function updateAmount(id: string, value: string) {
    setAmounts((prev) => ({ ...prev, [id]: value }));
  }

  async function fetchByOcr() {
    const trimmed = ocrValue.trim();
    if (!trimmed) return;
    setOcrError(null);
    try {
      const invoice = await apiFetch<OpenInvoiceRow>(`/api/v1/open-invoices/by-ocr/${encodeURIComponent(trimmed)}`);
      if (invoice.customerId !== customerId) {
        // Switching customer wipes the matching table (the [customerId]
        // effect below unconditionally resets rows/includedIds/amounts) — a
        // silent switch would throw away rows the user already checked and
        // typed belopp for. Only worth asking when there is something to
        // lose: editing an amount requires the row to be included first (its
        // Input is disabled otherwise), so "any row checked" already covers
        // "any row edited".
        if (
          includedIds.size > 0 &&
          !(await confirmDialog(`OCR-numret tillhör en annan kund (${invoice.customerName}). Byta kund? Inmatade rader rensas.`))
        ) {
          return;
        }
        pendingPreselectRef.current = invoice.id;
        setCustomerId(invoice.customerId);
      } else {
        if (paymentCurrency !== null && invoice.currency !== paymentCurrency && !includedIds.has(invoice.id)) {
          setOcrError(`Fakturan är i ${invoice.currency} men valda poster är i ${paymentCurrency} — en betalning kan inte blanda valutor`);
          return;
        }
        includeRow(invoice);
      }
      setOcrValue("");
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : "Ingen öppen post hittades för det OCR-numret");
    }
  }

  const includedRows = rows.filter((r) => includedIds.has(r.id));
  // Rounded PER ROW first, then summed — same order of operations the
  // server's own balance check uses (appliedTotal = round2(Σ round2(row)) in
  // payment.service.ts's create) — so "Summa" can never drift a cent from
  // what the POST below actually sends as `amount`.
  const roundedRows = includedRows.map((r) => ({ invoiceId: r.id, appliedAmount: round2(Number(amounts[r.id]) || 0) }));
  const totalAmount = round2(roundedRows.reduce((sum, r) => sum + r.appliedAmount, 0));

  // Valuta: the payment's currency is the ticked invoices' (the others are
  // locked out, so there is one).
  const paymentCurrency = includedRows[0]?.currency ?? null;
  const foreignPayment = paymentCurrency !== null && paymentCurrency !== SEK;
  // A kvittning (the ticked items net to 0) moves no money: no SEK amount.
  const needsSekAmount = foreignPayment && totalAmount !== 0;
  const rateLookup = useExchangeRateLookup(needsSekAmount ? paymentCurrency : null, paymentDate);
  useEffect(() => {
    if (amountSekTouched) return;
    if (!needsSekAmount) {
      setAmountSek("");
      return;
    }
    if (rateLookup.status === "ok") setAmountSek(String(toSek(totalAmount, rateLookup.lookup.rate)));
    else if (rateLookup.status === "error") setAmountSek("");
  }, [rateLookup, totalAmount, needsSekAmount, amountSekTouched]);

  // The kursdifferens preview — what the API books on 3960/7960: the SEK that
  // reached the account plus the fee the bank kept, less the SEK the settled
  // rows release from the invoices' booked receivable (frigjort SEK).
  // Positive = kursvinst. A kvittning (amount 0) moves no SEK at all, but two
  // foreign invoices at different rates still leave a difference.
  const exchangePreview = (() => {
    if (!foreignPayment) return null;
    const sek = needsSekAmount ? Number(amountSek.replace(",", ".")) : 0;
    if (needsSekAmount && (amountSek.trim() === "" || !Number.isFinite(sek) || sek === 0)) return null;
    const fee = !needsSekAmount || bankFee.trim() === "" ? 0 : Number(bankFee.replace(",", "."));
    if (!Number.isFinite(fee) || fee < 0) return null;
    const released: number[] = [];
    let bookedReceivable = 0;
    for (const row of includedRows) {
      const applied = round2(Number(amounts[row.id]) || 0);
      if (applied === 0) continue;
      const rate = row.exchangeRate ?? 1;
      const result = applyPaymentTolerance(row.openAmount, applied, toleranceInCurrency(tolerance, rate, row.currency));
      if (!result.ok) return null;
      const grossSek = row.grossAmountSek ?? toSek(row.grossAmount, rate);
      const sekPart = releasedSek({
        currency: row.currency,
        grossAmount: row.grossAmount,
        grossAmountSek: grossSek,
        previouslyReleasedSek: row.openAmountSek === null || row.grossAmountSek === null ? 0 : round2(grossSek - row.openAmountSek),
        appliedAmount: applied,
        writeOffAmount: result.writeOffAmount,
        settles: result.settles,
      });
      released.push(sekPart.appliedAmountSek);
      bookedReceivable = round2(bookedReceivable + sekPart.appliedAmountSek + sekPart.writeOffAmountSek);
    }
    const difference = receiptExchangeDifference({ amountSek: sek, bankFeeSek: fee, appliedAmountsSek: released });
    // The API's sign: positive = kursvinst (receiptExchangeDifference is
    // positive for a kursförlust).
    return { gain: difference === 0 ? 0 : -difference, bookedReceivable };
  })();

  // The row preview's red texts (over the open amount, wrong sign): the API
  // would refuse the whole payment, so the button waits for the correction.
  const hasInvalidAmount = includedRows.some(
    (row) =>
      paymentPreview(
        row.openAmount,
        amounts[row.id] ?? String(row.openAmount),
        toleranceInCurrency(tolerance, row.exchangeRate ?? 1, row.currency)
      ).tone === "error"
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!customerId) {
      setError("Välj en kund");
      return;
    }
    const rowsPayload = roundedRows.filter((r) => r.appliedAmount !== 0);
    if (rowsPayload.length === 0) {
      setError("Kryssa i minst en post att betala");
      return;
    }
    if (!bankAccountNumber) {
      setError("Välj ett betalkonto");
      return;
    }
    let sekFields: { amountSek: number; bankFeeSek: number } | undefined;
    if (needsSekAmount) {
      const sek = Number(amountSek.replace(",", "."));
      if (amountSek.trim() === "" || !Number.isFinite(sek) || sek === 0) {
        setError("Ange beloppet i SEK som kom in på kontot — skriv av det från kontoutdraget");
        return;
      }
      sekFields = { amountSek: round2(sek), bankFeeSek: bankFee.trim() === "" ? 0 : round2(Number(bankFee.replace(",", "."))) };
    }
    setError(null);
    setPending(true);
    try {
      const payment = await apiFetch<PaymentDetail>("/api/v1/payments", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          paymentDate,
          bankAccountNumber,
          amount: totalAmount,
          ...(paymentCurrency !== null ? { currency: paymentCurrency } : {}),
          ...sekFields,
          note: note.trim() || undefined,
          rows: rowsPayload,
        }),
      });
      onDone(payment);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte registrera betalningen"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth="none" style={{ marginBottom: 20 }}>
      <Form onSubmit={submit}>
        <FormError>{error}</FormError>

        <FormRow>
          <Field label="Kund" htmlFor="paymentCustomer">
            <Select
              id="paymentCustomer"
              value={customerId}
              onChange={(e) => {
                pendingPreselectRef.current = null;
                setCustomerId(e.target.value);
              }}
            >
              <option value="">— Välj kund —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Hämta via OCR-nummer" htmlFor="paymentOcr">
            <span style={{ display: "flex", gap: 8 }}>
              <Input
                id="paymentOcr"
                size="md"
                value={ocrValue}
                onChange={(e) => setOcrValue(e.target.value)}
                placeholder="OCR-nummer"
              />
              <Button type="button" variant="secondary" onClick={fetchByOcr}>
                Hämta
              </Button>
            </span>
          </Field>
        </FormRow>
        <FormError>{ocrError}</FormError>

        {customerId && rowsLoading && <p>Hämtar öppna poster…</p>}
        {customerId && !rowsLoading && rows.length === 0 && <p>Kunden har inga öppna poster.</p>}

        {rows.length > 0 && (
          <Table<OpenInvoiceRow>
            columns={[
              { key: "include", label: "", width: "36px" },
              { key: "invoiceNumber", label: "Faktura", width: "110px" },
              { key: "type", label: "Typ", width: "110px" },
              { key: "dueDate", label: "Förfaller", width: "110px" },
              { key: "openAmount", label: "Öppet belopp", width: "120px", align: "right" },
              { key: "amount", label: "Belopp", width: "130px", align: "right" },
              { key: "preview", label: "", width: "1fr" },
            ]}
            rows={rows}
            renderCell={(row, key) => {
              const included = includedIds.has(row.id);
              switch (key) {
                case "include": {
                  // One payment never mixes currencies: once an invoice is
                  // ticked, the other currencies cannot be.
                  const otherCurrency = !included && paymentCurrency !== null && row.currency !== paymentCurrency;
                  return (
                    <span title={otherCurrency ? `En betalning kan inte blanda valutor — välj bara fakturor i ${paymentCurrency}` : undefined}>
                      <Checkbox
                        aria-label={`Ta med ${row.invoiceNumber ?? row.id}`}
                        checked={included}
                        disabled={otherCurrency}
                        onChange={() => toggleRow(row)}
                      />
                    </span>
                  );
                }
                case "invoiceNumber":
                  return (
                    <Link href={`/forsaljning/fakturor/${row.id}`} className={listStyles.rowLink}>
                      {row.invoiceNumber ?? "–"}
                    </Link>
                  );
                case "type":
                  return INVOICE_TYPE_LABELS[row.type];
                case "dueDate":
                  return row.dueDate ?? "–";
                case "openAmount":
                  return row.currency === SEK ? (
                    `${formatMoney(row.openAmount)} kr`
                  ) : (
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <span>
                        {formatMoney(row.openAmount)} {row.currency}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                        {row.exchangeRate !== null && <>kurs {formatRate(row.exchangeRate)}</>}
                        {row.openAmountSek !== null && <> · {formatMoney(row.openAmountSek)} kr bokfört</>}
                      </span>
                    </span>
                  );
                case "amount":
                  return (
                    <Input
                      type="number"
                      step="0.01"
                      size="sm"
                      aria-label={`Belopp — ${row.invoiceNumber ?? row.id}`}
                      value={amounts[row.id] ?? String(row.openAmount)}
                      disabled={!included}
                      onChange={(e) => updateAmount(row.id, e.target.value)}
                    />
                  );
                case "preview": {
                  if (!included) return null;
                  const preview = paymentPreview(
                    row.openAmount,
                    amounts[row.id] ?? String(row.openAmount),
                    // The tolerance is kronor: on a foreign invoice what it is
                    // worth in the invoice's currency at its rate.
                    toleranceInCurrency(tolerance, row.exchangeRate ?? 1, row.currency),
                    currencyLabel(row.currency)
                  );
                  return <span style={{ color: PREVIEW_TONE_COLOR[preview.tone] }}>{preview.text}</span>;
                }
                default:
                  return null;
              }
            }}
          />
        )}

        <FormRow columns={3}>
          <Field label="Betalkonto" htmlFor="paymentAccount">
            <Select id="paymentAccount" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)}>
              {accountOptionsWithCurrent(accounts, bankAccountNumber).map((a) => (
                <option key={a.number} value={a.number}>
                  {accountLabel(a)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Betalningsdatum" htmlFor="paymentDate">
            <Input
              id="paymentDate"
              type="date"
              size="sm"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>
          <Field label="Summa" htmlFor="paymentSum">
            <Input
              id="paymentSum"
              size="sm"
              value={`${formatMoney(totalAmount)} ${currencyLabel(paymentCurrency ?? SEK)}`}
              disabled
            />
          </Field>
        </FormRow>

        {/* Valuta: what reached the bank account, and the kursdifferens it makes. */}
        {needsSekAmount && (
          <>
            <FormRow>
              <Field label="Belopp i SEK (insatt på kontot)" htmlFor="paymentAmountSek">
                <Input
                  id="paymentAmountSek"
                  type="number"
                  step="0.01"
                  size="sm"
                  value={amountSek}
                  onChange={(e) => {
                    setAmountSekTouched(true);
                    setAmountSek(e.target.value);
                  }}
                />
                <FormHint>
                  Skriv av beloppet från kontoutdraget.
                  {rateLookup.status === "ok" &&
                    !amountSekTouched &&
                    ` Förifyllt med kursen ${formatRate(rateLookup.lookup.rate)} för ${rateLookup.lookup.date} × ${formatMoney(totalAmount)} ${paymentCurrency}.${rateLookup.lookup.source === "riksbank" ? " Källa: Sveriges Riksbank." : ""}`}
                </FormHint>
              </Field>
              <Field label="Bankavgift" htmlFor="paymentBankFee">
                <Input
                  id="paymentBankFee"
                  type="number"
                  min="0"
                  step="0.01"
                  size="sm"
                  value={bankFee}
                  onChange={(e) => setBankFee(e.target.value)}
                />
                <FormHint>
                  Bankens avgift i SEK, om banken tog en. Den ingår inte i beloppet som kom in på kontot och bokförs som
                  bankkostnad i stället för kursdifferens.
                </FormHint>
              </Field>
            </FormRow>
            {rateLookup.status === "error" && !amountSekTouched && <FormNotice>{rateLookup.message}</FormNotice>}
          </>
        )}
        {foreignPayment && totalAmount === 0 && (
          <FormHint>Posterna kvittas mot varandra — inga pengar flyttas, så ingen SEK-uppgift behövs.</FormHint>
        )}
        {exchangePreview && (needsSekAmount || exchangePreview.gain !== 0) && (
          <FormHint>
            Avräknas mot fordran: {formatMoney(exchangePreview.bookedReceivable)} kr (bokfört värde).{" "}
            <strong
              style={{
                color:
                  exchangePreview.gain > 0
                    ? "var(--status-running-text)"
                    : exchangePreview.gain < 0
                      ? "var(--status-stopped-text)"
                      : "var(--color-text-secondary)",
              }}
            >
              {exchangeDifferenceText(exchangePreview.gain, formatMoney)}
            </strong>
            {exchangePreview.gain !== 0 && " bokförs på kursdifferenskontot."}
          </FormHint>
        )}

        <Field label="Notering" htmlFor="paymentNote">
          <Input id="paymentNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending || hasInvalidAmount}>
            {pending ? "Registrerar…" : "Registrera betalning"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}

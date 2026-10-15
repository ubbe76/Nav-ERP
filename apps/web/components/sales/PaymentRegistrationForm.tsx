"use client";

import { confirmDialog } from "../../lib/confirm";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatMoney, round2 } from "../../lib/format";
import { stockholmToday } from "../../lib/date";
import { paymentPreview, PREVIEW_TONE_COLOR } from "../../lib/paymentTolerance";
import { INVOICE_TYPE_LABELS, type AccountOption, type Customer, type OpenInvoiceRow, type Paged } from "../../lib/types";
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
  onDone: () => void;
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
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/payments", {
        method: "POST",
        body: JSON.stringify({
          customerId,
          paymentDate,
          bankAccountNumber,
          amount: totalAmount,
          note: note.trim() || undefined,
          rows: rowsPayload,
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte registrera betalningen");
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
                case "include":
                  return (
                    <Checkbox
                      aria-label={`Ta med ${row.invoiceNumber ?? row.id}`}
                      checked={included}
                      onChange={() => toggleRow(row)}
                    />
                  );
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
                  return `${formatMoney(row.openAmount)} kr`;
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
                  const preview = paymentPreview(row.openAmount, amounts[row.id] ?? String(row.openAmount), tolerance);
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
            <Input id="paymentSum" size="sm" value={`${formatMoney(totalAmount)} kr`} disabled />
          </Field>
        </FormRow>

        <Field label="Notering" htmlFor="paymentNote">
          <Input id="paymentNote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Registrerar…" : "Registrera betalning"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}

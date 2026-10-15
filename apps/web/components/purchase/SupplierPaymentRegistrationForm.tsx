"use client";

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
import type { AccountOption, OpenSupplierInvoiceRow, Paged, Supplier } from "../../lib/types";
import listStyles from "../../app/inkop/ordrar/page.module.css";

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

// Registration form: pick a supplier, tick off the open items this payment
// settles, and submit. The matching table shows every open item for the
// selected supplier — Monitor-style, so a payment covering several invoices at
// once is one screen, not several. No OCR lookup on this side: supplier
// invoices are matched manually, never parsed from a reference (the AP
// endpoints have no by-ocr route at all).
export function SupplierPaymentRegistrationForm({
  suppliers,
  accounts,
  defaultBankAccount,
  tolerance,
  initialInvoiceId,
  onDone,
}: {
  suppliers: Supplier[];
  accounts: AccountOption[];
  defaultBankAccount: string;
  tolerance: number;
  initialInvoiceId?: string;
  onDone: () => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [rows, setRows] = useState<OpenSupplierInvoiceRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [bankAccountNumber, setBankAccountNumber] = useState(defaultBankAccount);
  const [paymentDate, setPaymentDate] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Consumed once the matching invoice shows up in the fetched open items —
  // same "pending" pattern as InvoicesPageClient's pendingOrderRef.
  const pendingPreselectRef = useRef<string | null>(initialInvoiceId ?? null);

  function includeRow(row: OpenSupplierInvoiceRow) {
    setIncludedIds((prev) => new Set(prev).add(row.id));
    setAmounts((prev) => (prev[row.id] !== undefined ? prev : { ...prev, [row.id]: String(row.openAmount) }));
  }

  // Resolve ?invoice=<id>'s supplier once on mount — /open-supplier-invoices
  // is keyed by supplier, not invoice, so the invoice's own supplierId has to
  // be fetched first. Same "resolve then let the supplier-effect load rows"
  // pattern as the AR mirror's own preselect.
  useEffect(() => {
    if (!initialInvoiceId) return;
    apiFetch<{ supplierId: string }>(`/api/v1/supplier-invoices/${initialInvoiceId}`)
      .then((invoice) => setSupplierId(invoice.supplierId))
      .catch(() => {
        pendingPreselectRef.current = null;
        setError("Kunde inte hämta fakturan att förifylla");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the selected supplier's open items whenever the supplier changes.
  useEffect(() => {
    setRows([]);
    setIncludedIds(new Set());
    setAmounts({});
    if (!supplierId) return;
    let cancelled = false;
    setRowsLoading(true);
    apiFetch<Paged<OpenSupplierInvoiceRow>>(`/api/v1/open-supplier-invoices?supplierId=${supplierId}&limit=1000`)
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
  }, [supplierId]);

  function toggleRow(row: OpenSupplierInvoiceRow) {
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

  const includedRows = rows.filter((r) => includedIds.has(r.id));
  // Rounded PER ROW first, then summed — same order of operations the
  // server's own balance check uses (appliedTotal = round2(Σ round2(row)) in
  // supplier-payment.service.ts's create) — so "Summa" can never drift a cent
  // from what the POST below actually sends as `amount`.
  const roundedRows = includedRows.map((r) => ({
    supplierInvoiceId: r.id,
    appliedAmount: round2(Number(amounts[r.id]) || 0),
  }));
  const totalAmount = round2(roundedRows.reduce((sum, r) => sum + r.appliedAmount, 0));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!supplierId) {
      setError("Välj en leverantör");
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
      await apiFetch("/api/v1/supplier-payments", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
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
          <Field label="Leverantör" htmlFor="supplierPaymentSupplier">
            <Select
              id="supplierPaymentSupplier"
              value={supplierId}
              onChange={(e) => {
                pendingPreselectRef.current = null;
                setSupplierId(e.target.value);
              }}
            >
              <option value="">— Välj leverantör —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>

        {supplierId && rowsLoading && <p>Hämtar öppna poster…</p>}
        {supplierId && !rowsLoading && rows.length === 0 && <p>Leverantören har inga öppna poster.</p>}

        {rows.length > 0 && (
          <Table<OpenSupplierInvoiceRow>
            columns={[
              { key: "include", label: "", width: "36px" },
              { key: "registrationNumber", label: "Faktura", width: "110px" },
              { key: "invoiceNumber", label: "Fakturanr", width: "140px" },
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
                      aria-label={`Ta med ${row.registrationNumber}`}
                      checked={included}
                      onChange={() => toggleRow(row)}
                    />
                  );
                case "registrationNumber":
                  return (
                    <Link href={`/inkop/leverantorsfakturor/${row.id}`} className={listStyles.rowLink}>
                      {row.registrationNumber}
                    </Link>
                  );
                case "invoiceNumber":
                  return row.invoiceNumber;
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
                      aria-label={`Belopp — ${row.registrationNumber}`}
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
          <Field label="Betalkonto" htmlFor="supplierPaymentAccount">
            <Select
              id="supplierPaymentAccount"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
            >
              {accountOptionsWithCurrent(accounts, bankAccountNumber).map((a) => (
                <option key={a.number} value={a.number}>
                  {accountLabel(a)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Betalningsdatum" htmlFor="supplierPaymentDate">
            <Input
              id="supplierPaymentDate"
              type="date"
              size="sm"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>
          <Field label="Summa" htmlFor="supplierPaymentSum">
            <Input id="supplierPaymentSum" size="sm" value={`${formatMoney(totalAmount)} kr`} disabled />
          </Field>
        </FormRow>

        <Field label="Notering" htmlFor="supplierPaymentNote">
          <Input id="supplierPaymentNote" value={note} onChange={(e) => setNote(e.target.value)} />
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

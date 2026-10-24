"use client";

import { confirmDialog } from "../../lib/confirm";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { BookingFailures } from "./BookingFailures";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { useCan } from "../PermissionsProvider";
import { API_URL, apiFetch } from "../../lib/api";
import {
  describeCreditor,
  PAYMENT_BATCH_STATUS,
  PAYMENT_ITEM_STATUS,
  PAYMENT_KIND_LABELS,
  SENT_CHARGE_BEARER_LABELS,
} from "../../lib/banking";
import {
  currencyLabel,
  exchangeDifferenceText,
  formatRate,
  paymentExchangeDifference,
  releasedSek,
  SEK,
  toleranceInCurrency,
  toSek,
} from "../../lib/currency";
import { batchTotals, formatCurrencyAmounts, sumByCurrency } from "../../lib/currencyTotals";
import { stockholmToday } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { applyPaymentTolerance } from "../../lib/paymentTolerance";
import { useExchangeRateLookup } from "../../lib/useExchangeRate";
import type { BankItemResult, OpenSupplierInvoiceRow, Paged, PaymentBatchDetail, PaymentBatchItem, SupplierInvoiceDetail } from "../../lib/types";

// Owns the per-row booking results OUTSIDE the keyed body: act() refreshes the
// page, the key (batch.updatedAt) then remounts the body, and results held in
// the body would vanish with the very failures the user needs to read.
export function PaymentBatchCard({ batch, unverifiedBank, tolerance }: { batch: PaymentBatchDetail; unverifiedBank: boolean; tolerance: number }) {
  const [results, setResults] = useState<BankItemResult[] | null>(null);
  const failures = (results ?? [])
    .filter((r) => !r.ok && r.error)
    .map((r) => ({ key: r.itemId ?? "", label: batch.items.find((i) => i.id === r.itemId)?.endToEndId ?? "Post", error: r.error! }));
  return (
    <>
      <BookingFailures failures={failures} />
      <PaymentBatchCardBody key={batch.updatedAt} batch={batch} unverifiedBank={unverifiedBank} tolerance={tolerance} onResults={setResults} />
    </>
  );
}

function PaymentBatchCardBody({
  batch,
  unverifiedBank,
  tolerance,
  onResults,
}: {
  batch: PaymentBatchDetail;
  unverifiedBank: boolean;
  tolerance: number;
  onResults: (results: BankItemResult[] | null) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const writable = can(["inkop"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<PaymentBatchItem | null>(null);
  const [rejecting, setRejecting] = useState<PaymentBatchItem | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const status = PAYMENT_BATCH_STATUS[batch.status]!;
  const today = stockholmToday();
  const moved = batch.items.filter((i) => i.executionDate < today);
  const fileUrl = `${API_URL}/api/v1/payment-batches/${batch.id}/file`;
  const totals = batchTotals(batch);
  // Valuta steg 2: what the export would refuse, shown before the user tries
  // (a payee abroad without street/town, a bank that needs a debit IBAN …).
  const itemProblems = batch.items.filter((i) => i.problems.length > 0);
  const exportBlocked = batch.status === "draft" && (batch.problems.length > 0 || itemProblems.length > 0);
  const reported = batch.items.filter((i) => i.status !== "cancelled" && i.regulatoryReporting);

  async function act(path: string, init: RequestInit, after?: (body: unknown) => void) {
    setPending(true);
    setError(null);
    try {
      const body = await apiFetch<unknown>(`/api/v1/payment-batches/${batch.id}${path}`, init);
      after?.(body);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={status.pill} label={batch.status === "exported" ? `${status.label} · ${batch.confirmedCount} av ${batch.itemCount} bekräftade` : status.label} />
        <span>Poster: {batch.itemCount}</span>
        <span>Belopp: {formatCurrencyAmounts(totals)}</span>
        {batch.file && (
          <span title={batch.file.sha256}>
            Fil: <a href={fileUrl}>{batch.file.filename}</a> · {batch.file.sha256.slice(0, 12)}…
          </span>
        )}
      </div>
      {unverifiedBank && <FormNotice>SEB-profilen är inte verifierad mot SEB:s MIG — prova filen i SEB Test Bench innan första skarpa betalningen.</FormNotice>}
      {error && <FormError>{error}</FormError>}
      {exportBlocked && (
        <FormError>
          Betalfilen kan inte exporteras än:
          <ul>
            {batch.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
            {itemProblems.map((i) => (
              <li key={i.id}>
                {i.endToEndId} ({i.supplierName}): {i.problems.join("; ")}
              </li>
            ))}
          </ul>
        </FormError>
      )}

      {writable && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          {batch.status === "draft" && (
            <>
              <Button variant="secondary" onClick={() => setAddOpen(true)} disabled={pending}>Lägg till fakturor</Button>
              <Button
                onClick={() => setExportOpen(true)}
                disabled={pending || batch.items.length === 0 || exportBlocked}
                title={exportBlocked ? "Rätta problemen ovan först — banken skulle avvisa filen" : undefined}
              >
                Exportera betalfil
              </Button>
            </>
          )}
          {batch.status === "exported" && (
            <>
              <Button variant="secondary" onClick={() => { window.location.href = fileUrl; }}>Ladda ner fil</Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={pending}>Bekräfta utförd</Button>
              <GatedLink href="/inkop/bankfiler">Läs in bankfil</GatedLink>
            </>
          )}
          {(batch.status === "draft" || (batch.status === "exported" && !batch.items.some((i) => i.status === "confirmed" || i.status === "returned"))) && (
            <Button
              variant="danger"
              disabled={pending}
              onClick={async () => {
                const text =
                  batch.status === "exported"
                    ? "Kontrollera i internetbanken att filen inte har skickats — Nav kan inte stoppa en betalning som banken redan har tagit emot. Makulera omgången?"
                    : "Makulera omgången? Fakturorna blir fria igen.";
                if (await confirmDialog(text)) act("/cancel", { method: "POST" });
              }}
            >
              Makulera omgång
            </Button>
          )}
        </div>
      )}

      <SectionHeading spaced>Poster</SectionHeading>
      <Table<PaymentBatchItem>
        columns={[
          { key: "endToEndId", label: "Post", width: "100px" },
          { key: "invoice", label: "Faktura", width: "1fr" },
          { key: "creditor", label: "Betalsätt", width: "1.2fr" },
          { key: "kind", label: "Typ", width: "120px" },
          { key: "reference", label: "Referens", width: "1fr" },
          { key: "executionDate", label: "Betalningsdag", width: "120px" },
          { key: "amount", label: "Belopp", width: "130px", align: "right" },
          { key: "status", label: "Status", width: "130px" },
          { key: "actions", label: "", width: "180px" },
        ]}
        rows={batch.items}
        emptyText="Omgången har inga poster"
        renderCell={(item, key) => {
          switch (key) {
            case "endToEndId":
              return item.endToEndId;
            case "invoice":
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <GatedLink href={`/inkop/leverantorsfakturor/${item.supplierInvoiceId}`}>{item.registrationNumber}</GatedLink>
                  <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{item.supplierName}</span>
                  {item.warnings.map((w) => (
                    <span key={w} style={{ fontSize: 12, color: "var(--status-delayed-text)" }}>{w}</span>
                  ))}
                  {item.problems.map((p) => (
                    <span key={p} style={{ fontSize: 12, color: "var(--status-stopped-text)" }}>{p}</span>
                  ))}
                </span>
              );
            case "creditor": {
              if (!item.creditor) return "Saknar betalningsuppgifter";
              const c = item.creditor;
              const abroad = c.kind !== undefined && c.kind !== "domestic";
              const where = [c.country, c.bankName].filter(Boolean).join(" · ");
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <span>{describeCreditor(c)}</span>
                  {abroad && where && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{where}</span>}
                  {abroad && c.chargeBearer && (
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{SENT_CHARGE_BEARER_LABELS[c.chargeBearer]}</span>
                  )}
                </span>
              );
            }
            case "kind": {
              if (!item.paymentKind) return "–";
              const ku81 = item.regulatoryReporting;
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <span>{PAYMENT_KIND_LABELS[item.paymentKind]}{item.currency !== SEK ? ` · ${item.currency}` : ""}</span>
                  {ku81 && (
                    <span style={{ fontSize: 12, color: "var(--status-delayed-text)" }}>
                      Rapporteras till Skatteverket, kod {ku81.code}
                      {ku81.amountSek !== null && ` (motvärde ${formatMoney(ku81.amountSek)} kr)`}
                    </span>
                  )}
                  {ku81?.rateMissing && (
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      Kursen för {item.currency} saknades, så betalningen rapporteras för säkerhets skull.
                    </span>
                  )}
                </span>
              );
            }
            case "reference":
              return item.creditor ? `${item.creditor.referenceKind === "ocr" ? "OCR" : "Meddelande"} ${item.creditor.reference || `(Faktura ${item.invoiceNumber})`}` : "–";
            case "executionDate":
              return item.executionDate;
            case "amount":
              return `${formatMoney(item.amount)} ${currencyLabel(item.currency)}`;
            case "status": {
              const s = PAYMENT_ITEM_STATUS[item.status]!;
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <StatusPill status={s.pill} label={s.label} compact />
                  {item.payment && <GatedLink href={`/inkop/betalningar/${item.payment.id}`}>{item.payment.paymentNumber}</GatedLink>}
                  {item.rejectedReason && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{item.rejectedReason}</span>}
                </span>
              );
            }
            case "actions":
              if (!writable) return null;
              if (batch.status === "draft") {
                return (
                  <span style={{ display: "flex", gap: 8 }}>
                    <Button size="small" variant="secondary" onClick={() => setEditing(item)}>Ändra</Button>
                    <Button size="small" variant="ghost" onClick={() => act(`/items/${item.id}`, { method: "DELETE" })}>Ta bort</Button>
                  </span>
                );
              }
              if (batch.status === "exported" && item.status === "exported") {
                return <Button size="small" variant="ghost" onClick={() => setRejecting(item)}>Markera som avvisad</Button>;
              }
              return null;
            default:
              return null;
          }
        }}
      />

      {editing && (
        <ItemEditModal
          key={editing.id}
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => act(`/items/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) }, () => setEditing(null))}
        />
      )}
      {rejecting && (
        <ReasonModal
          key={rejecting.id}
          title={`Markera ${rejecting.endToEndId} som avvisad`}
          label="Orsak"
          onClose={() => setRejecting(null)}
          onSave={(reason) => act(`/items/${rejecting.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }, () => setRejecting(null))}
        />
      )}
      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title={`Exportera ${batch.batchNumber}`}>
        <p>
          {batch.itemCount} betalningar · {formatCurrencyAmounts(totals)}. Filen laddas ner — ladda upp den i internetbanken och attestera där.
        </p>
        {reported.length > 0 && (
          <FormNotice>
            {reported.length === 1 ? "1 betalning rapporteras" : `${reported.length} betalningar rapporteras`} till Skatteverket (KU81) med betalningskod:{" "}
            {reported.map((i) => `${i.endToEndId} (kod ${i.regulatoryReporting!.code})`).join(", ")}.
          </FormNotice>
        )}
        {moved.length > 0 && <FormNotice>Betalningsdagen har passerat för {moved.map((m) => m.endToEndId).join(", ")} och flyttas till idag ({today}).</FormNotice>}
        <FormActions>
          <Button
            onClick={() => {
              // Closed first: a refusal (e.g. the bank's rules) is shown on the card.
              setExportOpen(false);
              act("/export", { method: "POST" }, () => {
                window.location.href = fileUrl;
              });
            }}
            disabled={pending}
          >
            Exportera betalfil
          </Button>
        </FormActions>
      </Modal>
      {confirmOpen && (
        <ConfirmModal
          batch={batch}
          tolerance={tolerance}
          onClose={() => setConfirmOpen(false)}
          onConfirm={(paymentDate, itemIds, amounts) => {
            onResults(null);
            // Closed first: a refusal is shown on the card, not behind the dialog.
            setConfirmOpen(false);
            act("/confirm", { method: "POST", body: JSON.stringify({ paymentDate, itemIds, ...(amounts.length > 0 ? { amounts } : {}) }) }, (body) => {
              onResults((body as { results: BankItemResult[] }).results);
            });
          }}
        />
      )}
      {addOpen && <AddInvoicesModal batchId={batch.id} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); router.refresh(); }} />}

      <AuditTrailSection entityType="payment_batch" entityId={batch.batchNumber} />
    </>
  );
}

function ItemEditModal({ item, onClose, onSave }: { item: PaymentBatchItem; onClose: () => void; onSave: (body: { amount: number; executionDate: string }) => void }) {
  const [amount, setAmount] = useState(String(item.amount));
  const [date, setDate] = useState(item.executionDate);
  return (
    <Modal open onClose={onClose} title={`Ändra ${item.endToEndId}`}>
      <Form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSave({ amount: Number(amount), executionDate: date });
        }}
      >
        <Field label={item.currency === SEK ? "Belopp" : `Belopp (${item.currency})`} htmlFor="itemAmount">
          <Input id="itemAmount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Betalningsdag" htmlFor="itemDate">
          <Input id="itemDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <FormActions>
          <Button type="submit">Spara</Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

function ReasonModal({ title, label, onClose, onSave }: { title: string; label: string; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open onClose={onClose} title={title}>
      <Form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (reason.trim()) onSave(reason.trim());
        }}
      >
        <Field label={label} htmlFor="reason">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
        </Field>
        <FormActions>
          <Button type="submit" disabled={!reason.trim()}>Spara</Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

// The rows the bank has paid by `date`: those whose execution date has come.
// None yet (an early confirmation) ⇒ every waiting row, as before.
function dueBy(waiting: PaymentBatchItem[], date: string): Set<string> {
  const due = waiting.filter((i) => i.executionDate <= date);
  return new Set((due.length > 0 ? due : waiting).map((i) => i.id));
}

// What a payment in another currency is judged on when it is confirmed: the SEK
// that left the account (from the account statement) and the bank's fee.
interface SekEntry {
  amountSek: string;
  bankFee: string;
  // Typed in by hand: the prefill from the rate never overwrites it again.
  touched: boolean;
}

function parseAmount(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// The kursdifferens a foreign row will book, with the same arithmetic as the
// API and as Registrera betalning (lib/currency.ts): the SEK that left the
// account, less the fee, less the SEK the payment releases from the invoice's
// booked debt. Positive gain = kursvinst. null = not enough to tell.
function exchangePreview(
  item: PaymentBatchItem,
  invoice: SupplierInvoiceDetail | undefined,
  tolerance: number,
  amountSek: number,
  bankFee: number
): { gain: number; bookedDebt: number } | null {
  if (!invoice) return null;
  const rate = Number(invoice.exchangeRate);
  const gross = Number(invoice.grossAmount);
  const grossSek = invoice.grossAmountSek !== null ? Number(invoice.grossAmountSek) : toSek(gross, rate);
  const result = applyPaymentTolerance(invoice.openAmount, item.amount, toleranceInCurrency(tolerance, rate, item.currency));
  if (!result.ok) return null;
  const part = releasedSek({
    currency: item.currency,
    grossAmount: gross,
    grossAmountSek: grossSek,
    previouslyReleasedSek: invoice.openAmountSek === null ? 0 : round2(grossSek - invoice.openAmountSek),
    appliedAmount: item.amount,
    writeOffAmount: result.writeOffAmount,
    settles: result.settles,
  });
  const difference = paymentExchangeDifference({ amountSek, bankFeeSek: bankFee, appliedAmountsSek: [part.appliedAmountSek] });
  return { gain: difference === 0 ? 0 : -difference, bookedDebt: round2(part.appliedAmountSek + part.writeOffAmountSek) };
}

// Belopp i SEK + Bankavgift for one foreign row of Bekräfta utförd. The SEK
// amount follows the rate for the payment date until it is typed in (manuellt
// vinner) — but it is the account statement's figure that should stand.
function ForeignSekFields({
  item,
  date,
  entry,
  invoice,
  tolerance,
  onPrefill,
  onChange,
}: {
  item: PaymentBatchItem;
  date: string;
  entry: SekEntry | undefined;
  invoice: SupplierInvoiceDetail | undefined;
  tolerance: number;
  onPrefill: (itemId: string, amountSek: string) => void;
  onChange: (itemId: string, entry: SekEntry) => void;
}) {
  const lookup = useExchangeRateLookup(item.currency, date);
  const touched = entry?.touched ?? false;
  useEffect(() => {
    if (touched) return;
    if (lookup.status === "ok") onPrefill(item.id, String(toSek(item.amount, lookup.lookup.rate)));
    else if (lookup.status === "error") onPrefill(item.id, "");
  }, [lookup, touched, item.id, item.amount, onPrefill]);

  const amountSek = entry?.amountSek ?? "";
  const bankFee = entry?.bankFee ?? "";
  const sek = parseAmount(amountSek);
  const fee = bankFee.trim() === "" ? 0 : parseAmount(bankFee);
  const preview = sek !== null && sek > 0 && fee !== null && fee >= 0 ? exchangePreview(item, invoice, tolerance, sek, fee) : null;
  const set = (patch: Partial<SekEntry>) => onChange(item.id, { amountSek, bankFee, touched: true, ...patch });

  return (
    <div style={{ marginLeft: 28, display: "flex", flexDirection: "column", gap: 8 }}>
      <FormRow>
        <Field label={`Belopp i SEK (draget från kontot) — ${formatMoney(item.amount)} ${item.currency}`} htmlFor={`sek-${item.id}`}>
          <Input
            id={`sek-${item.id}`}
            type="number"
            step="0.01"
            size="sm"
            value={amountSek}
            onChange={(e) => set({ amountSek: e.target.value })}
          />
        </Field>
        <Field label="Bankavgift" htmlFor={`fee-${item.id}`}>
          <Input
            id={`fee-${item.id}`}
            type="number"
            min="0"
            step="0.01"
            size="sm"
            value={bankFee}
            onChange={(e) => set({ bankFee: e.target.value, amountSek, touched })}
          />
        </Field>
      </FormRow>
      <FormHint>
        Skriv av beloppet från kontoutdraget; avgiften ingår i det och bokförs som bankkostnad.
        {lookup.status === "ok" && !touched && ` Förifyllt med kursen ${formatRate(lookup.lookup.rate)} för ${lookup.lookup.date}.`}
      </FormHint>
      {lookup.status === "error" && !touched && <FormNotice>{lookup.message}</FormNotice>}
      {sek !== null && fee !== null && fee > sek && <FormError>Bankavgiften kan inte vara större än beloppet i SEK.</FormError>}
      {preview && (
        <FormHint>
          Avräknas mot skulden: {formatMoney(preview.bookedDebt)} kr (bokfört värde).{" "}
          <strong
            style={{
              color:
                preview.gain > 0
                  ? "var(--status-running-text)"
                  : preview.gain < 0
                    ? "var(--status-stopped-text)"
                    : "var(--color-text-secondary)",
            }}
          >
            {exchangeDifferenceText(preview.gain, formatMoney)}
          </strong>
          {preview.gain !== 0 && " bokförs på kursdifferenskontot."}
        </FormHint>
      )}
    </div>
  );
}

function ConfirmModal({
  batch,
  tolerance,
  onClose,
  onConfirm,
}: {
  batch: PaymentBatchDetail;
  tolerance: number;
  onClose: () => void;
  onConfirm: (paymentDate: string, itemIds: string[], amounts: { itemId: string; amountSek: number; bankFeeSek: number }[]) => void;
}) {
  const today = stockholmToday();
  const [date, setDate] = useState(today);
  const waiting = batch.items.filter((i) => i.status === "exported");
  // Follows the date until the user picks rows by hand; then the hand wins.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? dueBy(waiting, date);
  const early = waiting.filter((i) => chosen.has(i.id) && date < i.executionDate);
  const chosenItems = waiting.filter((i) => chosen.has(i.id));
  const totals = sumByCurrency(chosenItems, (i) => ({ currency: i.currency, amount: i.amount }));
  // Valuta steg 2: a row in another currency than SEK needs what the bank drew
  // in SEK. State lives here (not in the row) so a row that is unticked and
  // ticked again keeps what was typed.
  const [sek, setSek] = useState<Record<string, SekEntry>>({});
  const onChange = useCallback((itemId: string, entry: SekEntry) => setSek((prev) => ({ ...prev, [itemId]: entry })), []);
  const onPrefill = useCallback(
    (itemId: string, amountSek: string) =>
      setSek((prev) => {
        const existing = prev[itemId];
        if (existing?.touched || existing?.amountSek === amountSek || (!existing && amountSek === "")) return prev;
        return { ...prev, [itemId]: { amountSek, bankFee: existing?.bankFee ?? "", touched: false } };
      }),
    []
  );
  // The invoices behind the foreign rows — for the kursdifferens preview only.
  const [invoices, setInvoices] = useState<Record<string, SupplierInvoiceDetail>>({});
  const foreignWaiting = waiting.filter((i) => i.currency !== SEK);
  useEffect(() => {
    let cancelled = false;
    for (const item of foreignWaiting) {
      apiFetch<SupplierInvoiceDetail>(`/api/v1/supplier-invoices/${item.supplierInvoiceId}`)
        .then((invoice) => {
          if (!cancelled) setInvoices((prev) => ({ ...prev, [item.supplierInvoiceId]: invoice }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosenForeign = chosenItems.filter((i) => i.currency !== SEK);
  const sekProblem = chosenForeign.some((i) => {
    const amount = parseAmount(sek[i.id]?.amountSek);
    const feeText = sek[i.id]?.bankFee ?? "";
    const fee = feeText.trim() === "" ? 0 : parseAmount(feeText);
    return amount === null || amount <= 0 || fee === null || fee < 0 || fee > amount;
  });
  return (
    <Modal open onClose={onClose} title="Bekräfta utförd" wide>
      <p>
        {chosen.size} av {waiting.length} betalningar ({formatCurrencyAmounts(totals)}) bokförs som utbetalda den valda dagen (serie U). Bocka ur de betalningar som banken inte har genomfört.
      </p>
      <Field label="Betalningsdag" htmlFor="confirmDate">
        <Input id="confirmDate" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {batch.exportedAt && date < batch.exportedAt.slice(0, 10) && <FormNotice>Datumet ligger före exportdagen.</FormNotice>}
      {early.length > 0 && (
        <FormNotice>Datumet ligger före betalningsdagen i filen för {early.map((i) => `${i.endToEndId} (${i.executionDate})`).join(", ")}.</FormNotice>
      )}
      {foreignWaiting.length > 0 && (
        <FormHint>
          Betalningar i utländsk valuta bokförs i SEK: ange beloppet som banken drog från kontot (och bankens avgift). Skillnaden mot skuldens bokförda värde bokförs som kursdifferens.
        </FormHint>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" }}>
        {waiting.map((i) => (
          <div key={i.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Checkbox
                checked={chosen.has(i.id)}
                onChange={() => {
                  const next = new Set(chosen);
                  if (next.has(i.id)) next.delete(i.id);
                  else next.add(i.id);
                  setPicked(next);
                }}
              />
              {i.endToEndId} · {i.registrationNumber} · {i.supplierName} · {formatMoney(i.amount)} {currencyLabel(i.currency)} · betalningsdag {i.executionDate}
            </label>
            {chosen.has(i.id) && i.currency !== SEK && (
              <ForeignSekFields
                item={i}
                date={date}
                entry={sek[i.id]}
                invoice={invoices[i.supplierInvoiceId]}
                tolerance={tolerance}
                onPrefill={onPrefill}
                onChange={onChange}
              />
            )}
          </div>
        ))}
      </div>
      {sekProblem && <FormHint>Ange Belopp i SEK för varje vald betalning i utländsk valuta.</FormHint>}
      <FormActions>
        <Button
          onClick={() =>
            onConfirm(
              date,
              chosenItems.map((i) => i.id),
              chosenForeign.map((i) => ({
                itemId: i.id,
                amountSek: round2(parseAmount(sek[i.id]?.amountSek) ?? 0),
                bankFeeSek: round2(parseAmount(sek[i.id]?.bankFee) ?? 0),
              }))
            )
          }
          disabled={date > today || chosen.size === 0 || sekProblem}
        >
          Bekräfta utförd
        </Button>
      </FormActions>
    </Modal>
  );
}

function AddInvoicesModal({ batchId, onClose, onAdded }: { batchId: string; onClose: () => void; onAdded: () => void }) {
  const [rows, setRows] = useState<OpenSupplierInvoiceRow[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<Paged<OpenSupplierInvoiceRow>>("/api/v1/open-supplier-invoices?limit=200")
      .then((page) => {
        if (cancelled) return;
        // Valuta steg 2: an invoice in any currency, to an account in any
        // country, can go in a batch — the draft shows what a payment abroad
        // still lacks.
        setRows(page.rows.filter((r) => !r.paymentBatch && r.openAmount > 0 && r.supplierPaymentMethod));
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Öppna poster kunde inte hämtas."));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <Modal open onClose={onClose} title="Lägg till fakturor" wide>
      {error && <FormError>{error}</FormError>}
      {rows?.length === 0 && <p>Inga fler betalbara öppna poster.</p>}
      {rows?.map((r) => (
        <label key={r.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Checkbox
            checked={chosen.has(r.id)}
            onChange={() =>
              setChosen((c) => {
                const next = new Set(c);
                if (next.has(r.id)) next.delete(r.id);
                else next.add(r.id);
                return next;
              })
            }
          />
          {r.registrationNumber} · {r.supplierName} · {formatMoney(r.openAmount)} {currencyLabel(r.currency)} · förfaller {r.dueDate ?? "–"}
        </label>
      ))}
      <FormActions>
        <Button
          disabled={chosen.size === 0}
          onClick={async () => {
            try {
              await apiFetch(`/api/v1/payment-batches/${batchId}/items`, { method: "POST", body: JSON.stringify({ invoiceIds: [...chosen] }) });
              onAdded();
            } catch (err) {
              setError(apiErrorMessage(err, "Fakturorna kunde inte läggas till."));
            }
          }}
        >
          Lägg till
        </Button>
      </FormActions>
    </Modal>
  );
}

"use client";

import { confirmDialog } from "../../lib/confirm";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { BookingFailures } from "./BookingFailures";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { useCan } from "../PermissionsProvider";
import { API_URL, apiFetch } from "../../lib/api";
import { describeCreditor, PAYMENT_BATCH_STATUS, PAYMENT_ITEM_STATUS } from "../../lib/banking";
import { stockholmToday } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type { BankItemResult, OpenSupplierInvoiceRow, Paged, PaymentBatchDetail, PaymentBatchItem } from "../../lib/types";

// Owns the per-row booking results OUTSIDE the keyed body: act() refreshes the
// page, the key (batch.updatedAt) then remounts the body, and results held in
// the body would vanish with the very failures the user needs to read.
export function PaymentBatchCard({ batch, unverifiedBank }: { batch: PaymentBatchDetail; unverifiedBank: boolean }) {
  const [results, setResults] = useState<BankItemResult[] | null>(null);
  const failures = (results ?? [])
    .filter((r) => !r.ok && r.error)
    .map((r) => ({ key: r.itemId ?? "", label: batch.items.find((i) => i.id === r.itemId)?.endToEndId ?? "Post", error: r.error! }));
  return (
    <>
      <BookingFailures failures={failures} />
      <PaymentBatchCardBody key={batch.updatedAt} batch={batch} unverifiedBank={unverifiedBank} onResults={setResults} />
    </>
  );
}

function PaymentBatchCardBody({
  batch,
  unverifiedBank,
  onResults,
}: {
  batch: PaymentBatchDetail;
  unverifiedBank: boolean;
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
        <span>Belopp: {formatMoney(batch.totalAmount)} kr</span>
        {batch.file && (
          <span title={batch.file.sha256}>
            Fil: <a href={fileUrl}>{batch.file.filename}</a> · {batch.file.sha256.slice(0, 12)}…
          </span>
        )}
      </div>
      {unverifiedBank && <FormNotice>SEB-profilen är inte verifierad mot SEB:s MIG — prova filen i SEB Test Bench innan första skarpa betalningen.</FormNotice>}
      {error && <FormError>{error}</FormError>}

      {writable && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          {batch.status === "draft" && (
            <>
              <Button variant="secondary" onClick={() => setAddOpen(true)} disabled={pending}>Lägg till fakturor</Button>
              <Button onClick={() => setExportOpen(true)} disabled={pending || batch.items.length === 0}>Exportera betalfil</Button>
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
          { key: "reference", label: "Referens", width: "1fr" },
          { key: "executionDate", label: "Betalningsdag", width: "120px" },
          { key: "amount", label: "Belopp", width: "120px", align: "right" },
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
                </span>
              );
            case "creditor":
              return item.creditor ? describeCreditor(item.creditor) : "Saknar betalningsuppgifter";
            case "reference":
              return item.creditor ? `${item.creditor.referenceKind === "ocr" ? "OCR" : "Meddelande"} ${item.creditor.reference || `(Faktura ${item.invoiceNumber})`}` : "–";
            case "executionDate":
              return item.executionDate;
            case "amount":
              return `${formatMoney(item.amount)} kr`;
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
          {batch.itemCount} betalningar · {formatMoney(batch.totalAmount)} kr. Filen laddas ner — ladda upp den i internetbanken och attestera där.
        </p>
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
          onClose={() => setConfirmOpen(false)}
          onConfirm={(paymentDate, itemIds) => {
            onResults(null);
            // Closed first: a refusal is shown on the card, not behind the dialog.
            setConfirmOpen(false);
            act("/confirm", { method: "POST", body: JSON.stringify({ paymentDate, itemIds }) }, (body) => {
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
        <Field label="Belopp" htmlFor="itemAmount">
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

function ConfirmModal({ batch, onClose, onConfirm }: { batch: PaymentBatchDetail; onClose: () => void; onConfirm: (paymentDate: string, itemIds: string[]) => void }) {
  const today = stockholmToday();
  const [date, setDate] = useState(today);
  const waiting = batch.items.filter((i) => i.status === "exported");
  // Follows the date until the user picks rows by hand; then the hand wins.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? dueBy(waiting, date);
  const early = waiting.filter((i) => chosen.has(i.id) && date < i.executionDate);
  const total = waiting.filter((i) => chosen.has(i.id)).reduce((sum, i) => sum + i.amount, 0);
  return (
    <Modal open onClose={onClose} title="Bekräfta utförd" wide>
      <p>
        {chosen.size} av {waiting.length} betalningar ({formatMoney(total)} kr) bokförs som utbetalda den valda dagen (serie U). Bocka ur de betalningar som banken inte har genomfört.
      </p>
      <Field label="Betalningsdag" htmlFor="confirmDate">
        <Input id="confirmDate" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {batch.exportedAt && date < batch.exportedAt.slice(0, 10) && <FormNotice>Datumet ligger före exportdagen.</FormNotice>}
      {early.length > 0 && (
        <FormNotice>Datumet ligger före betalningsdagen i filen för {early.map((i) => `${i.endToEndId} (${i.executionDate})`).join(", ")}.</FormNotice>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "12px 0" }}>
        {waiting.map((i) => (
          <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Checkbox
              checked={chosen.has(i.id)}
              onChange={() => {
                const next = new Set(chosen);
                if (next.has(i.id)) next.delete(i.id);
                else next.add(i.id);
                setPicked(next);
              }}
            />
            {i.endToEndId} · {i.registrationNumber} · {i.supplierName} · {formatMoney(i.amount)} kr · betalningsdag {i.executionDate}
          </label>
        ))}
      </div>
      <FormActions>
        <Button onClick={() => onConfirm(date, waiting.filter((i) => chosen.has(i.id)).map((i) => i.id))} disabled={date > today || chosen.size === 0}>
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
        if (!cancelled) setRows(page.rows.filter((r) => !r.paymentBatch && r.openAmount > 0 && r.supplierPaymentMethod));
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
          {r.registrationNumber} · {r.supplierName} · {formatMoney(r.openAmount)} kr · förfaller {r.dueDate ?? "–"}
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

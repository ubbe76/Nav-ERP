"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Input, Select } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import { useCan } from "../PermissionsProvider";
import { API_URL, apiFetch } from "../../lib/api";
import { INCOMING_STATE } from "../../lib/banking";
import { apiErrorMessage } from "../../lib/errorMessages";
import { currencyLabel, formatRate, SEK, toleranceInCurrency } from "../../lib/currency";
import { formatMoney } from "../../lib/format";
import { paymentPreview, PREVIEW_TONE_COLOR, round2 } from "../../lib/paymentTolerance";
import type { BankFileDetail, BankItemResult, Customer, IncomingEntryView, OpenInvoiceRow, Paged } from "../../lib/types";
import { BankEntryIgnoreButton } from "./BankEntryIgnoreButton";
import { BookingFailures } from "./BookingFailures";

type Draft = { customerId: string; rows: { invoiceId: string; invoiceNumber: string; openAmount: number; applied: string }[] };

const BASIS_TEXT: Record<string, string> = {
  ocr: "OCR",
  amount_name: "Förslag: belopp + namn",
  amount_only: "Förslag: endast belopp",
  name_allocation: "Förslag: namn — fördelning",
};

const EDITABLE = new Set(["matched", "suggested", "unmatched"]);

// Valuta steg 3: an entry on the SEK account whose payer instructed another
// currency (InstdAmt in EUR) is a payment in that currency — it is matched
// against open items in it, allocated in it, and booked with the entry's own
// SEK amount (what reached the account) and the charges the bank reports.
const paidAmount = (e: IncomingEntryView) => (e.instructedAmount !== null && e.instructedCurrency ? e.instructedAmount : e.amount);
const paidCurrency = (e: IncomingEntryView) => (e.instructedAmount !== null && e.instructedCurrency ? e.instructedCurrency : e.currency);
const isForeignPayment = (e: IncomingEntryView) => paidCurrency(e) !== e.currency;

function initialDraft(entry: IncomingEntryView): Draft {
  const p = entry.proposal;
  return {
    customerId: p?.customerId ?? "",
    rows: (p?.rows ?? []).map((r) => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, openAmount: r.openAmount, applied: String(r.appliedAmount) })),
  };
}

// Owns the per-row booking results OUTSIDE the keyed body: booking refreshes
// the page, the entries' states then change the key and remount the body, and
// results held there would vanish together with the failures the user must read.
export function IncomingBankFileCard(props: { file: BankFileDetail; entries: IncomingEntryView[]; customers: Customer[]; tolerance: number }) {
  const [results, setResults] = useState<BankItemResult[] | null>(null);
  const failures = (results ?? [])
    .filter((r) => !r.ok && r.error)
    .map((r) => {
      const entry = props.entries.find((e) => e.id === r.entryId);
      return {
        key: r.entryId ?? "",
        label: entry ? `${formatMoney(entry.amount)} kr ${entry.counterpartyName ?? ""}`.trim() : "Post",
        error: r.error!,
      };
    });
  return (
    <>
      <BookingFailures failures={failures} />
      <IncomingBankFileBody key={props.entries.map((e) => e.state).join()} {...props} onResults={setResults} />
    </>
  );
}

function IncomingBankFileBody({
  file,
  entries,
  customers,
  tolerance,
  onResults,
}: {
  file: BankFileDetail;
  entries: IncomingEntryView[];
  customers: Customer[];
  tolerance: number;
  onResults: (results: BankItemResult[] | null) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const writable = can(["forsaljning"]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(entries.map((e) => [e.id, initialDraft(e)])));
  const [chosen, setChosen] = useState<Set<string>>(new Set(entries.filter((e) => e.state === "matched").map((e) => e.id)));
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const allocated = (id: string) => round2((drafts[id]?.rows ?? []).reduce((sum, r) => sum + (Number(r.applied) || 0), 0));

  function setDraft(id: string, draft: Draft) {
    setDrafts((d) => ({ ...d, [id]: draft }));
  }

  const bookable = (e: IncomingEntryView) =>
    EDITABLE.has(e.state) && drafts[e.id]!.customerId !== "" && drafts[e.id]!.rows.length > 0 && allocated(e.id) === round2(paidAmount(e));
  // A chosen entry whose allocation stops adding up (or that changes state)
  // is skipped, never a lock on the others: only chosen ∩ bookable is sent,
  // and its checkbox stays enabled so it can be unchecked.
  const toBook = entries.filter((e) => chosen.has(e.id) && bookable(e));

  async function book() {
    if (pending) return;
    setPending(true);
    setError(null);
    onResults(null);
    try {
      const body = await apiFetch<{ results: BankItemResult[] }>(`/api/v1/bank-files/${file.id}/incoming/book`, {
        method: "POST",
        body: JSON.stringify({
          entries: toBook.map((e) => ({
            entryId: e.id,
            customerId: drafts[e.id]!.customerId,
            rows: drafts[e.id]!.rows.filter((r) => Number(r.applied) !== 0).map((r) => ({ invoiceId: r.invoiceId, appliedAmount: Number(r.applied) })),
          })),
        }),
      });
      onResults(body.results);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Bokföringen misslyckades."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
        <span>Fil: <a href={`${API_URL}/api/v1/bank-files/${file.id}/download`}>{file.filename}</a></span>
        <span>Bankens meddelande: {file.bankMessageId ?? "–"}</span>
        {file.accounts.length > 0 && <span>Konto: {file.accounts.join(", ")}</span>}
        <span>Poster: {entries.length}</span>
        {file.skippedDuplicates > 0 && <span>{file.skippedDuplicates} redan inlästa poster hoppades över</span>}
      </div>
      {file.accountWarning && <FormNotice>{file.accountWarning}</FormNotice>}
      {file.warnings.map((w) => <FormNotice key={w}>{w}</FormNotice>)}
      {error && <FormError>{error}</FormError>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {entries.map((e) => {
          const s = INCOMING_STATE[e.state]!;
          const draft = drafts[e.id]!;
          const editable = writable && EDITABLE.has(e.state);
          return (
            <div key={e.id} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-card)", padding: 12 }}>
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                {editable && (
                  <Checkbox
                    aria-label="Bokför posten"
                    checked={chosen.has(e.id)}
                    disabled={!chosen.has(e.id) && !bookable(e)}
                    onChange={() =>
                      setChosen((c) => {
                        const next = new Set(c);
                        if (next.has(e.id)) next.delete(e.id);
                        else next.add(e.id);
                        return next;
                      })
                    }
                  />
                )}
                {isForeignPayment(e) ? (
                  // Another currency than the account's: the amount the payer
                  // instructed, then what reached the account in SEK with the
                  // bank's rate and charges.
                  <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                    <strong>
                      {formatMoney(paidAmount(e))} {paidCurrency(e)}
                    </strong>
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {formatMoney(e.amount)} kr insatt på kontot
                    </span>
                    {e.currencyExchange && (
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                        Bankens kurs {formatRate(e.currencyExchange.rate)}
                        {e.currencyExchange.targetCurrency
                          ? ` (${e.currencyExchange.sourceCurrency}→${e.currencyExchange.targetCurrency})`
                          : ""}
                      </span>
                    )}
                    {e.chargesAmount !== null && (
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                        varav avgifter {formatMoney(e.chargesAmount)} kr
                      </span>
                    )}
                  </span>
                ) : (
                  <strong>{formatMoney(e.amount)} kr</strong>
                )}
                <span>{e.bookingDate}</span>
                <span>{e.counterpartyName ?? "Okänd betalare"}</span>
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {e.remittance.map((r) => `${r.type === "USTRD" ? "" : `${r.type} `}${r.value}`).join(" · ") || "Ingen referens"}
                </span>
                <StatusPill status={s.pill} label={e.proposal?.partial ? `${s.label} · delbetalning` : s.label} compact />
                {e.proposal?.basis && e.state !== "matched" && <span>{BASIS_TEXT[e.proposal.basis]}</span>}
                {e.payment && <GatedLink href={`/forsaljning/betalningar/${e.payment.id}`}>{e.payment.paymentNumber}</GatedLink>}
                {editable && (
                  <Button size="small" variant="ghost" onClick={() => setOpenEditor(openEditor === e.id ? null : e.id)}>
                    {openEditor === e.id ? "Stäng" : "Fördelning"}
                  </Button>
                )}
                {writable && e.state !== "booked" && <BankEntryIgnoreButton fileId={file.id} direction="incoming" entryId={e.id} ignored={e.state === "ignored"} />}
              </div>
              {editable && chosen.has(e.id) && !bookable(e) && (
                <div style={{ fontSize: 13, color: "var(--status-delayed-text)" }}>Fördelningen stämmer inte med beloppet — posten bokförs inte förrän den gör det.</div>
              )}
              {e.proposal?.reason && <div style={{ fontSize: 13, color: "var(--status-delayed-text)" }}>{e.proposal.reason}</div>}
              {editable && isForeignPayment(e) && (
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
                  Betalningen är i {paidCurrency(e)}: den bokförs mot fakturor i {paidCurrency(e)} med {formatMoney(e.amount)} kr
                  som SEK-värde
                  {e.chargesAmount !== null
                    ? ` och bankavgiften ${formatMoney(e.chargesAmount)} kr som bankkostnad. Resten är kursvinst eller kursförlust.`
                    : ". Banken anger ingen avgift — en eventuell avgift hamnar i kursdifferensen."}
                </div>
              )}
              {e.warning && <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{e.warning}</div>}
              {e.ignoreReason && <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{e.ignoreReason}</div>}
              {openEditor === e.id && (
                <AllocationEditor
                  key={e.id}
                  entry={e}
                  draft={draft}
                  customers={customers}
                  tolerance={tolerance}
                  allocated={allocated(e.id)}
                  onChange={(d) => setDraft(e.id, d)}
                />
              )}
            </div>
          );
        })}
        {entries.length === 0 && <div style={{ color: "var(--color-text-secondary)" }}>Filen har inga inbetalningar</div>}
      </div>

      {writable && (
        <div style={{ marginTop: 16 }}>
          <Button onClick={book} disabled={pending || toBook.length === 0}>
            Bokför valda
          </Button>
        </div>
      )}
    </>
  );
}

function AllocationEditor({
  entry,
  draft,
  customers,
  tolerance,
  allocated,
  onChange,
}: {
  entry: IncomingEntryView;
  draft: Draft;
  customers: Customer[];
  tolerance: number;
  allocated: number;
  onChange: (draft: Draft) => void;
}) {
  const [open, setOpen] = useState<OpenInvoiceRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!draft.customerId) {
      setOpen([]);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    apiFetch<Paged<OpenInvoiceRow>>(`/api/v1/open-invoices?customerId=${draft.customerId}&limit=200`)
      .then((page) => {
        if (!cancelled) setOpen(page.rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(apiErrorMessage(err, "Kunde inte hämta kundens öppna poster."));
      });
    return () => {
      cancelled = true;
    };
  }, [draft.customerId]);

  const inDraft = new Set(draft.rows.map((r) => r.invoiceId));
  const currency = paidCurrency(entry);
  const paid = paidAmount(entry);
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <Select value={draft.customerId} onChange={(ev) => onChange({ customerId: ev.target.value, rows: [] })} aria-label="Kund">
        <option value="">Välj kund</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {loadError && <FormError>{loadError}</FormError>}
      {open.map((invoice) => {
        const row = draft.rows.find((r) => r.invoiceId === invoice.id);
        const preview = row
          ? paymentPreview(
              invoice.openAmount,
              row.applied,
              // The tolerance is kronor: on a foreign invoice what it is worth
              // in the invoice's currency at its rate.
              toleranceInCurrency(tolerance, invoice.exchangeRate === null ? 1 : Number(invoice.exchangeRate), invoice.currency),
              currencyLabel(invoice.currency)
            )
          : null;
        // One payment, one currency: an invoice in another currency than the
        // payment's cannot be settled by it.
        const otherCurrency = invoice.currency !== currency;
        return (
          <div key={invoice.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Checkbox
              aria-label={`Välj ${invoice.invoiceNumber}`}
              title={otherCurrency ? `Fakturan är i ${invoice.currency} men betalningen är i ${currency}` : undefined}
              disabled={otherCurrency && !inDraft.has(invoice.id)}
              checked={inDraft.has(invoice.id)}
              onChange={() =>
                onChange({
                  ...draft,
                  rows: inDraft.has(invoice.id)
                    ? draft.rows.filter((r) => r.invoiceId !== invoice.id)
                    : [
                        ...draft.rows,
                        {
                          invoiceId: invoice.id,
                          invoiceNumber: invoice.invoiceNumber ?? "",
                          openAmount: invoice.openAmount,
                          applied: String(round2(Math.min(invoice.openAmount, paid - allocated))),
                        },
                      ],
                })
              }
            />
            <span>{invoice.invoiceNumber}</span>
            <span>
              Öppet {formatMoney(invoice.openAmount)} {currencyLabel(invoice.currency)}
              {otherCurrency && ` — betalningen är i ${currency}`}
            </span>
            {row && (
              <Input
                type="number"
                step="0.01"
                value={row.applied}
                aria-label={`Belopp ${invoice.invoiceNumber}`}
                onChange={(ev) => onChange({ ...draft, rows: draft.rows.map((r) => (r.invoiceId === invoice.id ? { ...r, applied: ev.target.value } : r)) })}
                style={{ width: 140 }}
              />
            )}
            {preview && <span style={{ color: PREVIEW_TONE_COLOR[preview.tone] }}>{preview.text}</span>}
          </div>
        );
      })}
      <div style={{ color: allocated === round2(paid) ? "var(--status-running-text)" : "var(--status-stopped-text)" }}>
        Fördelat {formatMoney(allocated)} av {formatMoney(paid)}
        {currency !== SEK ? ` ${currency}` : ""}
      </div>
    </div>
  );
}

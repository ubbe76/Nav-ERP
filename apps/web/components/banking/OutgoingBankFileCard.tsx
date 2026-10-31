"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Field";
import { FormError, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { useCan } from "../PermissionsProvider";
import { API_URL, apiFetch } from "../../lib/api";
import { OUTGOING_STATE } from "../../lib/banking";
import { editOf, withEdit, type StampedEdits } from "../../lib/stampedEdits";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatRate } from "../../lib/currency";
import { formatMoney } from "../../lib/format";
import type { BankFileDetail, BankItemResult, OutgoingEntryView } from "../../lib/types";
import { BankEntryIgnoreButton } from "./BankEntryIgnoreButton";
import { BookingFailures } from "./BookingFailures";

const BOOKABLE = new Set(["matched", "return"]);
const HINT: Partial<Record<OutgoingEntryView["state"], string>> = {
  amount_mismatch: "Kontrollera i internetbanken och bekräfta manuellt med rätt belopp under Betalningar.",
  already_confirmed: "Bekräftad på annat sätt — markera posten som Hanterad utanför Nav.",
  unknown: "Hör inte till någon betalfil (t.ex. kortköp eller avgift).",
};
// A return of another amount than we sent is never booked automatically.
const RETURN_AMOUNT_HINT = "Returen gäller ett annat belopp än betalfilen. Kontrollera i internetbanken och makulera utbetalningen manuellt under Betalningar om det behövs.";
// Valuta steg 2: a payment in another currency is matched on the instructed
// amount (InstdAmt) in the invoice's currency, and booked with the SEK the
// bank drew from the account.
const isForeignItem = (e: OutgoingEntryView) => e.item !== null && e.item.currency !== "SEK";
function hintFor(e: OutgoingEntryView): string | undefined {
  if (e.state === "amount_mismatch" && e.reversal) return RETURN_AMOUNT_HINT;
  if (e.item && isForeignItem(e)) {
    const unit = e.item.currency;
    if (e.state === "amount_mismatch") {
      return `Betalfilens post är ${formatMoney(e.item.amount)} ${unit}, men bankavin anger inte samma belopp i ${unit}. Kontrollera i internetbanken och bekräfta manuellt med Bekräfta utförd på betalfilen (med beloppet i SEK från kontoutdraget).`;
    }
    if (e.state === "matched") {
      return `Bokförs med ${formatMoney(e.amount)} kr draget från kontot${
        e.chargesAmount !== null
          ? `, varav bankavgift ${formatMoney(e.chargesAmount)} kr.`
          : ". Banken anger ingen avgift — en eventuell avgift hamnar i kursdifferensen."
      }`;
    }
    if (e.state === "return") return "Returen makulerar utbetalningen — det går bara om banken återförde samma belopp i SEK som den drog.";
  }
  return HINT[e.state];
}

// Owns the per-row booking results OUTSIDE the body, which shows the result
// of the latest refresh. The body is no longer remounted when an entry's state
// changes: a checkbox the user changed is kept per entry (lib/stampedEdits.ts),
// so an entry left out of one booking is not chosen again behind their back.
export function OutgoingBankFileCard({ file, entries }: { file: BankFileDetail; entries: OutgoingEntryView[] }) {
  const [results, setResults] = useState<BankItemResult[] | null>(null);
  const failures = (results ?? [])
    .filter((r) => !r.ok && r.error)
    .map((r) => ({ key: r.entryId ?? "", label: entries.find((e) => e.id === r.entryId)?.endToEndId ?? "Post", error: r.error! }));
  return (
    <>
      <BookingFailures failures={failures} />
      <OutgoingBankFileBody key={file.id} file={file} entries={entries} onResults={setResults} />
    </>
  );
}

function OutgoingBankFileBody({
  file,
  entries,
  onResults,
}: {
  file: BankFileDetail;
  entries: OutgoingEntryView[];
  onResults: (results: BankItemResult[] | null) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const writable = can(["inkop"]);
  const [toggled, setToggled] = useState<StampedEdits<boolean>>({});
  // A booked entry's state has changed, so its old tick no longer counts.
  const isChosen = (e: OutgoingEntryView) => BOOKABLE.has(e.state) && (editOf(toggled, e) ?? true);
  const chosenEntries = entries.filter(isChosen);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function book() {
    setPending(true);
    setError(null);
    onResults(null);
    try {
      const body = await apiFetch<{ results: BankItemResult[] }>(`/api/v1/bank-files/${file.id}/outgoing/book`, {
        method: "POST",
        body: JSON.stringify({ entryIds: chosenEntries.map((e) => e.id) }),
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
      </div>
      {file.accountWarning && <FormNotice>{file.accountWarning}</FormNotice>}
      {file.warnings.map((w) => <FormNotice key={w}>{w}</FormNotice>)}
      {error && <FormError>{error}</FormError>}
      <Table<OutgoingEntryView>
        columns={[
          { key: "select", label: "", width: "40px" },
          { key: "endToEndId", label: "Post", width: "110px" },
          { key: "batch", label: "Betalfil", width: "1fr" },
          { key: "amount", label: "Belopp", width: "200px", align: "right" },
          { key: "bookingDate", label: "Bokföringsdag", width: "120px" },
          { key: "state", label: "Läge", width: "1.2fr" },
          { key: "actions", label: "", width: "170px" },
        ]}
        rows={entries}
        emptyText="Filen har inga debiteringar eller returer"
        renderCell={(e, key) => {
          switch (key) {
            case "select":
              return (
                <Checkbox
                  aria-label={`Välj ${e.endToEndId ?? "post"}`}
                  checked={isChosen(e)}
                  disabled={!writable || !BOOKABLE.has(e.state)}
                  onChange={() => setToggled((t) => withEdit(t, e, !isChosen(e)))}
                />
              );
            case "endToEndId":
              return e.endToEndId ?? "–";
            case "batch":
              return e.item ? (
                <span>
                  <GatedLink href={`/inkop/betalfiler/${e.item.batchId}`}>{e.item.batchNumber}</GatedLink> · {e.item.registrationNumber}
                </span>
              ) : (
                e.counterpartyName ?? "–"
              );
            case "amount": {
              const sign = e.reversal ? "+" : "−";
              // Another currency than the account's: the instructed amount, then
              // what it cost in SEK with the bank's rate and charges.
              if (e.instructedAmount !== null && e.instructedCurrency) {
                const exchange = e.currencyExchange;
                return (
                  <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <span>
                      {sign}
                      {formatMoney(e.instructedAmount)} {e.instructedCurrency}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {formatMoney(e.amount)} kr från kontot
                    </span>
                    {exchange && (
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                        Bankens kurs {formatRate(exchange.rate)}
                        {exchange.targetCurrency ? ` (${exchange.sourceCurrency}→${exchange.targetCurrency})` : ""}
                      </span>
                    )}
                    {e.chargesAmount !== null && (
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>varav avgifter {formatMoney(e.chargesAmount)} kr</span>
                    )}
                  </span>
                );
              }
              return `${sign}${formatMoney(e.amount)} kr`;
            }
            case "bookingDate":
              return e.bookingDate;
            case "state": {
              const s = OUTGOING_STATE[e.state]!;
              return (
                <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                  <StatusPill status={s.pill} label={e.state === "return" && e.returnReason ? `${s.label} (${e.returnReason})` : s.label} compact />
                  {e.payment && <GatedLink href={`/inkop/betalningar/${e.payment.id}`}>{e.payment.paymentNumber}</GatedLink>}
                  {/* Redan bekräftad: the batch row was confirmed by hand — its UTB is the one to point at. */}
                  {!e.payment && e.state === "already_confirmed" && e.item?.paymentId && (
                    <span style={{ fontSize: 12 }}>
                      Bekräftad som <GatedLink href={`/inkop/betalningar/${e.item.paymentId}`}>{e.item.paymentNumber}</GatedLink>
                    </span>
                  )}
                  {hintFor(e) && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{hintFor(e)}</span>}
                  {e.ignoreReason && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{e.ignoreReason}</span>}
                </span>
              );
            }
            case "actions":
              return writable && e.state !== "booked" ? <BankEntryIgnoreButton fileId={file.id} direction="outgoing" entryId={e.id} ignored={e.state === "ignored"} /> : null;
            default:
              return null;
          }
        }}
      />
      {writable && (
        <div style={{ marginTop: 16 }}>
          <Button onClick={book} disabled={pending || chosenEntries.length === 0}>
            Bokför valda
          </Button>
        </div>
      )}
    </>
  );
}

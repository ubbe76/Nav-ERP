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
import { apiErrorMessage } from "../../lib/errorMessages";
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
const hintFor = (e: OutgoingEntryView) => (e.state === "amount_mismatch" && e.reversal ? RETURN_AMOUNT_HINT : HINT[e.state]);

// Owns the per-row booking results OUTSIDE the keyed body: book() refreshes the
// page, the page's key (the entries' states) then remounts the body, and
// results held there would vanish together with the failures the user must read.
export function OutgoingBankFileCard({ file, entries }: { file: BankFileDetail; entries: OutgoingEntryView[] }) {
  const [results, setResults] = useState<BankItemResult[] | null>(null);
  const failures = (results ?? [])
    .filter((r) => !r.ok && r.error)
    .map((r) => ({ key: r.entryId ?? "", label: entries.find((e) => e.id === r.entryId)?.endToEndId ?? "Post", error: r.error! }));
  return (
    <>
      <BookingFailures failures={failures} />
      <OutgoingBankFileBody key={entries.map((e) => e.state).join()} file={file} entries={entries} onResults={setResults} />
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
  const [chosen, setChosen] = useState<Set<string>>(new Set(entries.filter((e) => BOOKABLE.has(e.state)).map((e) => e.id)));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function book() {
    setPending(true);
    setError(null);
    onResults(null);
    try {
      const body = await apiFetch<{ results: BankItemResult[] }>(`/api/v1/bank-files/${file.id}/outgoing/book`, {
        method: "POST",
        body: JSON.stringify({ entryIds: entries.filter((e) => chosen.has(e.id)).map((e) => e.id) }),
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
          { key: "amount", label: "Belopp", width: "120px", align: "right" },
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
                  checked={chosen.has(e.id)}
                  disabled={!writable || !BOOKABLE.has(e.state)}
                  onChange={() =>
                    setChosen((c) => {
                      const next = new Set(c);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })
                  }
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
            case "amount":
              return `${e.reversal ? "+" : "−"}${formatMoney(e.amount)} kr`;
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
          <Button onClick={book} disabled={pending || chosen.size === 0}>
            Bokför valda
          </Button>
        </div>
      )}
    </>
  );
}

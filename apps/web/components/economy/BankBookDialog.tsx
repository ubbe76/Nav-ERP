"use client";

import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { bookRowsForEntry } from "../../lib/bankReconciliation";
import { formatMoney, round2 } from "../../lib/format";
import { useVatCodes } from "../../lib/useVatCodes";
import { rowTotals, toVerificationApiRows, withSpareRows, type EditorRow } from "../../lib/verificationRows";
import type { Account, BankAccount, BankMatch, BankStatementEntry } from "../../lib/types";
import { VerificationRowsEditor } from "./VerificationRowsEditor";

export interface BookedEntry {
  verification: { id: string; displayNumber: string };
  match: BankMatch;
}

// Bokför on an omatchad post: the verification table prefilled from the entry
// and its bank rule. POST /bank-statement-entries/:id/book books the
// verifikat (serie B) and matches it to the entry in one transaction.
export function BankBookDialog({
  entry,
  bankAccount,
  accounts,
  onClose,
  onBooked,
}: {
  entry: BankStatementEntry | null;
  bankAccount: BankAccount;
  accounts: Account[];
  onClose: () => void;
  onBooked: (entry: BankStatementEntry, result: BookedEntry) => void;
}) {
  return (
    <Modal open={entry !== null} onClose={onClose} title="Bokför posten" wide>
      {entry && (
        <BookForm key={entry.id} entry={entry} bankAccount={bankAccount} accounts={accounts} onClose={onClose} onBooked={onBooked} />
      )}
    </Modal>
  );
}

function BookForm(props: {
  entry: BankStatementEntry;
  bankAccount: BankAccount;
  accounts: Account[];
  onClose: () => void;
  onBooked: (entry: BankStatementEntry, result: BookedEntry) => void;
}) {
  const { codes, loaded } = useVatCodes();
  // The rule's Momskod splits the counter row, which needs the codes first.
  if (props.entry.ruleSuggestion?.vatCode && !loaded) return <p>Laddar momskoder…</p>;
  return <BookFormInner {...props} vatCodes={codes} />;
}

function BookFormInner({
  entry,
  bankAccount,
  accounts,
  vatCodes,
  onClose,
  onBooked,
}: {
  entry: BankStatementEntry;
  bankAccount: BankAccount;
  accounts: Account[];
  vatCodes: ReturnType<typeof useVatCodes>["codes"];
  onClose: () => void;
  onBooked: (entry: BankStatementEntry, result: BookedEntry) => void;
}) {
  const [initial] = useState(() =>
    bookRowsForEntry(entry, bankAccount, vatCodes, (n) => accounts.find((a) => a.number === n)?.name ?? "")
  );
  const [rows, setRows] = useState<EditorRow[]>(() => withSpareRows(initial.rows));
  const [date, setDate] = useState(entry.bookingDate);
  const [description, setDescription] = useState(entry.text.slice(0, 255));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const totals = rowTotals(rows);
  const incoming = entry.amount > 0;
  const amount = round2(Math.abs(entry.amount));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (pending) return;
    if (description.trim() === "") return setError("Ange en beskrivning.");
    const body = toVerificationApiRows(rows, accounts);
    if (body.error !== null) return setError(body.error);
    if (totals.diff !== 0) return setError(`Verifikatet balanserar inte — differensen är ${formatMoney(totals.diff)}.`);
    // The server insists on it too (bank-entry-book-mismatch); checking here
    // names the row instead of refusing the whole verifikat.
    const ledger = accounts.find((a) => a.number === bankAccount.ledgerAccount);
    if (ledger) {
      const net = round2(
        body.rows.filter((r) => r.accountId === ledger.id).reduce((sum, r) => sum + r.debit - r.credit, 0)
      );
      if (net !== entry.amount) {
        return setError(
          `Raden på bankkontot ${bankAccount.ledgerAccount} ska vara ${formatMoney(amount)} i ${incoming ? "debet" : "kredit"} — det är postens belopp.`
        );
      }
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<BookedEntry>(`/api/v1/bank-statement-entries/${entry.id}/book`, {
        method: "POST",
        body: JSON.stringify({ description: description.trim(), date, rows: body.rows }),
      });
      onBooked(entry, result);
    } catch (err) {
      setError(apiErrorMessage(err, "Verifikatet kunde inte bokföras"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      {initial.notice && <FormNotice>{initial.notice}</FormNotice>}
      <p style={{ margin: 0 }}>
        <strong>{entry.text}</strong>
        <br />
        {entry.bookingDate} · {formatMoney(entry.amount)} kr{entry.counterparty ? ` · ${entry.counterparty}` : ""}
        {entry.reference ? ` · ${entry.reference}` : ""}
      </p>
      <FormRow>
        <Field label="Datum" htmlFor="bankBookDate">
          <Input id="bankBookDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Beskrivning" htmlFor="bankBookDescription">
          <Input
            id="bankBookDescription"
            required
            maxLength={255}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </FormRow>
      <VerificationRowsEditor
        rows={rows}
        onChange={setRows}
        accounts={accounts}
        vatCodes={vatCodes}
        onSave={() => void submit()}
        disabled={pending}
      />
      <FormHint>
        Verifikatet bokförs i serie B (Bank) och matchas mot posten i samma steg. Raden på bankkontot {bankAccount.ledgerAccount} är
        förifylld med postens belopp.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Bokför…" : "Bokför"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

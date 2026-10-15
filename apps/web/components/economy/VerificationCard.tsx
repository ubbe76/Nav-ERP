"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { UnderlagSection } from "../documents/UnderlagSection";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { YEAR_END_ROLE_LABELS, YEAR_END_STEP_LABELS } from "../../lib/yearEnd";
import {
  VERIFICATION_STATUS_PILL,
  type Account,
  type VerificationDetail,
  type VerificationRow,
  type VerificationSeries,
} from "../../lib/types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

// Translates the economy service's errors via the shared error-code
// dictionary — same idiom as KontoplanPageClient's formatAccountError/
// RakenskapsarPageClient's formatFiscalYearError. Covers every error
// reachable from this card's actions (header patch, row CRUD, book, delete,
// reverse).
function formatVerificationError(err: unknown): string {
  return apiErrorMessage(err, "Åtgärden misslyckades");
}

// A row's own account might since have been deactivated — the active-only
// `accounts` list (the picker's source) would then no longer contain it,
// which would blank the <select> when editing that specific row. Pinning it
// back in (inactive, at the top) keeps the current value visible without
// making it pickable for any OTHER row.
function withCurrentAccount(accounts: Account[], current: { id: string; number: string; name: string } | null): Account[] {
  if (!current || accounts.some((a) => a.id === current.id)) return accounts;
  return [{ id: current.id, number: current.number, name: current.name, active: false, vatBox: null, createdAt: "" }, ...accounts];
}

function accountLabel(a: Account): string {
  return `${a.number} · ${a.name}`;
}

export function VerificationCard({
  verification,
  accounts,
  series,
  bookedByName,
  sourceDisplayNumber,
}: {
  verification: VerificationDetail;
  accounts: Account[];
  series: VerificationSeries[];
  // Joined server-side by GET /verifications/:id (verification.bookedByName,
  // soft-deleted users included) — null when nobody has booked it.
  bookedByName: string | null;
  // The source verification's displayNumber when THIS one is a reversal
  // draft (verification.reversesVerificationId set) — resolved server-side
  // via a second GET /verifications/:id. Null otherwise or while unresolved.
  // The opposite direction (has THIS verification been reversed by some
  // other one?) is carried directly on verification.reversedBy — no extra
  // fetch needed there, see lib/types.ts's VerificationDetail comment.
  sourceDisplayNumber: string | null;
}) {
  const router = useRouter();
  const pill = VERIFICATION_STATUS_PILL[verification.status];
  const editable = verification.status === "draft";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const totalDebit = round2(verification.rows.reduce((sum, r) => sum + Number(r.debit), 0));
  const totalCredit = round2(verification.rows.reduce((sum, r) => sum + Number(r.credit), 0));
  const diff = round2(totalDebit - totalCredit);
  const canBook = editable && diff === 0 && verification.rows.length >= 2;

  async function bookVerification() {
    if (!(await confirmDialog("Verifikatet får nummer och låses. Fortsätt?"))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verification.id}/book`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(formatVerificationError(err));
    } finally {
      setPending(false);
    }
  }

  async function removeVerification() {
    if (!(await confirmDelete("Ta bort verifikatet permanent?"))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verification.id}`, { method: "DELETE" });
      router.push("/ekonomi/verifikat");
    } catch (err) {
      setError(formatVerificationError(err));
      setPending(false);
    }
  }

  async function reverseVerification() {
    if (!(await confirmDialog("Skapa en omföring av det här verifikatet?"))) return;
    setError(null);
    setPending(true);
    try {
      const draft = await apiFetch<VerificationDetail>(`/api/v1/verifications/${verification.id}/reverse`, {
        method: "POST",
      });
      router.push(`/ekonomi/verifikat/${draft.id}`);
    } catch (err) {
      setError(formatVerificationError(err));
      setPending(false);
    }
  }

  async function removeRow(row: VerificationRow) {
    if (!(await confirmDelete("Ta bort raden?"))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verification.id}/rows/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(formatVerificationError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={pill.status} label={pill.label} />
        {!editable && verification.bookedAt && (
          <span>
            Bokförd: {formatDateTime(verification.bookedAt)}
            {bookedByName ? ` av ${bookedByName}` : ""}
          </span>
        )}
        {verification.reversesVerificationId && (
          <span>
            Omföring av{" "}
            <Link href={`/ekonomi/verifikat/${verification.reversesVerificationId}`}>
              {sourceDisplayNumber ?? "–"}
            </Link>
          </span>
        )}
        {verification.reversedBy && (
          <span>
            Omförd genom{" "}
            <Link href={`/ekonomi/verifikat/${verification.reversedBy.id}`}>{verification.reversedBy.displayNumber}</Link>
          </span>
        )}
        {verification.fixedAsset && (
          <span>
            Anläggningsregistret:{" "}
            {verification.fixedAsset.assetId ? (
              <Link href={`/ekonomi/anlaggningar/${verification.fixedAsset.assetId}`}>avyttrad anläggning</Link>
            ) : (
              <Link href="/ekonomi/anlaggningar">
                {verification.fixedAsset.kind === "reversal" ? "ångrad avskrivningskörning" : "avskrivningskörning"}
              </Link>
            )}
          </span>
        )}
        {verification.yearEnd && (
          <span>
            Bokslut {verification.yearEnd.fiscalYearLabel}:{" "}
            <Link href={`/ekonomi/bokslut?fiscalYearId=${verification.yearEnd.fiscalYearId}`}>
              {verification.yearEnd.role === "booking"
                ? YEAR_END_STEP_LABELS[verification.yearEnd.step]
                : `${YEAR_END_ROLE_LABELS[verification.yearEnd.role]} (${YEAR_END_STEP_LABELS[verification.yearEnd.step].toLowerCase()})`}
            </Link>
          </span>
        )}
      </div>

      <FormError>{error}</FormError>

      {editable ? (
        <HeaderForm verification={verification} series={series} onSaved={() => router.refresh()} />
      ) : (
        <Card maxWidth={520} style={{ marginBottom: 20 }}>
          <FormStack>
            <FormRow>
              <div>
                <strong>Serie</strong>
                <br />
                {verification.seriesCode}
              </div>
              <div>
                <strong>Datum</strong>
                <br />
                {verification.date}
              </div>
            </FormRow>
            <div>
              <strong>Beskrivning</strong>
              <br />
              {verification.description}
            </div>
          </FormStack>
        </Card>
      )}

      <SectionHeading spaced>Rader</SectionHeading>
      {verification.rows.length > 0 ? (
        <RowsTable
          verificationId={verification.id}
          rows={verification.rows}
          accounts={accounts}
          editable={editable}
          pending={pending}
          onRemove={removeRow}
          onChanged={() => router.refresh()}
          onError={(msg) => setError(msg)}
        />
      ) : (
        <p>Inga rader tillagda än.</p>
      )}

      <div style={{ display: "flex", gap: 24, marginTop: 12, flexWrap: "wrap" }}>
        <span>∑ Debet: {formatMoney(totalDebit)}</span>
        <span>∑ Kredit: {formatMoney(totalCredit)}</span>
        <span style={{ fontWeight: 600, color: diff !== 0 ? "var(--status-stopped-text)" : undefined }}>
          Differens: {formatMoney(diff)}
        </span>
      </div>

      <UnderlagSection
        filesUrl={`/api/v1/verifications/${verification.id}/files`}
        files={verification.files}
        removable={editable}
        lockedBy="bokföring"
        description="Kvitto, kontoutdrag, avtal eller annat underlag för verifikatet som"
      />

      <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {editable && <AddRowForm verificationId={verification.id} accounts={accounts} onDone={() => router.refresh()} />}

        <Card maxWidth={320}>
          <FormStack>
            <strong>Åtgärder</strong>
            {editable && (
              <>
                <Button type="button" variant="primary" disabled={!canBook || pending} onClick={bookVerification}>
                  Bokför
                </Button>
                {!canBook && (
                  <FormHint attached>
                    {verification.rows.length < 2
                      ? "Lägg till minst två rader för att kunna bokföra."
                      : "Debet och kredit måste balansera för att kunna bokföra."}
                  </FormHint>
                )}
                <Button type="button" variant="danger" disabled={pending} onClick={removeVerification}>
                  Ta bort
                </Button>
              </>
            )}
            {!editable && !verification.reversedBy && !verification.fixedAsset && !verification.yearEnd && (
              <Button type="button" variant="secondary" disabled={pending} onClick={reverseVerification}>
                Omför
              </Button>
            )}
          </FormStack>
        </Card>
      </div>
    </div>
  );
}

function HeaderForm({
  verification,
  series,
  onSaved,
}: {
  verification: VerificationDetail;
  series: VerificationSeries[];
  onSaved: () => void;
}) {
  const [seriesId, setSeriesId] = useState(verification.seriesId);
  const [date, setDate] = useState(verification.date);
  const [description, setDescription] = useState(verification.description);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verification.id}`, {
        method: "PATCH",
        body: JSON.stringify({ seriesId, date, description: description.trim() }),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(formatVerificationError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={520} style={{ marginBottom: 20 }}>
      <Form onSubmit={save}>
        <FormError>{error}</FormError>
        <FormRow>
          <Field label="Serie" htmlFor="hdrSeries">
            <Select id="hdrSeries" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Datum" htmlFor="hdrDate">
            <Input id="hdrDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </FormRow>
        <Field label="Beskrivning" htmlFor="hdrDescription">
          <Input
            id="hdrDescription"
            required
            maxLength={255}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara verifikat"}
          </Button>
          {saved && <span style={{ alignSelf: "center" }}>Sparat</span>}
        </FormActions>
      </Form>
    </Card>
  );
}

const ROW_COLUMNS_EDIT = [
  { key: "account", label: "Konto", width: "1.3fr" },
  { key: "description", label: "Beskrivning", width: "1fr" },
  { key: "debit", label: "Debet", width: "120px", align: "right" as const },
  { key: "credit", label: "Kredit", width: "120px", align: "right" as const },
  { key: "id", label: "", width: "160px", align: "right" as const },
];

const ROW_COLUMNS_READONLY = [
  { key: "account", label: "Konto", width: "1.3fr" },
  { key: "description", label: "Beskrivning", width: "1fr" },
  { key: "debit", label: "Debet", width: "120px", align: "right" as const },
  { key: "credit", label: "Kredit", width: "120px", align: "right" as const },
];

function RowsTable({
  verificationId,
  rows,
  accounts,
  editable,
  pending,
  onRemove,
  onChanged,
  onError,
}: {
  verificationId: string;
  rows: VerificationRow[];
  accounts: Account[];
  editable: boolean;
  pending: boolean;
  onRemove: (row: VerificationRow) => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editAccountId, setEditAccountId] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDebit, setEditDebit] = useState("0");
  const [editCredit, setEditCredit] = useState("0");
  const [rowPending, setRowPending] = useState(false);

  function startEdit(row: VerificationRow) {
    onError(null);
    setEditingRowId(row.id);
    setEditAccountId(row.accountId);
    setEditDescription(row.description ?? "");
    setEditDebit(String(Number(row.debit)));
    setEditCredit(String(Number(row.credit)));
  }

  function changeEditDebit(value: string) {
    setEditDebit(value);
    if (Number(value) > 0) setEditCredit("0");
  }

  function changeEditCredit(value: string) {
    setEditCredit(value);
    if (Number(value) > 0) setEditDebit("0");
  }

  async function saveEdit(row: VerificationRow) {
    const debit = Number(editDebit) || 0;
    const credit = Number(editCredit) || 0;
    if (!editAccountId) {
      onError("Välj ett konto");
      return;
    }
    if ((debit > 0) === (credit > 0)) {
      onError("Ange ett belopp i antingen Debet eller Kredit");
      return;
    }
    onError(null);
    setRowPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verificationId}/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountId: editAccountId, debit, credit, description: editDescription.trim() || undefined }),
      });
      setEditingRowId(null);
      onChanged();
    } catch (err) {
      onError(formatVerificationError(err));
    } finally {
      setRowPending(false);
    }
  }

  return (
    <Table<VerificationRow>
      columns={editable ? ROW_COLUMNS_EDIT : ROW_COLUMNS_READONLY}
      rows={rows}
      renderCell={(row, key) => {
        const isEditing = editable && editingRowId === row.id;
        switch (key) {
          case "account":
            if (isEditing) {
              const options = withCurrentAccount(accounts, { id: row.accountId, number: row.accountNumber, name: row.accountName });
              return (
                <Select aria-label="Konto" value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                  {options.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </Select>
              );
            }
            return `${row.accountNumber} · ${row.accountName}`;
          case "description":
            return isEditing ? (
              <Input
                aria-label="Beskrivning"
                maxLength={255}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            ) : (
              row.description ?? "–"
            );
          case "debit":
            return isEditing ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                size="sm"
                aria-label="Debet"
                value={editDebit}
                onChange={(e) => changeEditDebit(e.target.value)}
              />
            ) : (
              formatMoney(row.debit)
            );
          case "credit":
            return isEditing ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                size="sm"
                aria-label="Kredit"
                value={editCredit}
                onChange={(e) => changeEditCredit(e.target.value)}
              />
            ) : (
              formatMoney(row.credit)
            );
          case "id":
            if (!editable) return null;
            return isEditing ? (
              <span style={{ display: "inline-flex", gap: 8 }}>
                <Button type="button" size="small" variant="primary" disabled={rowPending} onClick={() => saveEdit(row)}>
                  Spara
                </Button>
                <Button type="button" size="small" variant="ghost" onClick={() => setEditingRowId(null)}>
                  Avbryt
                </Button>
              </span>
            ) : (
              <span style={{ display: "inline-flex", gap: 8 }}>
                <Button type="button" size="small" variant="ghost" onClick={() => startEdit(row)}>
                  Ändra
                </Button>
                <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => onRemove(row)}>
                  Ta bort
                </Button>
              </span>
            );
          default:
            return null;
        }
      }}
    />
  );
}

// Adds a row — account picker (active accounts only, "1930 · Företagskonto"),
// optional beskrivning, and the debit/credit pair with the "fyller man i ena
// nollas andra" UI rule (typing a value into one clears the other), so the
// XOR the API's zod schema enforces is never actually violated in practice.
function AddRowForm({
  verificationId,
  accounts,
  onDone,
}: {
  verificationId: string;
  accounts: Account[];
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [description, setDescription] = useState("");
  const [debit, setDebit] = useState("0");
  const [credit, setCredit] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function changeDebit(value: string) {
    setDebit(value);
    if (Number(value) > 0) setCredit("0");
  }

  function changeCredit(value: string) {
    setCredit(value);
    if (Number(value) > 0) setDebit("0");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!accountId) {
      setError("Välj ett konto");
      return;
    }
    const debitNum = Number(debit) || 0;
    const creditNum = Number(credit) || 0;
    if ((debitNum > 0) === (creditNum > 0)) {
      setError("Ange ett belopp i antingen Debet eller Kredit");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verifications/${verificationId}/rows`, {
        method: "POST",
        body: JSON.stringify({ accountId, debit: debitNum, credit: creditNum, description: description.trim() || undefined }),
      });
      setAccountId("");
      setDescription("");
      setDebit("0");
      setCredit("0");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? formatVerificationError(err) : "Kunde inte lägga till raden");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={460}>
      <Form onSubmit={submit}>
        <strong>Lägg till rad</strong>
        <FormError>{error}</FormError>

        <Field label="Konto" htmlFor="rowAccount">
          <Select id="rowAccount" required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— Välj konto —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Beskrivning (valfritt)" htmlFor="rowDescription">
          <Input id="rowDescription" maxLength={255} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <FormRow>
          <Field label="Debet" htmlFor="rowDebit">
            <Input
              id="rowDebit"
              type="number"
              min="0"
              step="0.01"
              size="sm"
              value={debit}
              onChange={(e) => changeDebit(e.target.value)}
            />
          </Field>
          <Field label="Kredit" htmlFor="rowCredit">
            <Input
              id="rowCredit"
              type="number"
              min="0"
              step="0.01"
              size="sm"
              value={credit}
              onChange={(e) => changeCredit(e.target.value)}
            />
          </Field>
        </FormRow>

        <FormActions>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Lägger till…" : "Lägg till rad"}
          </Button>
        </FormActions>
      </Form>
    </Card>
  );
}

"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Field, Input, Select } from "../ui/Field";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormSaved, FormStack } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { UnderlagSection } from "../documents/UnderlagSection";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { useVatCodes } from "../../lib/useVatCodes";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { YEAR_END_ROLE_LABELS, YEAR_END_STEP_LABELS } from "../../lib/yearEnd";
import {
  rowsFromVerification,
  rowsSignature,
  rowTotals,
  toVerificationApiRows,
  withSpareRows,
  type EditorRow,
} from "../../lib/verificationRows";
import { VerificationRowsEditor } from "./VerificationRowsEditor";
import { dimensionText } from "../../lib/dimensions";
import { AllocateDialog } from "./AllocateDialog";
import {
  VERIFICATION_STATUS_PILL,
  type Account,
  type VerificationCopyResult,
  type VerificationDetail,
  type VerificationRow,
  type VerificationSeries,
  type VerificationTemplate,
} from "../../lib/types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

// Translates the economy service's errors via the shared error-code
// dictionary — same idiom as KontoplanPageClient's formatAccountError/
// RakenskapsarPageClient's formatFiscalYearError. Covers every error
// reachable from this card's actions (header patch, rows save, book, delete,
// reverse, copy, template).
function formatVerificationError(err: unknown): string {
  return apiErrorMessage(err, "Åtgärden misslyckades");
}

// Warnings from Kopiera (an inactive account's row was left out) travel to the
// new draft's page through sessionStorage, like the TO card's releaseWarnings.
export const COPY_WARNINGS_KEY = "verification-copy-warnings";

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
  const [saved, setSaved] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const { codes: vatCodes } = useVatCodes({ enabled: editable });

  // The editable table: the rows as last loaded/saved plus spare blank lines.
  // It is state of its own — a header save refreshes the page props without
  // clobbering unsaved row edits.
  const [rows, setRows] = useState<EditorRow[]>(() =>
    editable ? withSpareRows(rowsFromVerification(verification.rows)) : []
  );
  const [savedSignature, setSavedSignature] = useState(() => rowsSignature(rowsFromVerification(verification.rows)));
  const dirty = editable && rowsSignature(rows) !== savedSignature;
  useUnsavedGuard(dirty);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`${COPY_WARNINGS_KEY}:${verification.id}`);
      if (raw) {
        sessionStorage.removeItem(`${COPY_WARNINGS_KEY}:${verification.id}`);
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setWarnings(parsed.filter((w): w is string => typeof w === "string"));
      }
    } catch {
      // sessionStorage unavailable — the warnings are a courtesy only.
    }
  }, [verification.id]);

  const shownRows = editable ? rows : [];
  const totals = editable
    ? rowTotals(shownRows)
    : {
        debit: round2(verification.rows.reduce((sum, r) => sum + Number(r.debit), 0)),
        credit: round2(verification.rows.reduce((sum, r) => sum + Number(r.credit), 0)),
        diff: 0,
      };
  const diff = editable ? totals.diff : round2(totals.debit - totals.credit);
  const filledRows = editable ? rows.filter((r) => rowsSignature([r]) !== "[]").length : verification.rows.length;
  const canBook = editable && diff === 0 && filledRows >= 2;

  // PUT the whole table; returns false (and sets the error) when it is
  // invalid or refused.
  async function saveRows(): Promise<boolean> {
    const body = toVerificationApiRows(rows, accounts);
    if (body.error !== null) {
      setError(body.error);
      return false;
    }
    setError(null);
    setSaved(false);
    try {
      const detail = await apiFetch<VerificationDetail>(`/api/v1/verifications/${verification.id}/rows`, {
        method: "PUT",
        body: JSON.stringify({ rows: body.rows }),
      });
      const next = rowsFromVerification(detail.rows);
      setRows(withSpareRows(next));
      setSavedSignature(rowsSignature(next));
      setSaved(true);
      router.refresh();
      return true;
    } catch (err) {
      setError(formatVerificationError(err));
      return false;
    }
  }

  async function runSave() {
    if (!editable || pending) return;
    setPending(true);
    try {
      await saveRows();
    } finally {
      setPending(false);
    }
  }

  async function bookVerification() {
    if (!(await confirmDialog("Verifikatet får nummer och låses. Fortsätt?"))) return;
    setError(null);
    setPending(true);
    try {
      // Unsaved row edits are saved first so the booking is what is on screen.
      if (dirty && !(await saveRows())) return;
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

  async function copyVerification() {
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<VerificationCopyResult>(`/api/v1/verifications/${verification.id}/copy`, {
        method: "POST",
      });
      if (result.warnings.length > 0) {
        try {
          sessionStorage.setItem(`${COPY_WARNINGS_KEY}:${result.verification.id}`, JSON.stringify(result.warnings));
        } catch {
          // The warnings are a courtesy only.
        }
      }
      router.push(`/ekonomi/verifikat/${result.verification.id}`);
    } catch (err) {
      setError(formatVerificationError(err));
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
      {(warnings.length > 0 || (verification.warnings ?? []).length > 0) && (
        <FormNotice style={{ marginBottom: 16 }}>
          {[...warnings, ...(verification.warnings ?? [])].map((w) => (
            <div key={w}>{w}</div>
          ))}
        </FormNotice>
      )}

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
      {editable ? (
        <>
          <VerificationRowsEditor
            rows={rows}
            onChange={(next) => {
              setRows(next);
              setSaved(false);
            }}
            accounts={accounts}
            vatCodes={vatCodes}
            onSave={() => void runSave()}
            disabled={pending}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <Button type="button" variant="primary" disabled={pending || !dirty} onClick={() => void runSave()}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {dirty && <span>Osparade ändringar</span>}
            {saved && !dirty && <FormSaved>Sparat</FormSaved>}
          </div>
        </>
      ) : (
        <>
          {verification.rows.length > 0 ? (
            <ReadOnlyRows rows={verification.rows} />
          ) : (
            <p>Inga rader.</p>
          )}
          <div style={{ display: "flex", gap: 24, marginTop: 12, flexWrap: "wrap" }}>
            <span>∑ Debet: {formatMoney(totals.debit)}</span>
            <span>∑ Kredit: {formatMoney(totals.credit)}</span>
            <span style={{ fontWeight: 600, color: diff !== 0 ? "var(--status-stopped-text)" : undefined }}>
              Differens: {formatMoney(diff)}
            </span>
          </div>
        </>
      )}

      <UnderlagSection
        filesUrl={`/api/v1/verifications/${verification.id}/files`}
        files={verification.files}
        removable={editable}
        lockedBy="bokföring"
        description="Kvitto, kontoutdrag, avtal eller annat underlag för verifikatet som"
      />

      <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
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
                    {filledRows < 2
                      ? "Lägg till minst två rader för att kunna bokföra."
                      : "Debet och kredit måste balansera för att kunna bokföra."}
                  </FormHint>
                )}
              </>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={pending || dirty}
              title={dirty ? "Spara raderna först" : undefined}
              onClick={() => void copyVerification()}
            >
              Kopiera
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending || dirty}
              title={dirty ? "Spara raderna först" : undefined}
              onClick={() => setTemplateOpen(true)}
            >
              Spara som mall
            </Button>
            {dirty && <FormHint attached>Spara raderna först för att kopiera eller spara som mall.</FormHint>}
            {!editable && (
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setAllocateOpen(true)}>
                Fördela över perioder
              </Button>
            )}
            {editable && (
              <Button type="button" variant="danger" disabled={pending} onClick={removeVerification}>
                Ta bort
              </Button>
            )}
            {!editable && !verification.reversedBy && !verification.fixedAsset && !verification.yearEnd && (
              <Button type="button" variant="secondary" disabled={pending} onClick={reverseVerification}>
                Omför
              </Button>
            )}
          </FormStack>
        </Card>
      </div>

      <Modal open={templateOpen} onClose={() => setTemplateOpen(false)} title="Spara som mall" compact>
        <SaveAsTemplateForm verificationId={verification.id} defaultName={verification.description} />
      </Modal>
      <AllocateDialog
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
        sourceVerificationId={verification.id}
        defaultDescription={verification.description}
      />
    </div>
  );
}

function SaveAsTemplateForm({ verificationId, defaultName }: { verificationId: string; defaultName: string }) {
  const [name, setName] = useState(defaultName.slice(0, 100));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<VerificationTemplate | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      setCreated(
        await apiFetch<VerificationTemplate>(`/api/v1/verifications/${verificationId}/template`, {
          method: "POST",
          body: JSON.stringify({ name: name.trim() }),
        })
      );
    } catch (err) {
      setError(formatVerificationError(err));
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <FormStack>
        <p style={{ margin: 0 }}>
          Mallen <strong>{created.name}</strong> sparades med {created.rows.length} rader. Du hittar den under{" "}
          <Link href="/ekonomi/verifikatmallar">Verifikatmallar</Link>.
        </p>
      </FormStack>
    );
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Namn" htmlFor="templateName">
        <Input id="templateName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <FormHint attached>Mallen tar serie, beskrivning och rader — beloppen följer med och kan ändras när mallen används.</FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || name.trim() === ""}>
          {pending ? "Sparar…" : "Spara mall"}
        </Button>
      </FormActions>
    </Form>
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

const ROW_COLUMNS_READONLY = [
  { key: "account", label: "Konto", width: "1.3fr" },
  { key: "description", label: "Beskrivning", width: "1fr" },
  { key: "debit", label: "Debet", width: "120px", align: "right" as const },
  { key: "credit", label: "Kredit", width: "120px", align: "right" as const },
];

function ReadOnlyRows({ rows }: { rows: VerificationRow[] }) {
  // Kostnadsställe/Projekt columns only when some row carries one.
  const withCostCenter = rows.some((r) => r.costCenter);
  const withProject = rows.some((r) => r.project);
  const columns = [
    ROW_COLUMNS_READONLY[0]!,
    ROW_COLUMNS_READONLY[1]!,
    ...(withCostCenter ? [{ key: "costCenter", label: "Kostnadsställe", width: "1fr" }] : []),
    ...(withProject ? [{ key: "project", label: "Projekt", width: "1fr" }] : []),
    ROW_COLUMNS_READONLY[2]!,
    ROW_COLUMNS_READONLY[3]!,
  ];
  return (
    <Table<VerificationRow>
      columns={columns}
      rows={rows}
      renderCell={(row, key) => {
        switch (key) {
          case "account":
            return `${row.accountNumber} · ${row.accountName}`;
          case "description":
            return row.description ?? "–";
          case "costCenter":
            return dimensionText(row.costCenter);
          case "project":
            return dimensionText(row.project);
          case "debit":
            return formatMoney(row.debit);
          case "credit":
            return formatMoney(row.credit);
          default:
            return null;
        }
      }}
    />
  );
}

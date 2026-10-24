"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { UNDERLAG_ACCEPT, uploadUnderlag } from "../documents/UnderlagSection";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useVatCodes } from "../../lib/useVatCodes";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  rowsFromTemplate,
  rowsSignature,
  rowTotals,
  toVerificationApiRows,
  withSpareRows,
  type EditorRow,
} from "../../lib/verificationRows";
import type { Account, VerificationDetail, VerificationSeries, VerificationTemplate } from "../../lib/types";
import { VerificationRowsEditor } from "./VerificationRowsEditor";

function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

// /ekonomi/verifikat/nytt — header + the rows table on one page. The first
// Spara creates the draft with the rows (POST /verifications), Spara och
// bokför books it in the same request. Underlag chosen here is uploaded once
// the draft exists.
export function NewVerificationPageClient({
  accounts,
  series,
  templates,
  initialTemplateId,
}: {
  accounts: Account[];
  series: VerificationSeries[];
  templates: VerificationTemplate[];
  initialTemplateId: string | null;
}) {
  const router = useRouter();
  const initialTemplate = templates.find((t) => t.id === initialTemplateId) ?? null;
  const { codes: vatCodes } = useVatCodes();
  const [seriesId, setSeriesId] = useState(initialTemplate?.seriesId ?? series[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState(initialTemplate?.description ?? "");
  const [rows, setRows] = useState<EditorRow[]>(() =>
    withSpareRows(initialTemplate ? rowsFromTemplate(initialTemplate.rows) : [])
  );
  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set when the draft exists but an underlag upload failed — the page stays
  // so the message can be read, with a link to the card.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = createdId === null && (description.trim() !== "" || rowsSignature(rows) !== "[]" || files.length > 0);
  useUnsavedGuard(dirty && !pending);

  const totals = rowTotals(rows);
  const filled = rows.filter((r) => rowsSignature([r]) !== "[]").length;
  const canBook = totals.diff === 0 && filled >= 2;

  function applyTemplate(id: string) {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    setSeriesId(template.seriesId);
    setDescription(template.description);
    setRows(withSpareRows(rowsFromTemplate(template.rows)));
  }

  async function save(book: boolean) {
    if (pending) return;
    if (!seriesId) return setError("Välj en serie.");
    if (description.trim() === "") return setError("Ange en beskrivning.");
    const body = toVerificationApiRows(rows, accounts);
    if (body.error !== null) return setError(body.error);
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<VerificationDetail>("/api/v1/verifications", {
        method: "POST",
        body: JSON.stringify({ seriesId, date, description: description.trim(), rows: body.rows, ...(book ? { book: true } : {}) }),
      });
      setCreatedId(created.id);
      const failed: string[] = [];
      for (const file of files) {
        try {
          await uploadUnderlag(`/api/v1/verifications/${created.id}/files`, file);
        } catch (err) {
          failed.push(err instanceof Error ? err.message : file.name);
        }
      }
      if (failed.length > 0) {
        setError(`Verifikatet skapades, men underlaget kunde inte laddas upp: ${failed.join(" ")} Ladda upp det på verifikatkortet.`);
        setPending(false);
        return;
      }
      router.push(`/ekonomi/verifikat/${created.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Verifikatet kunde inte skapas"));
      setPending(false);
    }
  }

  return (
    <div>
      <FormError>{error}</FormError>
      {createdId && (
        <p>
          <Link href={`/ekonomi/verifikat/${createdId}`}>Öppna verifikatet</Link>
        </p>
      )}

      <Card maxWidth={640} style={{ marginBottom: 20 }}>
        <FormStack>
          {templates.length > 0 && (
            <Field label="Ny från mall" htmlFor="newVerificationTemplate">
              <Select
                id="newVerificationTemplate"
                value={templateId}
                disabled={pending || createdId !== null}
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">— Välj mall —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <FormRow>
            <Field label="Serie" htmlFor="newVerificationSeries">
              <Select id="newVerificationSeries" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                <option value="">— Välj serie —</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Datum" htmlFor="newVerificationDate">
              <Input id="newVerificationDate" type="date" required size="sm" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </FormRow>
          <Field label="Beskrivning" htmlFor="newVerificationDescription">
            <Input
              id="newVerificationDescription"
              required
              maxLength={255}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </FormStack>
      </Card>

      <SectionHeading spaced>Rader</SectionHeading>
      <VerificationRowsEditor
        rows={rows}
        onChange={setRows}
        accounts={accounts}
        vatCodes={vatCodes}
        onSave={() => void save(false)}
        disabled={pending || createdId !== null}
      />

      <Card maxWidth={640} style={{ marginTop: 20 }}>
        <FormStack>
          <strong>Underlag</strong>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={UNDERLAG_ACCEPT}
            disabled={pending || createdId !== null}
            aria-label="Välj underlag"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length > 0) setFiles((prev) => [...prev, ...picked]);
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
          {files.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  {file.name}{" "}
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Ta bort
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <FormHint attached>PDF, JPEG eller PNG. Filerna laddas upp när verifikatet har skapats.</FormHint>
        </FormStack>
      </Card>

      <FormActions style={{ marginTop: 16 }}>
        <Button type="button" variant="primary" disabled={pending || createdId !== null} onClick={() => void save(false)}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || createdId !== null || !canBook}
          title={canBook ? undefined : "Verifikatet måste ha minst två rader och balansera"}
          onClick={() => void save(true)}
        >
          Spara och bokför
        </Button>
        <Link href="/ekonomi/verifikat">Avbryt</Link>
      </FormActions>
    </div>
  );
}

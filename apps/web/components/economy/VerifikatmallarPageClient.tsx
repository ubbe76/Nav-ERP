"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import {
  rowsFromTemplate,
  rowsSignature,
  toTemplateApiRows,
  withSpareRows,
  type EditorRow,
} from "../../lib/verificationRows";
import type { Account, VerificationSeries, VerificationTemplate } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { VerificationRowsEditor } from "./VerificationRowsEditor";

// Ekonomi → Verifikatmallar: the register of templates (serie, beskrivning
// and rows) that Ny från mall and Återkommande verifikat use.
export function VerifikatmallarPageClient({
  templates,
  accounts,
  series,
}: {
  templates: VerificationTemplate[];
  accounts: Account[];
  series: VerificationSeries[];
}) {
  const router = useRouter();
  // null = the list, "new" = the empty editor, otherwise the template edited.
  const [editing, setEditing] = useState<VerificationTemplate | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function toggleActive(template: VerificationTemplate) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verification-templates/${template.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !template.active }),
      });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setPending(false);
    }
  }

  async function remove(template: VerificationTemplate) {
    if (!(await confirmDelete(`Ta bort mallen ${template.name}?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/verification-templates/${template.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Mallen kunde inte tas bort"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Verifikatmallar</div>
          <div className={shellStyles.meta}>{templates.length} mallar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" disabled={editing !== null} onClick={() => setEditing("new")}>
            + Ny mall
          </Button>
          <HelpLink chapter="ekonomi" anchor="verifikatmallar" label="Hjälp om verifikatmallar" />
        </div>
      </div>

      <FormError>{error}</FormError>

      {editing !== null && (
        <TemplateEditor
          key={editing === "new" ? "new" : editing.id}
          template={editing === "new" ? null : editing}
          accounts={accounts}
          series={series}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <Table<VerificationTemplate>
        columns={[
          { key: "name", label: "Namn", width: "1.2fr" },
          { key: "series", label: "Serie", width: "80px" },
          { key: "description", label: "Beskrivning", width: "1.4fr" },
          { key: "rows", label: "Rader", width: "70px", align: "right" },
          { key: "status", label: "Status", width: "100px" },
          { key: "id", label: "", width: "250px", align: "right" },
        ]}
        rows={templates}
        emptyText="Det finns inga verifikatmallar än"
        renderCell={(t, key) => {
          switch (key) {
            case "name":
              return t.name;
            case "series":
              return t.seriesCode;
            case "description":
              return t.description;
            case "rows":
              return t.rows.length;
            case "status":
              return <StatusPill status={t.active ? "running" : "draft"} label={t.active ? "Aktiv" : "Inaktiv"} compact />;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Link
                    href={`/ekonomi/verifikat/nytt?mall=${t.id}`}
                    style={{ alignSelf: "center" }}
                    aria-label={`Använd mallen ${t.name}`}
                  >
                    Använd
                  </Link>
                  <Button type="button" size="small" variant="ghost" disabled={editing !== null} onClick={() => setEditing(t)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void toggleActive(t)}>
                    {t.active ? "Inaktivera" : "Aktivera"}
                  </Button>
                  <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => void remove(t)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />
    </>
  );
}

function TemplateEditor({
  template,
  accounts,
  series,
  onDone,
  onCancel,
}: {
  template: VerificationTemplate | null;
  accounts: Account[];
  series: VerificationSeries[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [seriesId, setSeriesId] = useState(template?.seriesId ?? series[0]?.id ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [rows, setRows] = useState<EditorRow[]>(() => withSpareRows(template ? rowsFromTemplate(template.rows) : []));
  const [initialSignature] = useState(() => rowsSignature(template ? rowsFromTemplate(template.rows) : []));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const dirty =
    !done &&
    (rowsSignature(rows) !== initialSignature ||
      name !== (template?.name ?? "") ||
      description !== (template?.description ?? "") ||
      seriesId !== (template?.seriesId ?? series[0]?.id ?? ""));
  useUnsavedGuard(dirty);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (pending) return;
    if (name.trim() === "") return setError("Ange ett namn.");
    if (!seriesId) return setError("Välj en serie.");
    if (description.trim() === "") return setError("Ange en beskrivning.");
    const body = toTemplateApiRows(rows, accounts);
    if (body.error !== null) return setError(body.error);
    if (body.rows.length === 0) return setError("Mallen behöver minst en rad.");
    setError(null);
    setPending(true);
    try {
      const payload = JSON.stringify({ name: name.trim(), seriesId, description: description.trim(), rows: body.rows });
      if (template) {
        await apiFetch(`/api/v1/verification-templates/${template.id}`, { method: "PATCH", body: payload });
      } else {
        await apiFetch("/api/v1/verification-templates", { method: "POST", body: payload });
      }
      setDone(true);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Mallen kunde inte sparas"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} style={{ marginBottom: 24 }}>
      <Card maxWidth={640} style={{ marginBottom: 16 }}>
        <FormStack>
          <strong>{template ? `Ändra ${template.name}` : "Ny mall"}</strong>
          <FormError>{error}</FormError>
          <Field label="Namn" htmlFor="templateEditName">
            <Input id="templateEditName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <FormRow>
            <Field label="Serie" htmlFor="templateEditSeries">
              <Select id="templateEditSeries" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                <option value="">— Välj serie —</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <Field label="Beskrivning" htmlFor="templateEditDescription">
            <Input
              id="templateEditDescription"
              required
              maxLength={255}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <FormHint attached>
            Belopp får lämnas tomma — de fylls i när mallen används. En återkommande post kräver belopp på alla rader och att
            mallen balanserar.
          </FormHint>
        </FormStack>
      </Card>

      <VerificationRowsEditor
        rows={rows}
        onChange={setRows}
        accounts={accounts}
        counterRows={false}
        showBalance={false}
        onSave={() => void save()}
        disabled={pending}
      />

      <FormActions style={{ marginTop: 16 }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara mall"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </form>
  );
}

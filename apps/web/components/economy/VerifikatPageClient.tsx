"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { API_URL, apiFetch } from "../../lib/api";
import { AllocateDialog } from "./AllocateDialog";
import { apiErrorMessage } from "../../lib/errorMessages";
import buttonStyles from "../ui/Button.module.css";
import {
  VERIFICATION_STATUS_PILL,
  type FiscalYear,
  type Paged,
  type VerificationListRow,
  type VerificationSeries,
  type VerificationTemplate,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/ekonomi/page.module.css";

export function VerifikatPageClient({
  verifications,
  fiscalYears,
  series,
  pageSize,
}: {
  verifications: Paged<VerificationListRow>;
  fiscalYears: FiscalYear[];
  series: VerificationSeries[];
  pageSize: number;
}) {
  const [templateOpen, setTemplateOpen] = useState(false);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const searchParams = useSearchParams();

  // The printout mirrors exactly what the list shows: forward the page's own
  // filters, dropping the paging params (the PDF is never paginated).
  const printParams = new URLSearchParams();
  for (const key of ["fiscalYearId", "seriesId", "status", "search"]) {
    const value = searchParams.get(key);
    if (value) printParams.set(key, value);
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Verifikat</div>
          <div className={shellStyles.meta}>{verifications.total.toLocaleString("sv-SE")} verifikat</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <a
            href={`${API_URL}/api/v1/verification-list/pdf?${printParams.toString()}`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Skriv ut lista (PDF)
          </a>
          <a
            href={`${API_URL}/api/v1/verification-list/csv?${printParams.toString()}`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Ladda ner CSV
          </a>
          <Button type="button" variant="ghost" onClick={() => setAllocateOpen(true)}>
            Fördela över perioder
          </Button>
          <Button type="button" variant="secondary" onClick={() => setTemplateOpen(true)}>
            Ny från mall
          </Button>
          <Link href="/ekonomi/verifikat/nytt" className={`${buttonStyles.button} ${buttonStyles.primary}`}>
            + Nytt verifikat
          </Link>
          <HelpLink chapter="ekonomi" anchor="verifikat" label="Hjälp om verifikat" />
        </div>
      </div>

      <ListToolbar placeholder="Sök beskrivning…">
        <ListFilterSelect
          param="fiscalYearId"
          allLabel="Alla räkenskapsår"
          ariaLabel="Filtrera på räkenskapsår"
          options={fiscalYears.map((y) => ({ value: y.id, label: y.label }))}
        />
        <ListFilterSelect
          param="seriesId"
          allLabel="Alla serier"
          ariaLabel="Filtrera på serie"
          options={series.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
        />
        <ListFilterSelect
          param="status"
          allLabel="Alla statusar"
          ariaLabel="Filtrera på status"
          options={Object.entries(VERIFICATION_STATUS_PILL).map(([value, pill]) => ({ value, label: pill.label }))}
        />
        <ListExportLink endpoint="/api/v1/verifications/csv" />
      </ListToolbar>

      <Table<VerificationListRow>
        columns={[
          { key: "displayNumber", label: "Nummer", width: "140px" },
          { key: "date", label: "Datum", width: "110px" },
          { key: "description", label: "Beskrivning", width: "1.4fr" },
          { key: "seriesCode", label: "Serie", width: "90px" },
          { key: "yearLabel", label: "Räkenskapsår", width: "130px" },
          { key: "status", label: "Status", width: "120px" },
        ]}
        rows={verifications.rows}
        emptyText="Inga verifikat matchar sökningen"
        renderCell={(v, key) => {
          switch (key) {
            case "displayNumber":
              return (
                <Link href={`/ekonomi/verifikat/${v.id}`} className={listStyles.rowLink}>
                  {v.displayNumber}
                </Link>
              );
            case "date":
              return v.date;
            case "description":
              return v.description;
            case "seriesCode":
              return v.seriesCode;
            case "yearLabel":
              return v.yearLabel;
            case "status": {
              const pill = VERIFICATION_STATUS_PILL[v.status];
              return <StatusPill status={pill.status} label={pill.label} compact />;
            }
            default:
              return null;
          }
        }}
      />

      <Pagination total={verifications.total} pageSize={pageSize} />

      <Modal open={templateOpen} onClose={() => setTemplateOpen(false)} title="Ny från mall" compact>
        <NewFromTemplateForm />
      </Modal>
      <AllocateDialog open={allocateOpen} onClose={() => setAllocateOpen(false)} />
    </>
  );
}

// Picks a template and opens the new-verification page filled from it.
function NewFromTemplateForm() {
  const router = useRouter();
  const [templates, setTemplates] = useState<VerificationTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ rows: VerificationTemplate[] }>("/api/v1/verification-templates")
      .then((page) => {
        if (cancelled) return;
        setTemplates(page.rows);
        setTemplateId(page.rows[0]?.id ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Mallarna kunde inte hämtas"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        if (templateId) router.push(`/ekonomi/verifikat/nytt?mall=${templateId}`);
      }}
    >
      <FormError>{error}</FormError>
      {templates !== null && templates.length === 0 && (
        <FormHint>
          Det finns inga mallar än. Spara ett verifikat som mall på verifikatkortet, eller skapa en under{" "}
          <Link href="/ekonomi/verifikatmallar">Verifikatmallar</Link>.
        </FormHint>
      )}
      {templates !== null && templates.length > 0 && (
        <Field label="Mall" htmlFor="newFromTemplate">
          <Select id="newFromTemplate" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <FormActions>
        <Button type="submit" variant="primary" disabled={!templateId}>
          Öppna
        </Button>
      </FormActions>
    </Form>
  );
}


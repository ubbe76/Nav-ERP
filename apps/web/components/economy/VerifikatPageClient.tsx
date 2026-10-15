"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError } from "../ui/Form";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { HelpLink } from "../ui/HelpLink";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import buttonStyles from "../ui/Button.module.css";
import {
  VERIFICATION_STATUS_PILL,
  type FiscalYear,
  type Paged,
  type VerificationDetail,
  type VerificationListRow,
  type VerificationSeries,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/ekonomi/page.module.css";

// NoFiscalYearForDateError/VerificationSeriesNotFoundError translated to
// fixed Swedish copy by the shared error-code dictionary — same idiom as
// economy's own formatAccountError/formatFiscalYearError
// (KontoplanPageClient/RakenskapsarPageClient).
function formatVerificationError(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte skapa verifikatet");
}

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
  const [modalOpen, setModalOpen] = useState(false);
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
          <Button type="button" variant="primary" onClick={() => setModalOpen(true)}>
            + Nytt verifikat
          </Button>
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

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nytt verifikat">
        <NewVerificationForm series={series} />
      </Modal>
    </>
  );
}

function NewVerificationForm({ series }: { series: VerificationSeries[] }) {
  const router = useRouter();
  const [seriesId, setSeriesId] = useState(series[0]?.id ?? "");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!seriesId) {
      setError("Välj en serie");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const verification = await apiFetch<VerificationDetail>("/api/v1/verifications", {
        method: "POST",
        body: JSON.stringify({ seriesId, date, description: description.trim(), rows: [] }),
      });
      router.push(`/ekonomi/verifikat/${verification.id}`);
    } catch (err) {
      setError(formatVerificationError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

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

      <Field label="Beskrivning" htmlFor="newVerificationDescription">
        <Input
          id="newVerificationDescription"
          required
          maxLength={255}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa verifikat"}
        </Button>
      </FormActions>
    </Form>
  );
}

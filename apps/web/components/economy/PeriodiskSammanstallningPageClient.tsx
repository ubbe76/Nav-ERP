"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormSaved } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  MONTH_NAMES_SV,
  type PeriodicSummaryInvoiceRef,
  type PeriodicSummaryMissingField,
  type PeriodicSummaryResponse,
  type PeriodicSummaryRow,
  type PeriodicSummaryWarningKind,
  type VatReportingSettings,
} from "../../lib/types";
import { VAT_BOX_LABELS } from "../../lib/vatBoxes";
import styles from "./PeriodiskSammanstallning.module.css";

// One selectable period — a calendar month or a calendar quarter (the
// periodisk sammanställning follows the calendar, not the fiscal year). The
// value IS the range: "from|to".
type PeriodOption = { value: string; label: string };

const MONTHS_OFFERED = 36;
const QUARTERS_OFFERED = 12;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function monthValue(year: number, month: number): string {
  return `${year}-${pad(month)}-01|${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`;
}

function quarterValue(year: number, quarter: number): string {
  const first = (quarter - 1) * 3 + 1;
  const last = first + 2;
  return `${year}-${pad(first)}-01|${year}-${pad(last)}-${pad(lastDayOfMonth(year, last))}`;
}

// Month and quarter options, newest first, from "today" (taken on the server
// in Swedish time and handed in, so server and client render the same list).
function buildPeriodOptions(today: string): { months: PeriodOption[]; quarters: PeriodOption[] } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  const months: PeriodOption[] = [];
  for (let i = 0; i < MONTHS_OFFERED; i++) {
    const index = year * 12 + (month - 1) - i;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    months.push({ value: monthValue(y, m), label: `${capitalize(MONTH_NAMES_SV[m - 1]!)} ${y}` });
  }

  const quarters: PeriodOption[] = [];
  const currentQuarter = Math.ceil(month / 3);
  for (let i = 0; i < QUARTERS_OFFERED; i++) {
    const index = year * 4 + (currentQuarter - 1) - i;
    const y = Math.floor(index / 4);
    const q = (index % 4) + 1;
    const names = [0, 1, 2].map((offset) => MONTH_NAMES_SV[(q - 1) * 3 + offset]!.slice(0, 3));
    quarters.push({ value: quarterValue(y, q), label: `Kvartal ${q} ${y} (${names[0]}–${names[2]})` });
  }
  return { months, quarters };
}

// Varor ska redovisas per kalendermånad: the preselected period is the month
// before this one — the one that has just ended and is about to be reported.
function previousMonthValue(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? monthValue(year - 1, 12) : monthValue(year, month - 1);
}

// Whole kronor, as the file states them.
function formatKronor(amount: number): string {
  return amount.toLocaleString("sv-SE", { maximumFractionDigits: 0 });
}

function toDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const WARNING_HEADINGS: Record<PeriodicSummaryWarningKind, string> = {
  missing_vat_number: "Saknat momsnummer",
  invalid_vat_number: "Ogiltigt momsnummer",
  non_eu_country: "Kund utanför EU",
  ledger_difference: "Skillnad mot bokföringen",
};

const MISSING_TEXTS: Record<PeriodicSummaryMissingField, string> = {
  vatNumber: "Företagets momsregistreringsnummer saknas eller har fel form",
  contactName: "Kontaktperson saknas",
  contactPhone: "Telefon saknas eller har fel form",
};

function InvoiceLinks({ invoices }: { invoices: PeriodicSummaryInvoiceRef[] }) {
  return (
    <span className={styles.links}>
      {invoices.map((invoice) => (
        <GatedLink key={invoice.id} href={`/forsaljning/fakturor/${invoice.id}`}>
          {invoice.invoiceNumber}
        </GatedLink>
      ))}
    </span>
  );
}

export function PeriodiskSammanstallningPageClient({
  today,
  defaultFrom,
  defaultTo,
}: {
  today: string;
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const options = useMemo(() => buildPeriodOptions(today), [today]);
  const [range, setRange] = useState<string>(
    defaultFrom && defaultTo ? `${defaultFrom}|${defaultTo}` : previousMonthValue(today)
  );
  const [summary, setSummary] = useState<PeriodicSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after the contact details are saved, to read the summary again
  // (what the file still lacks changes with them) — silently, so the card the
  // user just saved in stays on screen.
  const [reload, setReload] = useState(0);
  const silentReload = useRef(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!range) return;
    const [from, to] = range.split("|") as [string, string];
    const params = new URLSearchParams({ from, to });
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });

    let cancelled = false;
    const silent = silentReload.current;
    silentReload.current = false;
    if (!silent) {
      setLoading(true);
      setError(null);
      setFileError(null);
    }
    apiFetch<PeriodicSummaryResponse>(`/api/v1/periodic-summary?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Kunde inte hämta sammanställningen."));
          setSummary(null);
        }
      })
      .finally(() => {
        if (!cancelled && !silent) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [range, reload]);

  // The file as Skatteverket wants it. A plain <a download> would save the
  // API's JSON error body as the file, so the request goes through fetch and a
  // refusal (409 empty / reporter incomplete, 400 amount too large) is shown
  // on the page.
  async function downloadFile() {
    if (!summary) return;
    setFileBusy(true);
    setFileError(null);
    try {
      const params = new URLSearchParams({ from: summary.from, to: summary.to });
      const res = await fetch(`${API_URL}/api/v1/periodic-summary/file?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code, body);
      }
      const named = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
      toDownload(await res.blob(), named ?? `PeriodiskSammanstallning${summary.periodCode.replace("-", "K")}.txt`);
    } catch (err) {
      setFileError(apiErrorMessage(err, "Kunde inte skapa filen."));
    } finally {
      setFileBusy(false);
    }
  }

  const rowsWithId = useMemo(() => (summary ? summary.rows.map((row) => ({ ...row, id: row.vatNumber })) : []), [summary]);
  const inOptions = [...options.months, ...options.quarters].some((option) => option.value === range);

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <Field label="Period" htmlFor="periodicRange">
          <Select id="periodicRange" size="md" value={range} onChange={(e) => setRange(e.target.value)}>
            {!inOptions && <option value={range}>{range.replace("|", " – ")}</option>}
            <optgroup label="Månad">
              {options.months.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Kvartal">
              {options.quarters.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <FormHint>
          Varor till företag i andra EU-länder redovisas per kalendermånad. Kvartal gäller bara om Skatteverket har
          beviljat det eller om du bara säljer tjänster. Förvald period är föregående månad.
        </FormHint>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar sammanställningen…</FormHint>}

      {summary && !loading && (
        <>
          {summary.warnings.length > 0 && (
            <FormNotice style={{ marginBottom: 20 }}>
              {summary.warnings.map((warning, index) => (
                <div key={`${warning.kind}-${index}`} className={styles.warningBlock}>
                  <strong>{WARNING_HEADINGS[warning.kind]}</strong> — {warning.message}
                  {warning.invoices.length > 0 && (
                    <>
                      {" "}
                      <span className={styles.warningInvoices}>
                        (<InvoiceLinks invoices={warning.invoices} />)
                      </span>
                    </>
                  )}
                </div>
              ))}
            </FormNotice>
          )}

          <Card maxWidth="none" style={{ marginBottom: 20 }}>
            <div className={styles.toolbar}>
              <div className={styles.toolbarTitle}>
                Periodisk sammanställning {summary.from} – {summary.to}
              </div>
              <Button type="button" variant="secondary" onClick={downloadFile} disabled={fileBusy}>
                {fileBusy ? "Skapar filen…" : "Ladda ned fil"}
              </Button>
            </div>
            <FormError margin="below">{fileError}</FormError>
            <Table<PeriodicSummaryRow & { id: string }>
              columns={[
                { key: "vatNumber", label: "Momsnummer", width: "170px" },
                { key: "customers", label: "Kund", width: "minmax(180px, 1.2fr)" },
                { key: "goods", label: "Varor", width: "120px", align: "right" },
                { key: "triangular", label: "Trepartshandel", width: "140px", align: "right" },
                { key: "services", label: "Tjänster", width: "120px", align: "right" },
                { key: "invoices", label: "Fakturor", width: "minmax(180px, 1.2fr)" },
              ]}
              rows={rowsWithId}
              emptyText="Ingen EU-försäljning i perioden"
              footer={{
                vatNumber: <strong>Summa</strong>,
                goods: <strong className="num">{formatKronor(summary.totals.goods)}</strong>,
                services: <strong className="num">{formatKronor(summary.totals.services)}</strong>,
              }}
              renderCell={(row, key) => {
                switch (key) {
                  case "vatNumber":
                    return row.vatNumber;
                  case "customers":
                    return (
                      <span className={styles.links}>
                        {row.customers.map((customer) => (
                          <GatedLink key={customer.id} href={`/kunder/${customer.id}`}>
                            {customer.name}
                          </GatedLink>
                        ))}
                      </span>
                    );
                  case "goods":
                    return <span className="num">{formatKronor(row.goods)}</span>;
                  case "triangular":
                    // Trepartshandel has no momskod — always empty.
                    return <span className="num">{row.triangular === null ? "–" : formatKronor(row.triangular)}</span>;
                  case "services":
                    return <span className="num">{formatKronor(row.services)}</span>;
                  case "invoices":
                    return <InvoiceLinks invoices={row.invoices} />;
                  default:
                    return null;
                }
              }}
            />
            <FormHint>
              Belopp i hela kronor, summerade per köparens momsnummer; kreditfakturor räknas negativt. Trepartshandel
              redovisas inte här — Nav har ingen momskod för den.
            </FormHint>
          </Card>

          <Card maxWidth="none" style={{ marginBottom: 20 }}>
            <div className={styles.toolbarTitle} style={{ marginBottom: 8 }}>
              Avstämning mot momsrapporten
            </div>
            <Table<{ id: string; box: "35" | "39"; booked: number; summary: number; difference: number }>
              columns={[
                { key: "box", label: "Ruta", width: "minmax(240px, 2fr)" },
                { key: "booked", label: "Bokfört", width: "130px", align: "right" },
                { key: "summary", label: "Sammanställning", width: "150px", align: "right" },
                { key: "difference", label: "Skillnad", width: "130px", align: "right" },
              ]}
              rows={[
                {
                  id: "35",
                  box: "35",
                  booked: summary.ledger.box35,
                  summary: summary.totals.goods,
                  difference: summary.differences.goods,
                },
                {
                  id: "39",
                  box: "39",
                  booked: summary.ledger.box39,
                  summary: summary.totals.services,
                  difference: summary.differences.services,
                },
              ]}
              renderCell={(row, key) => {
                switch (key) {
                  case "box":
                    return `Ruta ${row.box} · ${VAT_BOX_LABELS[row.box]}`;
                  case "booked":
                    return <span className="num">{formatKronor(row.booked)}</span>;
                  case "summary":
                    return <span className="num">{formatKronor(row.summary)}</span>;
                  case "difference":
                    // The API compares in öre and returns the exact
                    // difference (kronor with öre), 0 only when they agree.
                    if (row.difference === 0) {
                      return <span className={`num ${styles.differenceOk}`}>Stämmer</span>;
                    }
                    return (
                      <span className={`num ${styles.differenceBad}`}>
                        {row.difference.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            />
            <FormHint>
              Bokfört är ruta 35 och 39 i{" "}
              <GatedLink href={{ pathname: "/ekonomi/momsrapport", query: { from: summary.from, to: summary.to } }}>
                momsrapporten
              </GatedLink>{" "}
              för samma period. Avstämningen görs i ören, och skillnaden visas med ören. En skillnad beror oftast på ett manuellt
              verifikat på 3108 eller 3308, på en faktura med fel momskod eller på en faktura utan giltigt momsnummer.
            </FormHint>
          </Card>

          <ReporterCard
            summary={summary}
            onSaved={() => {
              silentReload.current = true;
              setReload((value) => value + 1);
            }}
          />
        </>
      )}
    </>
  );
}

// Uppgifterna filen bär: företagets momsregistreringsnummer (Företagsuppgifter,
// read-only here) och kontaktpersonen hos företaget — saved on their own with
// PATCH /settings/vat-reporting, independent of the period above.
function ReporterCard({ summary, onSaved }: { summary: PeriodicSummaryResponse; onSaved: () => void }) {
  const { reporter, missing } = summary;
  const [contactName, setContactName] = useState(reporter.contactName ?? "");
  const [contactPhone, setContactPhone] = useState(reporter.contactPhone ?? "");
  const [contactEmail, setContactEmail] = useState(reporter.contactEmail ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch<VatReportingSettings>("/api/v1/settings/vat-reporting", {
        method: "PATCH",
        // "" clears a field (stored as empty).
        body: JSON.stringify({
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim(),
          contactEmail: contactEmail.trim(),
        }),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara kontaktuppgifterna."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth={620}>
      <div className={styles.toolbarTitle} style={{ marginBottom: 8 }}>
        Kontaktuppgifter i filen
      </div>
      <p className={styles.reporterVat}>
        Företagets momsregistreringsnummer: <strong>{reporter.vatNumber ?? "saknas"}</strong>{" "}
        <GatedLink href="/system/foretagsinfo">Öppna Företagsuppgifter</GatedLink>
      </p>
      {missing.length > 0 && (
        <FormNotice style={{ marginBottom: 12 }}>
          Filen kan inte skapas än:
          <ul className={styles.missingList}>
            {missing.map((field) => (
              <li key={field}>{MISSING_TEXTS[field]}</li>
            ))}
          </ul>
        </FormNotice>
      )}
      <Form onSubmit={save}>
        <FormError>{error}</FormError>
        <Field label="Kontaktperson" htmlFor="periodicContactName">
          <Input
            id="periodicContactName"
            maxLength={35}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
        </Field>
        <Field label="Telefon" htmlFor="periodicContactPhone">
          <Input
            id="periodicContactPhone"
            size="md"
            maxLength={17}
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </Field>
        <Field label="E-post" htmlFor="periodicContactEmail">
          <Input
            id="periodicContactEmail"
            type="email"
            maxLength={255}
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
        </Field>
        <FormHint>
          Skatteverket kräver kontaktperson (högst 35 tecken) och telefon (högst 17 tecken: siffror med bindestreck
          efter riktnumret, till exempel 08-1234567, eller inledande + för ett utlandsnummer); e-post är frivillig.
          Uppgifterna sparas i inställningarna och följer med varje fil.
        </FormHint>
        <FormActions>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

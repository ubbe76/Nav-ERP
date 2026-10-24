"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice, FormRow, FormSaved } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney, round2 } from "../../lib/format";
import { GatedLink } from "../ui/GatedLink";
import { stockholmToday } from "../../lib/date";
import {
  MONTH_NAMES_SV,
  type AccountingPeriod,
  type FiscalYear,
  type FiscalYearDetail,
  type VatReportingSettings,
  type VatReportResponse,
  type VatSettlementAccount,
} from "../../lib/types";
import {
  VAT_BOX_49_LABEL,
  VAT_BOX_LABELS,
  VAT_REPORTING_PERIODS,
  VAT_REPORTING_PERIOD_LABELS,
  type VatBox,
  type VatBoxSetting,
  type VatDeclarationBox,
  type VatReportingPeriod,
} from "../../lib/vatBoxes";
import { ruleBoxProblemText, type VatCodeView } from "../../lib/vatCodes";
import { ImportVatDialog } from "./ImportVatDialog";
import styles from "./Momsrapport.module.css";

// One selectable redovisningsperiod — a month (one accounting period), a
// complete calendar quarter (three) or the whole fiscal year. The value IS
// the range: "from|to".
type PeriodOption = { value: string; label: string };
type PeriodOptions = { months: PeriodOption[]; quarters: PeriodOption[]; years: PeriodOption[] };

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function monthIndex(date: string): number {
  return Number(date.slice(5, 7)) - 1;
}

// "2026-01-01" -> "Januari 2026" — same wording as Räkenskapsår's period
// table (RakenskapsarPageClient's monthLabel).
function monthOptionLabel(period: AccountingPeriod): string {
  return `${capitalize(MONTH_NAMES_SV[monthIndex(period.startDate)]!)} ${period.startDate.slice(0, 4)}`;
}

// "Helår 2026", or "Helår 2025/2026" for a brutet räkenskapsår.
function yearOptionLabel(first: AccountingPeriod, last: AccountingPeriod): string {
  const from = first.startDate.slice(0, 4);
  const to = last.endDate.slice(0, 4);
  return from === to ? `Helår ${from}` : `Helår ${from}/${to}`;
}

// Month, quarter and whole-year options from the fiscal year's period list.
// Quarters are CALENDAR quarters (Skatteverket's redovisningsperioder),
// offered only when the year contains all three months — a brutet år's
// clipped edge quarters are simply not offered. The year option is the whole
// fiscal year: the API accepts any exact run of accounting periods.
function buildPeriodOptions(periods: AccountingPeriod[]): PeriodOptions {
  const months = periods.map((period) => ({
    value: `${period.startDate}|${period.endDate}`,
    label: monthOptionLabel(period),
  }));

  const quarters: PeriodOption[] = [];
  const byKey = new Map(periods.map((period) => [period.startDate.slice(0, 7), period]));
  for (const period of periods) {
    const month = monthIndex(period.startDate);
    if (month % 3 !== 0) continue; // only quarter starts (jan/apr/jul/okt)
    const year = period.startDate.slice(0, 4);
    const second = byKey.get(`${year}-${String(month + 2).padStart(2, "0")}`);
    const third = byKey.get(`${year}-${String(month + 3).padStart(2, "0")}`);
    if (!second || !third) continue;
    const quarterNumber = month / 3 + 1;
    const shortNames = [month, month + 1, month + 2].map((m) => MONTH_NAMES_SV[m]!.slice(0, 3));
    quarters.push({
      value: `${period.startDate}|${third.endDate}`,
      label: `Kvartal ${quarterNumber} ${year} (${shortNames[0]}–${shortNames[2]})`,
    });
  }

  const first = periods[0];
  const last = periods[periods.length - 1];
  const years =
    first && last ? [{ value: `${first.startDate}|${last.endDate}`, label: yearOptionLabel(first, last) }] : [];
  return { months, quarters, years };
}

// The option to preselect for the company's Redovisningsperiod för moms: the
// most recently ENDED month/quarter (the one you are about to declare), else
// the first; the whole fiscal year for helår. A year without quarters falls
// back to months.
function defaultRange(options: PeriodOptions, preferred: VatReportingPeriod | null, today: string): string {
  const latestEnded = (list: PeriodOption[]) => {
    const ended = list.filter((option) => option.value.split("|")[1]! < today);
    return ended[ended.length - 1] ?? list[0];
  };
  if (preferred === "year" && options.years[0]) return options.years[0].value;
  if (preferred === "quarter") {
    const quarter = latestEnded(options.quarters);
    if (quarter) return quarter.value;
  }
  return latestEnded(options.months)?.value ?? "";
}

// Fixed Swedish copy for the API's 400/409s, from the shared error-code
// dictionary — same idiom as the sibling clients' formatError helpers.
// "accounting-period-locked" is pre-empted with page-specific copy: the
// generic dictionary text doesn't point the user at the fix (unlocking the
// period under Räkenskapsår) the way this page's own message does.
function formatVatReportError(err: unknown): string {
  if (err instanceof ApiError && err.code === "accounting-period-locked") {
    return "Perioden är låst — lås upp den under Räkenskapsår innan omföringen bokförs.";
  }
  return apiErrorMessage(err, "Något gick fel.");
}

// The declaration laid out like Skatteverkets blankett (SKV 4700): the groups
// in the form's own order — import (H) sits between D and E — and, inside a
// group, the boxes in numeric order. Each box exactly once: the compile-time
// check below fails when a box is missing from the layout.
const BLANKETT = [
  { id: "A", heading: "A · Momspliktig försäljning eller uttag exklusive moms", boxes: ["05", "06", "07", "08"] },
  { id: "B", heading: "B · Utgående moms på försäljning eller uttag i ruta 05–08", boxes: ["10", "11", "12"] },
  { id: "C", heading: "C · Momspliktiga inköp vid omvänd skattskyldighet", boxes: ["20", "21", "22", "23", "24"] },
  { id: "D", heading: "D · Utgående moms på inköp i ruta 20–24", boxes: ["30", "31", "32"] },
  { id: "H", heading: "H · Import", boxes: ["50", "60", "61", "62"] },
  {
    id: "E",
    heading: "E · Försäljning m.m. som är undantagen från moms",
    boxes: ["35", "36", "37", "38", "39", "40", "41", "42"],
  },
  { id: "F", heading: "F · Ingående moms", boxes: ["48"] },
  { id: "G", heading: "G · Moms att betala eller få tillbaka", boxes: ["49"] },
] as const;

type LayoutBox = (typeof BLANKETT)[number]["boxes"][number];
const everyBoxIsInTheLayout: Exclude<VatDeclarationBox, LayoutBox> extends never ? true : never = true;
void everyBoxIsInTheLayout;

type RutaRow =
  | { id: string; kind: "heading"; label: string }
  | { id: string; kind: "box"; box: VatDeclarationBox; label: string; highlight: boolean };

const RUTA_ROWS: RutaRow[] = BLANKETT.flatMap((group): RutaRow[] => [
  { id: `h-${group.id}`, kind: "heading", label: group.heading },
  ...group.boxes.map(
    (box): RutaRow => ({
      id: box,
      kind: "box",
      box,
      label: box === "49" ? VAT_BOX_49_LABEL : VAT_BOX_LABELS[box as VatBox],
      highlight: box === "49",
    })
  ),
]);

// Whole kronor as the declaration states them.
function formatKronor(amount: number): string {
  return amount.toLocaleString("sv-SE", { maximumFractionDigits: 0 });
}

// "ruta 35" / "ingen ruta" / "ingen ruta angiven".
function boxPhrase(box: VatBoxSetting | null): string {
  if (box === null) return "ingen ruta angiven";
  if (box === "none") return "ingen ruta";
  return `ruta ${box}`;
}

// The two accounts the momsomföring books on (Konteringsregler → Standardkonton).
const SETTLEMENT_ROLE_LABELS = {
  settlement: "Redovisningskonto för moms",
  rounding: "Öres- och kronutjämning",
} as const;

// "YYYY-MM-DD" -> "YYYYMM" — the file's period, named after the LAST month.
function filePeriod(date: string): string {
  return `${date.slice(0, 4)}${date.slice(5, 7)}`;
}

type PostingLine = { id: string; account: string; debit: number; credit: number };

// What the momsomföring books: every emptied account reversed, ruta 49 in
// whole kronor on the redovisningskonto and the öre difference on öres- och
// kronutjämning. Positive account amounts are kredit, negative debet.
function settlementLines(report: VatReportResponse): PostingLine[] {
  const lines: PostingLine[] = report.settlement.rows.map((row) => ({
    id: row.accountId,
    account: `${row.accountNumber} · ${row.accountName}`,
    // row.net = debit − credit of the period: the omföring books the opposite.
    debit: row.net < 0 ? -row.net : 0,
    credit: row.net > 0 ? row.net : 0,
  }));
  const add = (id: string, account: VatSettlementAccount) => {
    if (account.amount === 0) return;
    lines.push({
      id,
      account: `${account.number} · ${account.name ?? "Konto saknas i kontoplanen"}`,
      debit: account.amount < 0 ? -account.amount : 0,
      credit: account.amount > 0 ? account.amount : 0,
    });
  };
  add("settlement-account", report.settlement.settlementAccount);
  add("rounding-account", report.settlement.roundingAccount);
  return lines;
}

function money(amount: number): string {
  return amount === 0 ? "" : formatMoney(amount);
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

export function MomsrapportPageClient({
  fiscalYears,
  defaultFrom,
  defaultTo,
  reporting,
  vatCodes,
}: {
  fiscalYears: FiscalYear[];
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
  // null when the settings could not be read — the page then falls back to
  // months and hides the setting.
  reporting: VatReportingSettings | null;
  vatCodes: VatCodeView[];
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Initial year: the one covering ?from= when present, else — for a company
  // that declares the whole year (Helår) — the latest year that has ENDED (the
  // running year is not over, so there is nothing to declare in it yet), else
  // the year covering TODAY (declaring current-year periods is the normal
  // case — the list is newest-first, so [0] may be a future year), else the
  // latest.
  const initialYearId = useMemo(() => {
    if (defaultFrom) {
      const covering = fiscalYears.find((year) => year.startDate <= defaultFrom && defaultFrom <= year.endDate);
      if (covering) return covering.id;
    }
    const today = stockholmToday();
    if (reporting?.period === "year") {
      const latestEnded = fiscalYears
        .filter((year) => year.endDate < today)
        .sort((a, b) => (a.endDate < b.endDate ? 1 : a.endDate > b.endDate ? -1 : 0))[0];
      if (latestEnded) return latestEnded.id;
    }
    const current = fiscalYears.find((year) => year.startDate <= today && today <= year.endDate);
    return current?.id ?? fiscalYears[0]?.id ?? "";
  }, [fiscalYears, defaultFrom, reporting]);

  const [yearId, setYearId] = useState(initialYearId);
  const [yearDetail, setYearDetail] = useState<FiscalYearDetail | null>(null);
  const [range, setRange] = useState<string>(defaultFrom && defaultTo ? `${defaultFrom}|${defaultTo}` : "");
  // Mirrors `range` for async guards (settle()'s post-refresh check).
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [report, setReport] = useState<VatReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settledNumber, setSettledNumber] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<{ message: string; code?: string } | null>(null);

  // Load the selected year's periods (GET /fiscal-years/:id is the only
  // source of period rows).
  useEffect(() => {
    if (!yearId) return;
    let cancelled = false;
    setYearDetail(null);
    apiFetch<FiscalYearDetail>(`/api/v1/fiscal-years/${yearId}`)
      .then((detail) => {
        if (!cancelled) setYearDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setError("Kunde inte hämta räkenskapsårets perioder.");
      });
    return () => {
      cancelled = true;
    };
  }, [yearId]);

  const options = useMemo(
    () => (yearDetail ? buildPeriodOptions(yearDetail.periods) : { months: [], quarters: [], years: [] }),
    [yearDetail]
  );

  // Default period once the year's periods arrive and nothing is selected:
  // the company's Redovisningsperiod för moms decides whether that is a
  // month, a quarter or the whole year.
  useEffect(() => {
    if (!yearDetail || range !== "") return;
    const fallback = defaultRange(options, reporting?.period ?? null, stockholmToday());
    if (fallback) setRange(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when periods land
  }, [yearDetail]);

  // Fetch the report on every range change; URL kept in sync like huvudboken.
  useEffect(() => {
    if (!range) return;
    const [from, to] = range.split("|") as [string, string];
    const params = new URLSearchParams({ from, to });
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });

    let cancelled = false;
    setLoading(true);
    setError(null);
    setFileError(null);
    setSettledNumber(null);
    apiFetch<VatReportResponse>(`/api/v1/vat-report?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatVatReportError(err));
          setReport(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [range]);

  const activeSettlement = report?.settlements.find((settlement) => !settlement.reversed) ?? null;
  const reversedSettlements = report?.settlements.filter((settlement) => settlement.reversed) ?? [];
  const hasMovement = (report?.settlement.rows.length ?? 0) > 0;
  const endPeriodLocked = report ? report.periods[report.periods.length - 1]?.status === "locked" : false;
  const lines = useMemo(() => (report ? settlementLines(report) : []), [report]);

  async function settle() {
    if (!report) return;
    const settledRange = `${report.from}|${report.to}`;
    setSettling(true);
    setSettleError(null);
    try {
      const result = await apiFetch<{ verification: { id: string; displayNumber: string } }>(
        "/api/v1/vat-report/settle",
        { method: "POST", body: JSON.stringify({ from: report.from, to: report.to }) }
      );
      setConfirmOpen(false);
      setSettledNumber(result.verification.displayNumber);
      // Re-fetch: the report's boxes stay unchanged (settlements are
      // excluded), but the settlement list and button state flip.
      const params = new URLSearchParams({ from: report.from, to: report.to });
      const refreshed = await apiFetch<VatReportResponse>(`/api/v1/vat-report?${params.toString()}`);
      // Guard against the user switching period while the refresh was in
      // flight — a stale response must not clobber the newer range's report.
      if (rangeRef.current === settledRange) setReport(refreshed);
    } catch (err) {
      setSettleError(formatVatReportError(err));
    } finally {
      setSettling(false);
    }
  }

  // The declaration as Skatteverket's file. A plain <a download> would save
  // the API's JSON error body as the file, so the request goes through fetch
  // and a refusal (409 vat-file-org-number-missing) is shown on the page.
  async function downloadFile() {
    if (!report) return;
    setFileBusy(true);
    setFileError(null);
    try {
      const params = new URLSearchParams({ from: report.from, to: report.to });
      const res = await fetch(`${API_URL}/api/v1/vat-report/file?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code, body);
      }
      const named = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
      toDownload(await res.blob(), named ?? `momsdeklaration-${filePeriod(report.to)}.xml`);
    } catch (err) {
      setFileError({
        message: apiErrorMessage(err, "Kunde inte skapa filen."),
        code: err instanceof ApiError ? err.code : undefined,
      });
    } finally {
      setFileBusy(false);
    }
  }

  const warnings = report?.warnings;
  const hasWarnings =
    warnings !== undefined &&
    (warnings.unassignedAccounts.length > 0 ||
      warnings.vatCodeBoxMismatches.length > 0 ||
      warnings.ruleBoxMismatches.length > 0 ||
      warnings.settlementAccountProblems.length > 0);
  // The redovisningskonto / öres account carries a box the momsomföring
  // empties: the report shows, only Bokför momsomföring is refused.
  const settlementBlocked = (warnings?.settlementAccountProblems.length ?? 0) > 0;

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormRow columns={2}>
          <Field label="Räkenskapsår" htmlFor="vatYear">
            <Select
              id="vatYear"
              value={yearId}
              onChange={(e) => {
                setYearId(e.target.value);
                setRange("");
                setReport(null);
              }}
            >
              {fiscalYears.length === 0 && <option value="">— Inga räkenskapsår —</option>}
              {fiscalYears.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period" htmlFor="vatPeriod">
            <Select id="vatPeriod" value={range} onChange={(e) => setRange(e.target.value)} disabled={!yearDetail}>
              <option value="">— Välj period —</option>
              {options.months.length > 0 && (
                <optgroup label="Månad">
                  {options.months.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {options.quarters.length > 0 && (
                <optgroup label="Kvartal">
                  {options.quarters.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {options.years.length > 0 && (
                <optgroup label="Helår">
                  {options.years.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
        </FormRow>
        {activeSettlement && (
          <FormNotice>
            Perioden överlappar en deklarerad månad — omför momsomföringen först om du vill deklarera om.
          </FormNotice>
        )}
        {reporting && (
          <>
            <hr className={styles.divider} />
            <ReportingPeriodSetting initial={reporting.period} />
          </>
        )}
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar momsrapporten…</FormHint>}
      {fiscalYears.length === 0 && <p>Skapa ett räkenskapsår under Ekonomi → Räkenskapsår först.</p>}

      {report && !loading && (
        <>
          {hasWarnings && warnings && (
            <FormNotice style={{ marginBottom: 20 }}>
              {warnings.unassignedAccounts.length > 0 && (
                <div className={styles.warningBlock}>
                  <strong>Konton utan momsruta</strong> — rörelserna räknas inte in i någon ruta. Ange momsruta i
                  kontoplanen:
                  <ul className={styles.warningList}>
                    {warnings.unassignedAccounts.map((account) => (
                      <li key={account.accountNumber}>
                        <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: account.accountNumber } }}>
                          {account.accountNumber} · {account.accountName}
                        </GatedLink>{" "}
                        — {formatMoney(account.net)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.vatCodeBoxMismatches.length > 0 && (
                <div className={styles.warningBlock}>
                  <strong>Momskoder med fel momsruta</strong> — rörelserna hamnar inte i rätt ruta. Rätta momsrutan i
                  kontoplanen eller kontot på momskoden:
                  <ul className={styles.warningList}>
                    {warnings.vatCodeBoxMismatches.map((mismatch) => (
                      <li key={`${mismatch.code}-${mismatch.slot}`}>
                        Momskod <GatedLink href="/ekonomi/momskoder">{mismatch.code}</GatedLink>: konto{" "}
                        <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: mismatch.accountNumber } }}>
                          {mismatch.accountNumber}
                        </GatedLink>{" "}
                        {mismatch.problem === "missing_account" ? (
                          <>finns inte i kontoplanen</>
                        ) : (
                          <>
                            har <strong>{boxPhrase(mismatch.actualBox)}</strong> men ska ha{" "}
                            <strong>{boxPhrase(mismatch.expectedBox)}</strong>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.ruleBoxMismatches.length > 0 && (
                <div className={styles.warningBlock}>
                  <strong>Konteringsregler med fel momsruta</strong> — regeln ersätter momskodens eget konto, så kontot
                  måste hamna i rätt ruta:
                  <ul className={styles.warningList}>
                    {warnings.ruleBoxMismatches.map((mismatch) => (
                      <li key={`${mismatch.ruleId}-${mismatch.slot}`}>
                        Konteringsregel{" "}
                        <GatedLink href="/ekonomi/konteringsregler">
                          {mismatch.groupCode} {mismatch.groupName} / {mismatch.code ?? "Alla momskoder"}
                        </GatedLink>
                        : {mismatch.slot === "revenue" ? "intäktskonto" : "kostnadskonto"}{" "}
                        <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: mismatch.accountNumber } }}>
                          {mismatch.accountNumber}
                        </GatedLink>{" "}
                        <strong>{ruleBoxProblemText(mismatch)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.settlementAccountProblems.length > 0 && (
                <div className={styles.warningBlock}>
                  <strong>Redovisningskonton med momsruta</strong> — momsomföringen tömmer kontot, så den kan inte
                  bokföras förrän kontot har en annan ruta eller ett annat konto har valts under{" "}
                  <GatedLink href="/ekonomi/konteringsregler">Konteringsregler</GatedLink>. Rapporten visas ändå:
                  <ul className={styles.warningList}>
                    {warnings.settlementAccountProblems.map((problem) => (
                      <li key={problem.role}>
                        {SETTLEMENT_ROLE_LABELS[problem.role]}{" "}
                        <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: problem.accountNumber } }}>
                          {problem.accountNumber}
                        </GatedLink>{" "}
                        har <strong>{boxPhrase(problem.vatBox)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </FormNotice>
          )}

          <Card maxWidth="none" style={{ marginBottom: 20 }}>
            <div className={styles.toolbar}>
              <div className={styles.toolbarTitle}>
                Momsdeklaration {report.from} – {report.to}
              </div>
              <div className={styles.toolbarActions}>
                <Button type="button" variant="secondary" onClick={downloadFile} disabled={fileBusy}>
                  {fileBusy ? "Skapar filen…" : "Ladda ned fil till Skatteverket"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setImportOpen(true)}>
                  Bokför importmoms
                </Button>
              </div>
            </div>
            <FormError margin="below">
              {fileError && (
                <>
                  {fileError.message}
                  {fileError.code === "vat-file-org-number-missing" && (
                    <>
                      {" "}
                      <GatedLink href="/system/foretagsinfo">Öppna Företagsuppgifter</GatedLink>
                    </>
                  )}
                </>
              )}
            </FormError>
            <Table<RutaRow>
              columns={[
                { key: "ruta", label: "Ruta", width: "60px" },
                { key: "label", label: "Beskrivning", width: "1.8fr" },
                { key: "amount", label: "Belopp", width: "150px", align: "right" },
                { key: "rounded", label: "Att deklarera (hela kr)", width: "170px", align: "right" },
              ]}
              rows={RUTA_ROWS}
              renderCell={(row, key) => {
                if (row.kind === "heading") {
                  return key === "label" ? <strong className={styles.heading}>{row.label}</strong> : "";
                }
                const amount = report.boxes[row.box];
                const rounded = report.roundedBoxes[row.box];
                // A declaration form lists every box; the ones without an
                // amount step back so the used ones stand out.
                const dim = row.highlight || (amount !== 0 || rounded !== 0) ? undefined : styles.dim;
                const strong = row.highlight ? { fontWeight: 600 } : undefined;
                switch (key) {
                  case "ruta":
                    return <span className={dim}>{row.box}</span>;
                  case "label":
                    return <span className={dim}>{row.highlight && rounded < 0 ? "Moms att få tillbaka" : row.label}</span>;
                  case "amount":
                    return (
                      <span className={["num", dim].filter(Boolean).join(" ")} style={strong}>
                        {formatMoney(amount)}
                      </span>
                    );
                  case "rounded":
                    return (
                      <span className={["num", dim].filter(Boolean).join(" ")} style={strong}>
                        {formatKronor(rounded)}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            />
            <FormHint>
              <em>Belopp</em> visas med ören för att stämma mot huvudboken. Deklarationen och filen till Skatteverket
              anges i hela kronor — närmaste hela krona per ruta. Ruta 49 räknas på de avrundade rutorna.
            </FormHint>
          </Card>

          <Card maxWidth="none">
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Momsomföring</div>
            <Table<VatReportResponse["settlement"]["rows"][number] & { id: string }>
              columns={[
                { key: "account", label: "Konto", width: "1.6fr" },
                { key: "box", label: "Ruta", width: "70px" },
                { key: "debit", label: "Debet", width: "130px", align: "right" },
                { key: "credit", label: "Kredit", width: "130px", align: "right" },
                { key: "net", label: "Netto", width: "130px", align: "right" },
              ]}
              rows={report.settlement.rows.map((row) => ({ ...row, id: row.accountId }))}
              emptyText="Inga momskonton har rört sig i perioden"
              renderCell={(row, key) => {
                switch (key) {
                  case "account":
                    return `${row.accountNumber} · ${row.accountName}`;
                  case "box":
                    return row.vatBox ?? "—";
                  case "debit":
                    return <span className="num">{formatMoney(row.debit)}</span>;
                  case "credit":
                    return <span className="num">{formatMoney(row.credit)}</span>;
                  case "net":
                    return <span className="num">{formatMoney(row.net)}</span>;
                  default:
                    return null;
                }
              }}
            />
            {hasMovement && (
              <div className={styles.summary}>
                <div className={styles.summaryLine}>
                  <span className={styles.summaryLabel}>
                    Redovisningskonto för moms ({accountLabel(report.settlement.settlementAccount)}) — ruta 49 i hela
                    kronor
                  </span>
                  <span className="num">{settlementAmountText(report.settlement.settlementAccount)}</span>
                </div>
                <div className={styles.summaryLine}>
                  <span className={styles.summaryLabel}>
                    Öres- och kronutjämning ({accountLabel(report.settlement.roundingAccount)}) — öresdifferensen
                  </span>
                  <span className="num">{settlementAmountText(report.settlement.roundingAccount)}</span>
                </div>
              </div>
            )}

            {settledNumber && (
              <FormHint>
                Momsomföring bokförd som verifikat {settledNumber}. Lås perioden under Ekonomi → Räkenskapsår.
              </FormHint>
            )}

            {activeSettlement ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <StatusPill status="done" label="Deklarerad" />
                <span>
                  Momsomföring bokförd{" "}
                  <Link href={`/ekonomi/verifikat/${activeSettlement.verificationId}`}>
                    Verifikat {activeSettlement.displayNumber}
                  </Link>{" "}
                  ({activeSettlement.fromDate} – {activeSettlement.toDate}). Ångra genom att omföra verifikatet.
                </span>
              </div>
            ) : (
              <FormActions>
                <Button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!hasMovement || settling || settlementBlocked}
                >
                  Bokför momsomföring
                </Button>
                {!hasMovement && <FormHint>Ingen moms att omföra i perioden.</FormHint>}
                {hasMovement && settlementBlocked && (
                  <FormHint>
                    Momsomföringen kan inte bokföras — se varningen om redovisningskonton ovanför deklarationen.
                  </FormHint>
                )}
              </FormActions>
            )}

            {reversedSettlements.length > 0 && (
              <FormHint>
                {reversedSettlements.map((settlement) => (
                  <span key={settlement.id}>
                    Tidigare momsomföring{" "}
                    <Link href={`/ekonomi/verifikat/${settlement.verificationId}`}>{settlement.displayNumber}</Link>{" "}
                    är omförd
                    {settlement.reversedBy && (
                      <>
                        {" "}
                        genom{" "}
                        <Link href={`/ekonomi/verifikat/${settlement.reversedBy.id}`}>
                          {settlement.reversedBy.displayNumber}
                        </Link>
                      </>
                    )}
                    .{" "}
                  </span>
                ))}
              </FormHint>
            )}
          </Card>

          <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Bokför momsomföring">
            <p>
              Momskontona nollställs för perioden {report.from} – {report.to}. Ruta 49 bokförs i hela kronor på
              redovisningskontot för moms och öresdifferensen på öres- och kronutjämning. Verifikatet bokförs i serie
              M med datum <strong>{report.to}</strong>.
            </p>
            <Table<PostingLine>
              columns={[
                { key: "account", label: "Konto", width: "1.6fr" },
                { key: "debit", label: "Debet", width: "110px", align: "right" },
                { key: "credit", label: "Kredit", width: "110px", align: "right" },
              ]}
              rows={lines}
              footer={{
                account: <strong>Summa</strong>,
                debit: <span className="num">{formatMoney(round2(lines.reduce((sum, line) => sum + line.debit, 0)))}</span>,
                credit: <span className="num">{formatMoney(round2(lines.reduce((sum, line) => sum + line.credit, 0)))}</span>,
              }}
              renderCell={(line, key) => {
                switch (key) {
                  case "account":
                    return line.account;
                  case "debit":
                    return <span className="num">{money(line.debit)}</span>;
                  case "credit":
                    return <span className="num">{money(line.credit)}</span>;
                  default:
                    return null;
                }
              }}
            />
            <p>
              <strong>
                {report.roundedBoxes["49"] >= 0 ? "Moms att betala: " : "Moms att få tillbaka: "}
                {formatMoney(Math.abs(report.roundedBoxes["49"]))}
              </strong>
            </p>
            {endPeriodLocked && (
              <FormError margin="below">
                Periodens sista månad är låst — omföringen nekas tills den låses upp under Räkenskapsår.
              </FormError>
            )}
            <FormError margin="below">{settleError}</FormError>
            <FormActions>
              <Button type="button" onClick={settle} disabled={settling}>
                {settling ? "Bokför…" : "Bokför momsomföring"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)}>
                Avbryt
              </Button>
            </FormActions>
          </Modal>
        </>
      )}

      <ImportVatDialog open={importOpen} onClose={() => setImportOpen(false)} vatCodes={vatCodes} />
    </>
  );
}

// "2650 · Momsredovisning" — the number alone when the account is not in the chart.
function accountLabel(account: VatSettlementAccount): string {
  return account.name ? `${account.number} · ${account.name}` : account.number;
}

// "Kredit 12 345,00" / "Debet 0,47" / "0,00" — how an account's side of the
// omföring reads.
function settlementAmountText(account: VatSettlementAccount): string {
  if (account.amount === 0) return formatMoney(0);
  return `${account.amount > 0 ? "Kredit" : "Debet"} ${formatMoney(Math.abs(account.amount))}`;
}

// Redovisningsperiod för moms: which period the page preselects (and which
// the periodisk sammanställning follows). Saved on its own, independent of the
// report above.
function ReportingPeriodSetting({ initial }: { initial: VatReportingPeriod }) {
  const [saved, setSaved] = useState<VatReportingPeriod>(initial);
  const [value, setValue] = useState<VatReportingPeriod>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save() {
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const result = await apiFetch<VatReportingSettings>("/api/v1/settings/vat-reporting", {
        method: "PATCH",
        body: JSON.stringify({ period: value }),
      });
      setSaved(result.period);
      setValue(result.period);
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara redovisningsperioden"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={styles.settingRow}>
        <div className={styles.settingField}>
          <Field label="Redovisningsperiod för moms" htmlFor="vatReportingPeriod">
            <Select
              id="vatReportingPeriod"
              size="md"
              value={value}
              onChange={(e) => {
                setDone(false);
                setValue(e.target.value as VatReportingPeriod);
              }}
            >
              {VAT_REPORTING_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {VAT_REPORTING_PERIOD_LABELS[period]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="button" variant="secondary" onClick={save} disabled={pending || value === saved}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        {done && <FormSaved>Sparat</FormSaved>}
      </div>
      <FormError margin="above">{error}</FormError>
      <FormHint>
        Den period Skatteverket har bestämt för företaget. Den förvalda perioden när sidan öppnas följer den: senast
        avslutade månad eller kvartal, eller för helår det senast avslutade räkenskapsåret.
      </FormHint>
    </>
  );
}

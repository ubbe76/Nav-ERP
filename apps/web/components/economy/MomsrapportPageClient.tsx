"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { GatedLink } from "../ui/GatedLink";
import { stockholmToday } from "../../lib/date";
import {
  MONTH_NAMES_SV,
  type AccountingPeriod,
  type FiscalYear,
  type FiscalYearDetail,
  type VatReportResponse,
} from "../../lib/types";

// One selectable redovisningsperiod — a month (one accounting period) or a
// complete calendar quarter (three). The value IS the range: "from|to".
type PeriodOption = { value: string; label: string };

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

// Month and quarter options from the fiscal year's period list. Quarters are
// CALENDAR quarters (Skatteverket's redovisningsperioder), offered only when
// the year contains all three months — a brutet år's clipped edge quarters
// are simply not offered.
function buildPeriodOptions(periods: AccountingPeriod[]): { months: PeriodOption[]; quarters: PeriodOption[] } {
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
  return { months, quarters };
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

// The declaration rows, in Skatteverkets order. `heading` rows group the
// table; `box` rows read their amount from the report.
type RutaRow =
  | { id: string; kind: "heading"; label: string }
  | { id: string; kind: "box"; ruta: string; label: string; boxKey: keyof VatReportResponse["boxes"]; highlight?: boolean };

const RUTA_ROWS: RutaRow[] = [
  { id: "h-sales", kind: "heading", label: "Försäljning" },
  { id: "05", kind: "box", ruta: "05", label: "Momspliktig försäljning", boxKey: "sales05" },
  { id: "35", kind: "box", ruta: "35", label: "Varor till annat EU-land", boxKey: "salesEu35" },
  { id: "36", kind: "box", ruta: "36", label: "Export av varor utanför EU", boxKey: "salesExport36" },
  { id: "42", kind: "box", ruta: "42", label: "Momsfri försäljning", boxKey: "salesExempt42" },
  { id: "h-out", kind: "heading", label: "Utgående moms" },
  { id: "10", kind: "box", ruta: "10", label: "Utgående moms 25 %", boxKey: "vatOut25_10" },
  { id: "11", kind: "box", ruta: "11", label: "Utgående moms 12 %", boxKey: "vatOut12_11" },
  { id: "12", kind: "box", ruta: "12", label: "Utgående moms 6 %", boxKey: "vatOut6_12" },
  { id: "h-in", kind: "heading", label: "Ingående moms" },
  { id: "48", kind: "box", ruta: "48", label: "Ingående moms att dra av", boxKey: "vatIn48" },
  { id: "h-sum", kind: "heading", label: "Summa" },
  { id: "49", kind: "box", ruta: "49", label: "Moms att betala eller få tillbaka", boxKey: "vatToPay49", highlight: true },
];

const VAT_ROLE_LABELS: Record<string, string> = {
  vatOut25: "Utgående moms 25 %",
  vatOut12: "Utgående moms 12 %",
  vatOut6: "Utgående moms 6 %",
  vatIn: "Ingående moms",
};

export function MomsrapportPageClient({
  fiscalYears,
  defaultFrom,
  defaultTo,
}: {
  fiscalYears: FiscalYear[];
  defaultFrom: string | undefined;
  defaultTo: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Initial year: the one covering ?from= when present, else the year
  // covering TODAY (declaring current-year periods is the normal case — the
  // list is newest-first, so [0] may be a future year), else the latest.
  const initialYearId = useMemo(() => {
    if (defaultFrom) {
      const covering = fiscalYears.find((year) => year.startDate <= defaultFrom && defaultFrom <= year.endDate);
      if (covering) return covering.id;
    }
    const today = stockholmToday();
    const current = fiscalYears.find((year) => year.startDate <= today && today <= year.endDate);
    return current?.id ?? fiscalYears[0]?.id ?? "";
  }, [fiscalYears, defaultFrom]);

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
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settledNumber, setSettledNumber] = useState<string | null>(null);

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
    () => (yearDetail ? buildPeriodOptions(yearDetail.periods) : { months: [], quarters: [] }),
    [yearDetail]
  );

  // Default period once the year's periods arrive and nothing is selected:
  // the most recently ENDED month (the one you are about to declare), else
  // the year's first month.
  useEffect(() => {
    if (!yearDetail || range !== "") return;
    const today = stockholmToday();
    const ended = yearDetail.periods.filter((period) => period.endDate < today);
    const fallback = ended[ended.length - 1] ?? yearDetail.periods[0];
    if (fallback) setRange(`${fallback.startDate}|${fallback.endDate}`);
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
  const hasMovement = report?.vatAccounts.some((row) => row.net !== 0) ?? false;
  const endPeriodLocked = report ? report.periods[report.periods.length - 1]?.status === "locked" : false;

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
            </Select>
          </Field>
        </FormRow>
        {activeSettlement && (
          <FormNotice>
            Perioden överlappar en deklarerad månad — omför momsomföringen först om du vill deklarera om.
          </FormNotice>
        )}
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar momsrapporten…</FormHint>}
      {fiscalYears.length === 0 && <p>Skapa ett räkenskapsår under Ekonomi → Räkenskapsår först.</p>}

      {report && !loading && (
        <>
          {(report.warnings.unassignedAccounts.length > 0 || report.warnings.roleBoxMismatches.length > 0) && (
            <FormNotice style={{ marginBottom: 20 }}>
              {report.warnings.unassignedAccounts.length > 0 && (
                <>
                  <strong>Konton utan momsruta</strong> — rörelserna räknas inte in i någon ruta. Ange momsruta i
                  kontoplanen:
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {report.warnings.unassignedAccounts.map((account) => (
                      <li key={account.accountNumber}>
                        <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: account.accountNumber } }}>
                          {account.accountNumber} · {account.accountName}
                        </GatedLink>{" "}
                        — {formatMoney(account.net)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {report.warnings.roleBoxMismatches.map((mismatch) => (
                <div key={mismatch.role} style={{ marginTop: 6 }}>
                  Standardkontot{" "}
                  <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: mismatch.accountNumber } }}>
                    {mismatch.accountNumber}
                  </GatedLink>{" "}
                  har momsruta{" "}
                  <strong>
                    {mismatch.actualBox === null
                      ? "Ej angiven"
                      : mismatch.actualBox === "none"
                        ? "Ingen ruta"
                        : mismatch.actualBox}
                  </strong>{" "}
                  i kontoplanen men används för ruta {mismatch.expectedBox} — rörelserna hamnar inte i ruta{" "}
                  {mismatch.expectedBox}
                  {mismatch.role.startsWith("revenue") ? "." : ", men momsomföringen tömmer kontot."}
                </div>
              ))}
            </FormNotice>
          )}
          <Card maxWidth="none" style={{ marginBottom: 20 }}>
            <Table<RutaRow>
              columns={[
                { key: "ruta", label: "Ruta", width: "70px" },
                { key: "label", label: "Beskrivning", width: "1.6fr" },
                { key: "amount", label: "Belopp", width: "160px", align: "right" },
              ]}
              rows={RUTA_ROWS}
              renderCell={(row, key) => {
                if (row.kind === "heading") {
                  return key === "label" ? <strong>{row.label}</strong> : "";
                }
                switch (key) {
                  case "ruta":
                    return row.ruta;
                  case "label":
                    return row.highlight && report.boxes[row.boxKey] < 0 ? "Moms att få tillbaka" : row.label;
                  case "amount":
                    return (
                      <span className="num" style={row.highlight ? { fontWeight: 600 } : undefined}>
                        {formatMoney(report.boxes[row.boxKey])}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            />
            <FormHint>
              Beloppen visas med ören för att stämma mot huvudboken — Skatteverkets deklaration avrundas till hela
              kronor.
            </FormHint>
          </Card>

          <Card maxWidth="none">
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Momsomföring</div>
            <Table<VatReportResponse["vatAccounts"][number] & { id: string }>
              columns={[
                { key: "account", label: "Konto", width: "1.4fr" },
                { key: "debit", label: "Debet", width: "130px", align: "right" },
                { key: "credit", label: "Kredit", width: "130px", align: "right" },
                { key: "net", label: "Netto", width: "130px", align: "right" },
              ]}
              rows={report.vatAccounts.map((row) => ({ ...row, id: row.role }))}
              renderCell={(row, key) => {
                switch (key) {
                  case "account":
                    return `${row.accountNumber} · ${row.accountName}`;
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
                <Button type="button" onClick={() => setConfirmOpen(true)} disabled={!hasMovement || settling}>
                  Bokför momsomföring
                </Button>
                {!hasMovement && <FormHint>Ingen moms att omföra i perioden.</FormHint>}
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
              Momskontona nollställs för perioden {report.from} – {report.to} och nettot bokförs på redovisningskontot
              för moms. Verifikatet bokförs i serie M med datum <strong>{report.to}</strong>.
            </p>
            <Table<VatReportResponse["vatAccounts"][number] & { id: string }>
              columns={[
                { key: "account", label: "Konto", width: "1.4fr" },
                { key: "movement", label: "Omföring", width: "160px", align: "right" },
              ]}
              rows={report.vatAccounts.filter((row) => row.net !== 0).map((row) => ({ ...row, id: row.role }))}
              renderCell={(row, key) => {
                switch (key) {
                  case "account":
                    return `${row.accountNumber} · ${row.accountName}`;
                  case "movement":
                    // The settlement books the OPPOSITE of the period net.
                    return <span className="num">{formatMoney(-row.net)}</span>;
                  default:
                    return null;
                }
              }}
            />
            <p>
              <strong>
                {report.boxes.vatToPay49 >= 0 ? "Moms att betala: " : "Moms att få tillbaka: "}
                {formatMoney(Math.abs(report.boxes.vatToPay49))}
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
    </>
  );
}

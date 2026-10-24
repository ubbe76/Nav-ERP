"use client";

import { useEffect, useState } from "react";
import { confirmDialog } from "../../../lib/confirm";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { GatedLink } from "../../ui/GatedLink";
import { Input } from "../../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../../ui/Form";
import { Table } from "../../ui/Table";
import { apiFetch } from "../../../lib/api";
import { exchangeDifferenceText, formatRate, revaluationDifference } from "../../../lib/currency";
import { apiErrorMessage } from "../../../lib/errorMessages";
import { formatMoney } from "../../../lib/format";
import type {
  YearEndClosingDetail,
  YearEndFxBookResult,
  YearEndFxCurrencySummary,
  YearEndFxInvoice,
  YearEndFxPreview,
  YearEndFxPreviewWithInvoices,
  YearEndFxRateSource,
  YearEndFxRateView,
} from "../../../lib/types";
import { PostingTable, StepHeader, VerificationLink } from "./StepCards";
import { useStepAction } from "./useStepAction";
import styles from "./Bokslut.module.css";

// A typed rate must be positive and survive the server's rounding to six
// decimals (the API refuses a rate that rounds to 0).
function parseRate(text: string): number | null {
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) && Math.round(value * 1e6) > 0 ? value : null;
}

function sameRate(a: number, b: number): boolean {
  return Math.round(a * 1e6) === Math.round(b * 1e6);
}

function storedRateText(rate: { source: YearEndFxRateSource | null; date: string | null }): string {
  switch (rate.source) {
    case "riksbank":
      return rate.date ? `Riksbanken ${rate.date}` : "Riksbanken";
    case "manual":
      return rate.date ? `egen kurs i Valutakurser ${rate.date}` : "egen kurs i Valutakurser";
    case "step":
      return "skriven i steget";
    default:
      return "";
  }
}

function fxBookedNotice(result: YearEndFxBookResult): string {
  if (result.unchanged) return "Valutaomvärdering: oförändrat — inget nytt verifikat";
  const created = result.nextFiscalYearCreated ? " Nästa räkenskapsår skapades automatiskt." : "";
  if (!result.verification) return `Valutaomvärdering klar — inget att bokföra.${created}`;
  const reversal = result.reversalVerification ? `, återföring ${result.reversalVerification.displayNumber}` : "";
  return `Valutaomvärdering bokförd — Verifikat ${result.verification.displayNumber}${reversal}.${created}`;
}

const SIDE_LABELS = { receivable: "Kundfordringar", payable: "Leverantörsskulder" } as const;
const INVOICE_LABELS = { receivable: "Kundfaktura", payable: "Leverantörsfaktura" } as const;
const INVOICE_HREF = { receivable: "/forsaljning/fakturor", payable: "/inkop/leverantorsfakturor" } as const;

type SummaryRow = YearEndFxCurrencySummary & { id: string; side: "receivable" | "payable"; accountNumber: string };

// Valutaomvärdering (no step number — the card sits between steg 4 and 5 and
// only has work to do when open invoices in another currency exist). Rates
// the user types are previewed through the API (the verification rows, the
// per-currency sums) and applied to the invoice list directly in the browser
// with the same revaluationDifference the server books with.
export function FxRevaluationCard({ closing }: { closing: YearEndClosingDetail }) {
  const step = closing.steps.fxRevaluation;
  const blocked = closing.checks.stepBlockers.length > 0;
  const base = `/api/v1/year-end-closings/${closing.id}`;
  const action = useStepAction();

  // Only the rates the user has touched: currency → the text in the field.
  const [typed, setTyped] = useState<Record<string, string>>({});
  // The last full preview (with the invoices) and the rates it was fetched for.
  const [live, setLive] = useState<YearEndFxPreviewWithInvoices | null>(null);
  const [liveKey, setLiveKey] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const defaults = new Map(step.preview.rates.map((rate) => [rate.currency, rate]));
  const currencies = step.preview.rates.map((rate) => rate.currency);
  const defaultRate = (currency: string): number | null => defaults.get(currency)?.rate ?? null;
  const effectiveRate = (currency: string): number | null => {
    const text = typed[currency];
    return text === undefined ? defaultRate(currency) : parseRate(text);
  };

  // The rates that differ from the step's default — what the API is asked to
  // use (an untouched currency keeps the booked rate / Valutakurser).
  const edited = currencies.flatMap((currency): [string, number][] => {
    const text = typed[currency];
    const value = text === undefined ? null : parseRate(text);
    const standard = defaultRate(currency);
    return value !== null && (standard === null || !sameRate(value, standard)) ? [[currency, value]] : [];
  });
  const editedKey = edited.map(([currency, value]) => `${currency}:${value.toFixed(6)}`).join(",");
  const invalid = currencies.filter((currency) => typed[currency] !== undefined && parseRate(typed[currency]!) === null);
  const missing = currencies.filter((currency) => typed[currency] === undefined && defaultRate(currency) === null);
  const hasInvalid = invalid.length > 0;

  const liveFresh = live !== null && liveKey === editedKey;
  const needsLive = listOpen || editedKey !== "";
  const recalculating = hasInvalid || (editedKey !== "" && !liveFresh);
  const display: YearEndFxPreview = liveFresh && live ? live : editedKey === "" ? step.preview : (live ?? step.preview);

  useEffect(() => {
    if (!needsLive || liveFresh || hasInvalid) return;
    let cancelled = false;
    // A typed rate waits for the user to pause; opening the list is immediate.
    const timer = setTimeout(
      async () => {
        try {
          const query = editedKey ? `?rates=${encodeURIComponent(editedKey)}` : "";
          const result = await apiFetch<YearEndFxPreviewWithInvoices>(`${base}/fx-revaluation-preview${query}`);
          if (cancelled) return;
          setLive(result);
          setLiveKey(editedKey);
          setPreviewError(null);
        } catch (err) {
          if (!cancelled) setPreviewError(apiErrorMessage(err, "Kunde inte räkna om valutaomvärderingen"));
        }
      },
      editedKey === "" ? 0 : 350
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsLive, liveFresh, hasInvalid, editedKey, base]);

  const summaryRows: SummaryRow[] = (["receivable", "payable"] as const).flatMap((side) =>
    display[side].currencies.map((row) => ({ ...row, id: `${side}-${row.currency}`, side, accountNumber: display[side].accountNumber }))
  );
  const invoiceTotal = display.receivable.invoiceCount + display.payable.invoiceCount;
  const invoiceRows: YearEndFxInvoice[] | null = live
    ? live.invoices.map((invoice) => {
        const rate = effectiveRate(invoice.currency);
        const calculated = rate === null ? null : revaluationDifference(invoice.openAmount, invoice.bookedSek, rate);
        return {
          ...invoice,
          rate,
          revaluedSek: calculated?.revaluedSek ?? null,
          difference: calculated?.difference ?? null,
        };
      })
    : null;
  // A positive difference is a kursvinst on a receivable and a kursförlust on
  // a payable — the result effect always counts + as vinst.
  const effectOf = (side: "receivable" | "payable", difference: number | null): number | null =>
    difference === null ? null : side === "receivable" ? difference : -difference;
  const effectText = (side: "receivable" | "payable", difference: number | null): string => {
    const effect = effectOf(side, difference);
    return effect === null ? "–" : exchangeDifferenceText(effect, formatMoney);
  };

  const status = blocked && step.status !== "done" ? "blocked" : step.status;
  const reversalText = closing.nextFiscalYear
    ? `Återförs automatiskt ${closing.nextFiscalYear.startDate}.`
    : `Räkenskapsåret efter ${closing.fiscalYear.label} skapas automatiskt när valutaomvärderingen bokförs.`;
  const hasRiksbankRate = step.preview.rates.some((rate) => rate.source === "riksbank" && typed[rate.currency] === undefined);

  async function book() {
    // A re-run omförs the live pair first — unless the server says it would
    // book the very same thing (then nothing is cancelled).
    if (step.verification && !(display.unchanged && !recalculating)) {
      const ok = await confirmDialog("Den bokförda valutaomvärderingen och dess återföring omförs och ersätts av nya verifikat. Fortsätt?", {
        confirmLabel: "Bokför igen",
      });
      if (!ok) return;
    }
    await action.run(async () => {
      const result = await apiFetch<YearEndFxBookResult>(`${base}/fx-revaluation`, {
        method: "POST",
        body: JSON.stringify(edited.length > 0 ? { rates: Object.fromEntries(edited) } : {}),
      });
      // The booked rates are the new defaults.
      setTyped({});
      setLive(null);
      setLiveKey("");
      return fxBookedNotice(result);
    });
  }

  function rateSourceCell(view: YearEndFxRateView): string {
    const text = typed[view.currency];
    if (text !== undefined) {
      const value = parseRate(text);
      if (value === null) return "Ange en kurs större än 0";
      const standard = defaultRate(view.currency);
      if (standard === null || !sameRate(value, standard)) return "Skriven i steget";
    }
    if (view.rate === null) return "Kurs saknas — skriv kursen";
    const origin = storedRateText(view);
    return view.fromBooking ? `Den bokade kursen${origin ? ` (${origin})` : ""}` : origin;
  }

  const notRequiredText = `Inga valutaposter — det finns inga öppna kund- eller leverantörsfakturor i annan valuta än SEK per ${display.asOf}.`;

  return (
    <Card maxWidth="none">
      <StepHeader title="Valutaomvärdering" status={status} />

      {!step.required ? (
        <>
          <p>{step.status === "not_done" ? `${notRequiredText} Steget spärrar inget.` : "Inga valutaposter."}</p>
          {step.status === "stale" && (
            <FormNotice>
              Det finns inga öppna valutaposter längre, men valutaomvärderingen är bokförd — bokför igen så omförs den och återföringen.
            </FormNotice>
          )}
          {step.verification && (
            <p>
              Bokfört <VerificationLink verification={step.verification} />, återföring{" "}
              <VerificationLink verification={step.reversalVerification} />.
            </p>
          )}
          <FormError>{action.error}</FormError>
          {action.notice && <FormHint>{action.notice}</FormHint>}
          {step.status !== "done" && (
            <FormActions className={styles.actions}>
              <Button type="button" disabled={action.pending || blocked} onClick={() => book()}>
                {step.status === "not_done" ? "Markera som klar" : "Bokför igen"}
              </Button>
            </FormActions>
          )}
        </>
      ) : (
        <>
          {step.status !== "not_done" && (
            <p>
              {step.verification ? (
                <>
                  Bokfört <VerificationLink verification={step.verification} />, återföring{" "}
                  <VerificationLink verification={step.reversalVerification} />.
                </>
              ) : (
                "Bokfört — ingen differens att bokföra."
              )}
              {step.bookedRates && step.bookedRates.length > 0 && (
                <>
                  {" "}
                  Bokförda kurser:{" "}
                  {step.bookedRates.map((rate) => `${rate.currency} ${formatRate(rate.rate)} (${storedRateText(rate)})`).join(", ")}.
                </>
              )}
            </p>
          )}
          {step.status === "stale" && (
            <FormNotice>De öppna valutaposterna har ändrats sedan valutaomvärderingen bokfördes — gör om steget.</FormNotice>
          )}
          <p>
            Öppna kund- och leverantörsfakturor i annan valuta värderas till kursen per {display.asOf} ({invoiceTotal}{" "}
            {invoiceTotal === 1 ? "faktura" : "fakturor"}).
          </p>

          <Table<{ id: string; view: YearEndFxRateView }>
            columns={[
              { key: "currency", label: "Valuta", width: "80px" },
              { key: "rate", label: "Kurs", width: "170px", align: "right" },
              { key: "source", label: "Källa", width: "1fr" },
            ]}
            rows={step.preview.rates.map((view) => ({ id: view.currency, view }))}
            renderCell={({ view }, key) => {
              switch (key) {
                case "currency":
                  return view.currency;
                case "rate":
                  return (
                    <Input
                      className={styles.control}
                      aria-label={`Kurs ${view.currency}`}
                      type="number"
                      min="0"
                      step="any"
                      value={typed[view.currency] ?? (view.rate === null ? "" : String(view.rate))}
                      onChange={(e) => setTyped((prev) => ({ ...prev, [view.currency]: e.target.value }))}
                    />
                  );
                case "source":
                  return (
                    <>
                      {rateSourceCell(view)}
                      {typed[view.currency] !== undefined && (
                        <>
                          {" "}
                          <Button
                            type="button"
                            variant="ghost"
                            size="small"
                            onClick={() =>
                              setTyped((prev) => {
                                const next = { ...prev };
                                delete next[view.currency];
                                return next;
                              })
                            }
                          >
                            Återställ
                          </Button>
                        </>
                      )}
                    </>
                  );
                default:
                  return null;
              }
            }}
          />
          <FormHint>
            Kronor per 1 enhet av valutan per {display.asOf}. Ändra en kurs så räknas summorna och konteringen om; en kurs du skriver här gäller
            bara bokslutet och sparas inte under Valutakurser.
            {hasRiksbankRate && " Källa: Sveriges Riksbank."}
          </FormHint>
          {missing.length > 0 && (
            <FormNotice>
              Kurs saknas för {missing.join(", ")} per {display.asOf} — skriv kursen i fältet Kurs. Valutaomvärderingen kan inte bokföras innan.
            </FormNotice>
          )}
          {hasInvalid && <FormNotice>Ange en kurs större än 0 för {invalid.join(", ")}.</FormNotice>}

          {missing.length === 0 && !hasInvalid && (
            <>
              <Table<SummaryRow>
                columns={[
                  { key: "account", label: "Konto", width: "1.4fr" },
                  { key: "currency", label: "Valuta", width: "70px" },
                  { key: "invoiceCount", label: "Fakturor", width: "80px", align: "right" },
                  { key: "openAmount", label: "Öppet belopp", width: "1fr", align: "right" },
                  { key: "bookedSek", label: "Bokfört (SEK)", width: "1fr", align: "right" },
                  { key: "revaluedSek", label: "Omvärderat (SEK)", width: "1fr", align: "right" },
                  { key: "difference", label: "Differens (SEK)", width: "1fr", align: "right" },
                  { key: "effect", label: "Resultateffekt", width: "1.2fr", align: "right" },
                ]}
                rows={summaryRows}
                renderCell={(row, key) => {
                  switch (key) {
                    case "account":
                      return `${SIDE_LABELS[row.side]} ${row.accountNumber}`;
                    case "currency":
                      return row.currency;
                    case "invoiceCount":
                      return row.invoiceCount;
                    case "openAmount":
                      return formatMoney(row.openAmount);
                    case "bookedSek":
                      return formatMoney(row.bookedSek);
                    case "revaluedSek":
                      return row.revaluedSek === null ? "–" : formatMoney(row.revaluedSek);
                    case "difference":
                      return row.difference === null ? "–" : formatMoney(row.difference);
                    case "effect":
                      return effectText(row.side, row.difference);
                    default:
                      return null;
                  }
                }}
              />
              {display.resultEffect !== null && (
                <p>
                  Effekt på årets resultat: <strong>{exchangeDifferenceText(display.resultEffect, formatMoney)}</strong>
                </p>
              )}
              <PostingTable rows={display.rows} empty="Ingen differens att bokföra." />
              <FormHint>
                Verifikatet bokförs i serien BS på bokslutsdatumet. {reversalText}
              </FormHint>
            </>
          )}
          {closing.nextFiscalYear?.firstPeriodStatus === "locked" && (
            <FormNotice>
              Första perioden i {closing.nextFiscalYear.label} är låst — återföringen {closing.nextFiscalYear.startDate} kan inte bokföras. Lås upp
              perioden under Räkenskapsår innan du bokför valutaomvärderingen.
            </FormNotice>
          )}

          <details className={styles.details} onToggle={(e) => setListOpen(e.currentTarget.open)}>
            <summary>Fakturor som omvärderas ({invoiceTotal})</summary>
            {invoiceRows === null ? (
              previewError ? null : <p>Hämtar fakturorna…</p>
            ) : (
              <Table<YearEndFxInvoice>
                columns={[
                  { key: "invoice", label: "Faktura", width: "1.2fr" },
                  { key: "type", label: "Typ", width: "1fr" },
                  { key: "partner", label: "Kund/leverantör", width: "1.6fr" },
                  { key: "currency", label: "Valuta", width: "70px" },
                  { key: "openAmount", label: "Öppet belopp", width: "1fr", align: "right" },
                  { key: "bookedSek", label: "Bokfört (SEK)", width: "1fr", align: "right" },
                  { key: "rate", label: "Kurs", width: "1fr", align: "right" },
                  { key: "revaluedSek", label: "Omvärderat (SEK)", width: "1fr", align: "right" },
                  { key: "difference", label: "Differens (SEK)", width: "1fr", align: "right" },
                ]}
                rows={invoiceRows}
                emptyText="Inga valutafakturor."
                renderCell={(row, key) => {
                  switch (key) {
                    case "invoice":
                      return <GatedLink href={`${INVOICE_HREF[row.side]}/${row.id}`}>{row.number}</GatedLink>;
                    case "type":
                      return INVOICE_LABELS[row.side];
                    case "partner":
                      return row.partnerName;
                    case "currency":
                      return row.currency;
                    case "openAmount":
                      return formatMoney(row.openAmount);
                    case "bookedSek":
                      return formatMoney(row.bookedSek);
                    case "rate":
                      return row.rate === null ? "–" : formatRate(row.rate);
                    case "revaluedSek":
                      return row.revaluedSek === null ? "–" : formatMoney(row.revaluedSek);
                    case "difference":
                      return row.difference === null ? "–" : formatMoney(row.difference);
                    default:
                      return null;
                  }
                }}
              />
            )}
          </details>

          {previewError && <FormError margin="above">{previewError}</FormError>}
          {recalculating && !hasInvalid && !previewError && <FormHint>Räknar om…</FormHint>}
          <FormError>{action.error}</FormError>
          {action.notice && <FormHint>{action.notice}</FormHint>}
          <FormActions className={styles.actions}>
            <Button
              type="button"
              disabled={action.pending || blocked || missing.length > 0 || hasInvalid || recalculating}
              onClick={() => book()}
            >
              {step.status === "not_done" ? "Bokför valutaomvärdering" : "Bokför igen"}
            </Button>
          </FormActions>
        </>
      )}
    </Card>
  );
}

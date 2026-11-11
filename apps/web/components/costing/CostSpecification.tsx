"use client";

import { confirmDialog } from "../../lib/confirm";
import { useEffect, useState } from "react";
import { Table } from "../ui/Table";
import { CostChain } from "../ui/CostChain";
import { chainLines } from "../../lib/costChain";
import { noPerUnitNotice, perUnitDivisor, type PerUnitDivisorSource } from "../../lib/calculationDivisor";
import { MARKUP_LEVEL_WORDS, type MarkupLevel } from "../../lib/markupLevels";
import { Button } from "../ui/Button";
import { FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { formatRate } from "../../lib/currency";
import { formatQuantity } from "../../lib/format";
import { OLD_CALCULATION_NOTICE, PRELIMINARY_NOTICE, hasRateDeviation, isZeroAmount } from "../../lib/costVariance";
import { Deviation, VarianceSummary } from "./VarianceSummary";
import { formatStockholmDateTime } from "../../lib/date";
import type {
  CostVarianceAnalysis,
  CostVarianceMaterialRow,
  CostVarianceOperationRow,
  CostCalculationDetail,
  CostCalculationMaterialRow,
  CostCalculationOperationRow,
  CostPriceSource,
  CostingMaterialSource,
} from "../../lib/types";
import styles from "./CostSpecification.module.css";
import { SectionHeading } from "../ui/SectionHeading";
import { apiErrorMessage } from "../../lib/errorMessages";

// Typed as a total Record rather than `as const`: a new member of the enum then
// fails to compile here instead of rendering "undefined" into the sentence.
const SOURCE_LABELS: Record<CostingMaterialSource, string> = {
  supplier: "Aktiv leverantörs pris",
  standard: "Standardpris",
  actual: "Verklig kostnad",
};

function money(value: string | number) {
  return `${formatMoney(value)} kr`;
}

// " (varugruppen)" after a price markup's percent; nothing on a calculation
// that carries no level.
function levelSuffix(level: MarkupLevel | undefined) {
  return level ? ` (${MARKUP_LEVEL_WORDS[level]})` : "";
}

function percent(value: string) {
  return `${Number(value).toLocaleString("sv-SE", { maximumFractionDigits: 2 })} %`;
}

// The setup cost's share of an operation, spread across the calculated
// quantity: ställtid × timkostnad ÷ antal. "—" when there's no setup time to
// spread (null: an efterkalkyl whose time carries no Ställ/Produktion type, or
// rows saved before the column existed) or nothing to spread it over. On an
// efterkalkyl the divisor is N, the delivered quantity from the analysis.
function setupPerUnit(row: CostCalculationOperationRow, quantity: string) {
  const qty = Number(quantity);
  if (row.setupHours === null || !qty) return "—";
  return money((Number(row.setupHours) * Number(row.hourlyRate)) / qty);
}

export function CostSpecification({ calculationId, onApplied }: { calculationId: string; onApplied?: () => void }) {
  const [detail, setDetail] = useState<CostCalculationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<"standard" | "sales" | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  // Kept apart from `error`: that one replaces the whole specification (the
  // calculation could not be fetched at all), and a failed write-back must not
  // make the figures the user was reading disappear.
  const [applyError, setApplyError] = useState<string | null>(null);

  // Modal unmounts its children when closed, so this runs once per opening.
  useEffect(() => {
    let cancelled = false;
    apiFetch<CostCalculationDetail>(`/api/v1/cost-calculations/${calculationId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "Kunde inte hämta kalkylen"));
      });
    return () => {
      cancelled = true;
    };
  }, [calculationId]);

  async function apply(target: "standard" | "sales") {
    const label = target === "standard" ? "standardpriset" : "försäljningspriset";
    // The standard cost also drives stock valuation and the value of a
    // manufacturing receipt, so overwriting it is not cosmetic — confirm.
    // A tried calculation's price carries the markups that were tried, not the
    // ones that apply — say so before it becomes the article's price.
    const trialNote =
      target === "sales" && (detail?.generalMarkupLevel === "trial" || detail?.materialMarkupLevel === "trial")
        ? " Kalkylen är prövad: priset bygger på de påslag som prövades, inte på dem som gäller för artikeln."
        : "";
    if (!(await confirmDialog(`Skriva över artikelns ${label} med kalkylens värde?${trialNote}`))) return;
    setApplyError(null);
    setApplied(null);
    setApplying(target);
    try {
      await apiFetch(
        `/api/v1/cost-calculations/${calculationId}/${target === "standard" ? "apply-standard-cost" : "apply-sales-price"}`,
        { method: "POST" }
      );
      setApplied(target === "standard" ? "Standardpriset är uppdaterat." : "Försäljningspriset är uppdaterat.");
      onApplied?.();
    } catch (err) {
      setApplyError(apiErrorMessage(err, `Kunde inte uppdatera ${label}`));
    } finally {
      setApplying(null);
    }
  }

  if (error) return <FormError>{error}</FormError>;
  if (!detail) return <p>Hämtar kalkylen…</p>;

  const divisor = perUnitDivisor(divisorSource(detail));
  const hasRows = detail.materialRows.length > 0 || detail.operationRows.length > 0;
  const figures = perUnitFigures(detail);
  // A halvfabrikat row carries the TO its own calculation lifted up (TO sits
  // outside TVK, so it cannot be inside the row's amount). Shown only when
  // some row has one: single-level calculations and every calculation saved
  // before the column existed have 0 on every row.
  const hasRowOverhead = detail.materialRows.some((row) => Number(row.overheadAmount) !== 0);
  // Same rule for the materialpåslag a halvfabrikat lifted up.
  const hasRowMaterialMarkup = detail.materialRows.some((row) => Number(row.materialMarkupAmount) !== 0);
  const hasForeignPrice = detail.materialRows.some((row) => row.supplierCurrency !== null);
  const hasPriceDate = detail.materialRows.some((row) => row.priceDate !== null);

  return (
    <div>
      <FormHint>
        Beräknad med materialkälla {SOURCE_LABELS[detail.materialSource]}, MO {percent(detail.moPercent)}, LO{" "}
        {percent(detail.loPercent)}, Affo {percent(detail.affoPercent)}, generellt påslag{" "}
        {percent(detail.generalMarkupPercent)}
        {levelSuffix(detail.generalMarkupLevel)}, materialpåslag {percent(detail.materialMarkupPercent)}
        {levelSuffix(detail.materialMarkupLevel)}.
        {(detail.generalMarkupLevel === "trial" || detail.materialMarkupLevel === "trial") &&
          " Prövad kalkyl (Pröva påslag): påslagen är inte de som gäller för artikeln, och självkostnaden är densamma som i en vanlig förkalkyl."}
        {detail.multiLevel &&
          " Flernivåkalkyl: tillverkade halvfabrikat kostades ur sina egna strukturer och rutter, och bär därför inget MO-påslag här; deras TO-påslag och materialpåslag ingår i kedjans TO-påslag och materialpåslag."}
        {hasPriceDate
          ? " Standard- och leverantörspriser, och kurser för priser i annan valuta, är de som gällde när komponenten senast togs ut på ordern."
          : hasForeignPrice && " Leverantörspriser i annan valuta är omräknade till kronor med dagens kurs när kalkylen gjordes."}
      </FormHint>

      {hasRows ? (
        <>
          {detail.materialRows.length > 0 && (
            <section className={styles.section}>
              <SectionHeading>Material och lego</SectionHeading>
              <Table<CostCalculationMaterialRow>
                columns={[
                  { key: "articleNumber", label: "Artikelnummer", width: "140px" },
                  { key: "articleName", label: "Benämning", width: "1fr" },
                  { key: "quantity", label: "Antal", width: "90px", align: "right" },
                  { key: "unitCode", label: "Enhet", width: "70px" },
                  { key: "unitCost", label: "À-pris", width: "110px", align: "right" },
                  { key: "priceSource", label: "Priskälla", width: "150px" },
                  { key: "amount", label: "Belopp", width: "120px", align: "right" },
                  ...(hasRowOverhead ? [{ key: "overheadAmount", label: "TO-belopp", width: "120px", align: "right" as const }] : []),
                  ...(hasRowMaterialMarkup
                    ? [{ key: "materialMarkupAmount", label: "Materialpåslag", width: "130px", align: "right" as const }]
                    : []),
                ]}
                rows={detail.materialRows}
                renderCell={(row, key) => {
                  switch (key) {
                    case "articleNumber":
                      return row.articleNumber;
                    case "articleName":
                      return (
                        <>
                          {row.articleName}
                          {row.kind === "subcontract" && <span className={styles.tag}>lego</span>}
                          {row.kind === "semi" && <span className={styles.tag}>halvfabrikat</span>}
                        </>
                      );
                    case "quantity":
                      return Number(row.quantity).toLocaleString("sv-SE");
                    case "unitCode":
                      return row.unitCode;
                    case "unitCost":
                    case "amount":
                      return money(row[key]);
                    case "overheadAmount":
                      return row.kind === "semi" ? money(row.overheadAmount) : "—";
                    case "materialMarkupAmount":
                      return row.kind === "semi" ? money(row.materialMarkupAmount) : "—";
                    case "priceSource":
                      return <PriceSourceCell row={row} configured={detail.materialSource} />;
                    default:
                      return null;
                  }
                }}
              />
            </section>
          )}

          {detail.operationRows.length > 0 && (
            <section className={styles.section}>
              <SectionHeading>Operationer</SectionHeading>
              <Table<CostCalculationOperationRow>
                columns={[
                  { key: "sequenceNo", label: "Op", width: "70px", align: "right" },
                  { key: "workCenterName", label: "Resurs", width: "1fr" },
                  { key: "hours", label: "Timmar", width: "100px", align: "right" },
                  { key: "setupHours", label: "Ställtid", width: "100px", align: "right" },
                  { key: "hourlyRate", label: "Timkostnad", width: "120px", align: "right" },
                  { key: "laborAmount", label: "Lön", width: "110px", align: "right" },
                  { key: "setupPerUnit", label: "varav ställ/st", width: "130px", align: "right" },
                  { key: "overheadPercent", label: "TO", width: "80px", align: "right" },
                  { key: "overheadAmount", label: "TO-belopp", width: "120px", align: "right" },
                ]}
                rows={detail.operationRows}
                renderCell={(row, key) => {
                  switch (key) {
                    case "sequenceNo":
                      return row.sequenceNo;
                    case "workCenterName":
                      return `${row.workCenterCode} · ${row.workCenterName}`;
                    case "hours":
                      // Four decimals, not two: 35 minutes is 0.5833 h, and at
                      // two the row visibly fails to multiply out. The amounts
                      // are exact — only the hours are a rounded display.
                      return Number(row.hours).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
                    case "setupHours":
                      // Null for an efterkalkyl without typed time and for rows saved before
                      // the column existed — same rounded-display convention
                      // as Timmar above.
                      return row.setupHours === null
                        ? "—"
                        : Number(row.setupHours).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
                    case "setupPerUnit":
                      return setupPerUnit(
                        row,
                        detail.type === "post" && detail.analysis ? String(detail.analysis.outputQuantity) : detail.quantity
                      );
                    case "overheadPercent":
                      return percent(row.overheadPercent);
                    case "hourlyRate":
                    case "laborAmount":
                    case "overheadAmount":
                      return money(row[key]);
                    default:
                      return null;
                  }
                }}
              />
            </section>
          )}
        </>
      ) : (
        <p className={styles.section}>Inga rader sparade för den här kalkylen.</p>
      )}

      <section className={styles.section}>
        <SectionHeading>Summering</SectionHeading>
        {/* Per st = the totals ÷ what they bought: the quantity on a förkalkyl,
            the received quantity on a final efterkalkyl. No column at all on
            a preliminary efterkalkyl or one with nothing received. */}
        <CostChain lines={chainLines(detail, divisor.divisor ?? undefined)} />
        {divisor.divisor !== null && divisor.basis === "output" && (
          <FormHint>
            Per st är delat med inlevererat antal ({formatQuantity(divisor.divisor)} st), inte med orderns antal (
            {formatQuantity(Number(detail.quantity))} st).
          </FormHint>
        )}
        {noPerUnitNotice(divisor) && <FormHint>{noPerUnitNotice(divisor)}</FormHint>}

        {/* Prisåterföring. The amounts in the hints are computed here only to
            show what the button will do — the server re-derives them from the
            saved calculation, so nothing numeric is ever posted. */}
        {figures && (
          <>
            <FormActions>
              <Button type="button" disabled={applying !== null} onClick={() => apply("standard")}>
                {applying === "standard" ? "Sparar…" : "Sätt standardpris"}
              </Button>
              <Button type="button" disabled={applying !== null} onClick={() => apply("sales")}>
                {applying === "sales" ? "Sparar…" : "Sätt försäljningspris"}
              </Button>
            </FormActions>
            <FormHint>
              <strong>Sätt standardpris</strong> skriver kalkylens tillverkningskostnad{" "}
              {money(figures.manufacturing)}/st (utan TO-påslag) till artikelns{" "}
              <strong>Standardkostnad</strong> och loggar ändringen i standardprishistoriken. Fältet styr även
              lagervärdet och värdet på tillverkningsinleveranser. <strong>Sätt försäljningspris</strong> skriver{" "}
              {money(figures.sales)}/st till artikelns <strong>Försäljningspris</strong> — grundpriset
              längst ned i priskedjan.
            </FormHint>
            <FormError>{applyError}</FormError>
            {applied && <FormSaved>{applied}</FormSaved>}
          </>
        )}
      </section>

      {detail.type === "post" && <VarianceSection analysis={detail.analysis} />}
    </div>
  );
}

// --- Avvikelseanalys (#14). Tables of their own: the specification's tables
// above keep their columns, this section never widens them. ---

function qty(value: number | null): string {
  return value === null ? "—" : formatQuantity(value);
}

function hoursText(value: number | null): string {
  return value === null ? "—" : formatQuantity(value);
}

function VarianceSection({ analysis }: { analysis: CostVarianceAnalysis | null }) {
  if (!analysis) {
    return (
      <section className={styles.section}>
        <SectionHeading>Avvikelseanalys</SectionHeading>
        <FormHint>{OLD_CALCULATION_NOTICE}</FormHint>
      </section>
    );
  }
  const timeRows = analysis.operationRows.filter((r): r is Extract<CostVarianceOperationRow, { kind: "time" }> => r.kind === "time");
  const subcontractRows = analysis.operationRows.filter(
    (r): r is Extract<CostVarianceOperationRow, { kind: "subcontract" }> => r.kind === "subcontract"
  );
  // Ställ/Stycke have an amount only on an operation whose time is split; in
  // etapp 1 all reported time is Ej uppdelad, so the columns would be empty.
  const hasSplitTime = timeRows.some((r) => r.split && (r.hours > 0 || !isZeroAmount(r.parts.setup) || !isZeroAmount(r.parts.run)));
  // Timpris only when some operation's hourly rate differed from T₀'s.
  const hasRate = hasRateDeviation(timeRows);
  const hasScrap = analysis.materialRows.some((r) => r.scrapQuantity !== 0 || r.parts.scrap !== 0);
  return (
    <section className={styles.section}>
      <SectionHeading>Avvikelseanalys</SectionHeading>
      <FormHint>
        Kalkylerat är orderns egna rader för {formatQuantity(analysis.outputQuantity)} inlevererade, prissatta med
        förkalkylens materialkälla ({SOURCE_LABELS[analysis.baseMaterialSource]}) per T₀,{" "}
        {formatStockholmDateTime(analysis.basePricedAt)} (när ordern skapades). Positiv avvikelse är dyrare än kalkylerat.
      </FormHint>
      {analysis.preliminary && <FormHint>{PRELIMINARY_NOTICE}</FormHint>}

      {analysis.materialRows.length > 0 && (
        <>
          <h4 className={styles.subheading}>Material och lego</h4>
          <Table<CostVarianceMaterialRow & { id: string }>
            columns={[
              { key: "article", label: "Artikel", width: "minmax(160px, 1fr)" },
              // The deviations come first: the modal is narrow, and the wide
              // table scrolls sideways inside itself.
              { key: "price", label: "Pris", width: "110px", align: "right" },
              { key: "quantityPart", label: "Mängd", width: "110px", align: "right" },
              ...(hasScrap ? [{ key: "scrap", label: "varav kassation", width: "120px", align: "right" as const }] : []),
              { key: "baseQuantity", label: "Kalkylerat antal", width: "110px", align: "right" },
              { key: "baseUnitCost", label: "Kalkylerat à-pris", width: "120px", align: "right" },
              { key: "quantity", label: "Antal", width: "90px", align: "right" },
              { key: "unitCost", label: "À-pris", width: "100px", align: "right" },
            ]}
            rows={analysis.materialRows.map((r) => ({ ...r, id: r.id ?? r.componentArticleId }))}
            renderCell={(row, key) => {
              switch (key) {
                case "article":
                  return (
                    <>
                      {row.articleNumber} · {row.articleName}
                      {row.kind === "subcontract" && <span className={styles.tag}>lego</span>}
                      {row.kind === "semi" && <span className={styles.tag}>halvfabrikat</span>}
                    </>
                  );
                case "baseQuantity":
                  return qty(row.baseQuantity);
                case "baseUnitCost":
                  return row.baseUnitCost === null ? "—" : money(row.baseUnitCost);
                case "quantity":
                  return qty(row.quantity);
                case "unitCost":
                  return money(row.unitCost);
                case "price":
                  return <Deviation value={row.parts.price} />;
                case "quantityPart":
                  return <Deviation value={row.parts.quantity} />;
                case "scrap":
                  return <Deviation value={row.parts.scrap} />;
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {timeRows.length > 0 && (
        <>
          <h4 className={styles.subheading}>Operationer</h4>
          <Table<CostVarianceOperationRow & { id: string }>
            columns={[
              { key: "operation", label: "Operation", width: "minmax(160px, 1fr)" },
              ...(hasRate ? [{ key: "ratePart", label: "Timpris", width: "100px", align: "right" as const }] : []),
              ...(hasSplitTime
                ? [
                    { key: "setupPart", label: "Ställ", width: "100px", align: "right" as const },
                    { key: "runPart", label: "Stycke", width: "100px", align: "right" as const },
                  ]
                : []),
              { key: "unclassifiedPart", label: "Ej uppdelad", width: "110px", align: "right" },
              { key: "baseSetup", label: "Planerad ställ (h)", width: "110px", align: "right" },
              { key: "setup", label: "Verklig ställ (h)", width: "110px", align: "right" },
              { key: "baseRun", label: "Planerad stycke (h)", width: "120px", align: "right" },
              { key: "run", label: "Verklig stycke (h)", width: "110px", align: "right" },
              { key: "unclassified", label: "Ej uppdelad (h)", width: "110px", align: "right" },
            ]}
            rows={timeRows.map((r) => ({ ...r, id: r.id ?? `op-${r.sequenceNo}-${r.workCenterId}` }))}
            renderCell={(row, key) => {
              if (row.kind !== "time") return null;
              switch (key) {
                case "operation":
                  return `${row.sequenceNo} · ${row.workCenterCode} · ${row.workCenterName}`;
                case "baseSetup":
                  return hoursText(row.baseSetupHours);
                // Verklig ställ/stycke only on a split operation, as the kronor
                // cells: on a partly typed one all of H is Ej uppdelad (h), and
                // the typed part shown beside it would count those hours twice.
                case "setup":
                  return row.split ? hoursText(row.setupHours) : "—";
                case "baseRun":
                  return hoursText(row.baseRunHours);
                case "run":
                  return row.split ? hoursText(row.runHours) : "—";
                case "unclassified":
                  return hoursText(row.unclassifiedHours);
                case "ratePart":
                  return <Deviation value={row.parts.rate} />;
                case "setupPart":
                  return row.split ? <Deviation value={row.parts.setup} /> : "—";
                case "runPart":
                  return row.split ? <Deviation value={row.parts.run} /> : "—";
                case "unclassifiedPart":
                  return row.split ? "—" : <Deviation value={row.parts.unclassified} />;
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      {subcontractRows.length > 0 && (
        <>
          <h4 className={styles.subheading}>Legooperationer</h4>
          <Table<CostVarianceOperationRow & { id: string }>
            columns={[
              { key: "operation", label: "Operation", width: "minmax(160px, 1fr)" },
              { key: "base", label: "Kalkylerat", width: "120px", align: "right" },
              { key: "actual", label: "Utfall", width: "120px", align: "right" },
              { key: "price", label: "Pris", width: "110px", align: "right" },
              { key: "quantity", label: "Mängd", width: "110px", align: "right" },
            ]}
            rows={subcontractRows.map((r) => ({ ...r, id: r.id ?? `op-${r.sequenceNo}-${r.workCenterId}` }))}
            renderCell={(row, key) => {
              switch (key) {
                case "operation":
                  return `${row.sequenceNo} · ${row.workCenterCode} · ${row.workCenterName}`;
                case "base":
                  return money(row.base);
                case "actual":
                  return money(row.actual);
                case "price":
                  return <Deviation value={row.parts.price} />;
                case "quantity":
                  return <Deviation value={row.parts.quantity} />;
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      <h4 className={styles.subheading}>Summering</h4>
      <VarianceSummary analysis={analysis} bare />
      <FormHint>
        Utfall är tillverkningskostnaden i kedjan ovan. Varje rad avrundas för sig, och öresresten står under Påslag.
      </FormHint>
    </section>
  );
}

// The header's N and preliminary flag as the divisor rule reads them. They
// come from the analysis: it is non-null exactly when the header carries its
// four analysis fields (costVarianceAnalysis), and null on a förkalkyl and on
// an efterkalkyl saved before the analysis existed.
function divisorSource(detail: CostCalculationDetail): PerUnitDivisorSource {
  return {
    type: detail.type,
    quantity: detail.quantity,
    outputQuantity: detail.analysis?.outputQuantity ?? null,
    preliminary: detail.analysis?.preliminary ?? null,
  };
}

// Per-unit figures for the two buttons' hints, derived with chainLines — the
// web's single per-styck authority — over perUnitDivisor, the same divisor
// the server writes with. Null when the calculation cannot carry a per-unit
// figure (unusable quantity, preliminary efterkalkyl, nothing received),
// which is also when the server would refuse.
function perUnitFigures(detail: CostCalculationDetail) {
  const { divisor } = perUnitDivisor(divisorSource(detail));
  if (divisor === null) return null;
  const lines = chainLines(detail);
  const manufacturing = lines.find((l) => l.label === "Tillverkningskostnad (TVK)")?.amount ?? 0;
  return { manufacturing: manufacturing / divisor, sales: Number(detail.salesPrice) / divisor };
}

// Same total-Record rationale as SOURCE_LABELS above. "none" is handled
// separately because it renders as muted fallback text, not a plain label.
const PRICE_SOURCE_LABELS: Record<CostPriceSource, string> = {
  supplier: "Leverantörspris",
  standard: "Standardpris",
  none: "Inget pris",
  calculated: "Beräknat (flernivå)",
  moving_average: "Glidande medelpris",
};

// The configured source says what was asked for, the row what was available.
function PriceSourceCell({
  row,
  configured,
}: {
  row: CostCalculationMaterialRow;
  configured: CostCalculationDetail["materialSource"];
}) {
  if (row.priceSource === "none") return <span className={styles.fallback}>inget pris</span>;
  // What the kronor à-pris came from: a supplier price in another currency
  // and its rate, and in an efterkalkyl the day the price was taken.
  const details: string[] = [];
  if (row.supplierCurrency !== null && row.supplierUnitPrice !== null && row.exchangeRate !== null) {
    const price = Number(row.supplierUnitPrice).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    details.push(`${price} ${row.supplierCurrency}`, `kurs ${formatRate(row.exchangeRate)}`);
  }
  if (row.priceDate !== null) details.push(`uttag ${row.priceDate}`);
  // Any source other than "standard" that ended up on the standard cost fell
  // back — written as "not standard" rather than "is supplier" so a new source
  // (actual) reports its fallbacks without another edit here.
  const label =
    configured !== "standard" && row.priceSource === "standard" ? (
      <span className={styles.fallback}>standardpris (fallback)</span>
    ) : (
      PRICE_SOURCE_LABELS[row.priceSource]
    );
  return (
    <>
      {label}
      {details.length > 0 && <span className={styles.foreign}>{details.join(" · ")}</span>}
    </>
  );
}

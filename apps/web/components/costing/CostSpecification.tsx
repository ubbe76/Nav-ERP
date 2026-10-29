"use client";

import { confirmDialog } from "../../lib/confirm";
import { useEffect, useState } from "react";
import { Table } from "../ui/Table";
import { CostChain } from "../ui/CostChain";
import { chainLines } from "../../lib/costChain";
import { Button } from "../ui/Button";
import { FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { formatRate } from "../../lib/currency";
import type {
  CostCalculationDetail,
  CostCalculationMaterialRow,
  CostCalculationOperationRow,
  CostPriceSource,
  CostingMaterialSource,
} from "../../lib/types";
import styles from "./CostSpecification.module.css";
import { SectionHeading } from "../ui/SectionHeading";

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

function percent(value: string) {
  return `${Number(value).toLocaleString("sv-SE", { maximumFractionDigits: 2 })} %`;
}

// The setup cost's share of an operation, spread across the calculated
// quantity: ställtid × timkostnad ÷ antal. "—" when there's no setup time to
// spread (null, e.g. an efterkalkyl) or nothing to spread it over.
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
        if (!cancelled) setError(err instanceof Error ? err.message : "Kunde inte hämta kalkylen");
      });
    return () => {
      cancelled = true;
    };
  }, [calculationId]);

  async function apply(target: "standard" | "sales") {
    const label = target === "standard" ? "standardpriset" : "försäljningspriset";
    // The standard cost also drives stock valuation and the value of a
    // manufacturing receipt, so overwriting it is not cosmetic — confirm.
    if (!(await confirmDialog(`Skriva över artikelns ${label} med kalkylens värde?`))) return;
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
      setApplyError(err instanceof Error ? err.message : `Kunde inte uppdatera ${label}`);
    } finally {
      setApplying(null);
    }
  }

  if (error) return <FormError>{error}</FormError>;
  if (!detail) return <p>Hämtar kalkylen…</p>;

  const hasRows = detail.materialRows.length > 0 || detail.operationRows.length > 0;
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
        {percent(detail.generalMarkupPercent)}, materialpåslag {percent(detail.materialMarkupPercent)}.
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
                      // Null for post-calculations and for rows saved before
                      // the column existed — same rounded-display convention
                      // as Timmar above.
                      return row.setupHours === null
                        ? "—"
                        : Number(row.setupHours).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
                    case "setupPerUnit":
                      return setupPerUnit(row, detail.quantity);
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
        <CostChain lines={chainLines(detail, Number(detail.quantity))} />

        {/* Prisåterföring. The amounts in the hints are computed here only to
            show what the button will do — the server re-derives them from the
            saved calculation, so nothing numeric is ever posted. */}
        {perUnitFigures(detail) && (
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
              {money(perUnitFigures(detail)!.manufacturing)}/st (utan TO-påslag) till artikelns{" "}
              <strong>Standardkostnad</strong> och loggar ändringen i standardprishistoriken. Fältet styr även
              lagervärdet och värdet på tillverkningsinleveranser. <strong>Sätt försäljningspris</strong> skriver{" "}
              {money(perUnitFigures(detail)!.sales)}/st till artikelns <strong>Försäljningspris</strong> — grundpriset
              längst ned i priskedjan.
            </FormHint>
            <FormError>{applyError}</FormError>
            {applied && <FormSaved>{applied}</FormSaved>}
          </>
        )}
      </section>
    </div>
  );
}

// Per-unit figures for the two buttons' hints, derived with chainLines — the
// web's single per-styck authority. Null when the quantity cannot carry one,
// which is also when the server would refuse.
function perUnitFigures(detail: CostCalculationDetail) {
  const quantity = Number(detail.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const lines = chainLines(detail);
  const manufacturing = lines.find((l) => l.label === "Tillverkningskostnad (TVK)")?.amount ?? 0;
  return { manufacturing: manufacturing / quantity, sales: Number(detail.salesPrice) / quantity };
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

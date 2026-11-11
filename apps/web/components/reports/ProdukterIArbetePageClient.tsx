"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormNotice, FormRow, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { stockholmToday } from "../../lib/date";
import { formatMoney, formatQuantity } from "../../lib/format";
import { WIP_BASIS_LABELS, type WipBasis, type WorkInProgressReport, type WorkInProgressRow } from "../../lib/types";
import buttonStyles from "../ui/Button.module.css";
import styles from "./ProdukterIArbete.module.css";

const BASES = Object.keys(WIP_BASIS_LABELS) as WipBasis[];

function isBasis(value: string | undefined): value is WipBasis {
  return value !== undefined && (BASES as string[]).includes(value);
}

type WipDisplayRow = WorkInProgressRow & { id: string };

export function ProdukterIArbetePageClient({ defaultAsOf, defaultBasis, defaultDetail }: { defaultAsOf?: string; defaultBasis?: string; defaultDetail?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();

  // The fields edit a draft; Visa applies it (URL and report), so a half-typed
  // date never fires a request.
  const [asOf, setAsOf] = useState(() => defaultAsOf ?? stockholmToday());
  const [basis, setBasis] = useState<WipBasis>(isBasis(defaultBasis) ? defaultBasis : "manufacturing_cost");
  const [applied, setApplied] = useState({ asOf, basis });
  const [report, setReport] = useState<WorkInProgressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Visa kostnadsslag: the Material/Lön/Lego/Påslag columns. Display only, so
  // it applies at once (URL included) without a new request.
  const [detail, setDetail] = useState(defaultDetail ?? false);

  function queryString(values: { asOf: string; basis: WipBasis }, withDetail = detail): string {
    const params = new URLSearchParams({ asOf: values.asOf, basis: values.basis });
    if (withDetail) params.set("kostnadsslag", "1");
    return params.toString();
  }

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    apiFetch<WorkInProgressReport>(`/api/v1/costing/work-in-progress?${queryString(applied)}`)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReport(null);
        setError(apiErrorMessage(err, "Kunde inte läsa produkter i arbete."));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  function toggleDetail(next: boolean) {
    setDetail(next);
    router.replace(`${pathname}?${queryString(applied, next)}`, { scroll: false });
  }

  function show() {
    if (!asOf) return;
    const next = { asOf, basis };
    setApplied(next);
    router.replace(`${pathname}?${queryString(next, detail)}`, { scroll: false });
  }

  const showOverhead = detail && report?.basis === "manufacturing_cost";
  const rows: WipDisplayRow[] = report ? report.rows.map((row) => ({ ...row, id: row.manufacturingOrderId })) : [];
  const money = (value: number | null) => <span className="num">{value === null ? "—" : formatMoney(value)}</span>;
  // The shared Table drops the footer's column headings when stacked, so the
  // totals carry their own label, shown only at phone width.
  const sum = (label: string, node: React.ReactNode) => (
    <>
      <span className={styles.sumLabel}>{label}</span>
      {node}
    </>
  );

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormStack>
          <FormRow columns={2}>
            <Field label="Datum" htmlFor="wipAsOf">
              <Input id="wipAsOf" type="date" size="sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
            <Field label="Underlag" htmlFor="wipBasis">
              <Select id="wipBasis" value={basis} onChange={(e) => setBasis(e.target.value as WipBasis)}>
                {BASES.map((b) => (
                  <option key={b} value={b}>
                    {WIP_BASIS_LABELS[b]}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Checkbox checked={detail} onChange={(e) => toggleDetail(e.target.checked)} />
            Visa kostnadsslag
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" onClick={show} disabled={!asOf || pending}>
              Visa
            </Button>
            <a
              href={`${API_URL}/api/v1/costing/work-in-progress/pdf?${new URLSearchParams({ asOf: applied.asOf, basis: applied.basis }).toString()}`}
              download
              className={`${buttonStyles.button} ${buttonStyles.ghost}`}
            >
              Skriv ut
            </a>
          </div>
        </FormStack>
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && report.unvaluedCount > 0 && (
        <FormNotice>
          {report.unvaluedCount} {report.unvaluedCount === 1 ? "order har" : "ordrar har"} inlevererat utan pris och räknas inte.
        </FormNotice>
      )}
      {report && report.cappedCount > 0 && (
        <FormNotice>
          {report.cappedCount} {report.cappedCount === 1 ? "order:" : "ordrar:"} Avräknat överstiger upparbetat — PIA räknas som 0
          (markerade med ▼ i tabellen).
        </FormNotice>
      )}
      {report?.warnings.map((warning) => (
        <FormHint key={warning}>{warning}</FormHint>
      ))}

      {report && !pending && (
        <Card maxWidth="none">
          <Table<WipDisplayRow>
            columns={[
              { key: "order", label: "TO", width: "100px" },
              { key: "article", label: "Artikel", width: "minmax(160px, 1fr)" },
              { key: "received", label: "Inlevererat", width: "110px", align: "right" },
              ...(detail
                ? [
                    { key: "material", label: "Material", width: "100px", align: "right" as const },
                    { key: "labor", label: "Lön", width: "90px", align: "right" as const },
                    { key: "subcontract", label: "Lego", width: "90px", align: "right" as const },
                  ]
                : []),
              ...(showOverhead ? [{ key: "overhead", label: "Påslag", width: "90px", align: "right" as const }] : []),
              { key: "accumulated", label: "Upparbetat", width: "120px", align: "right" },
              { key: "relieved", label: "Avräknat", width: "120px", align: "right" },
              { key: "value", label: "PIA", width: "120px", align: "right" },
            ]}
            rows={rows}
            emptyText="Inga produkter i arbete per det datumet."
            footer={{
              order: <strong>Summa</strong>,
              material: sum("Material", money(report.totals.material)),
              labor: sum("Lön", money(report.totals.labor)),
              subcontract: sum("Lego", money(report.totals.subcontract)),
              overhead: sum("Påslag", money(report.totals.overhead)),
              accumulated: sum("Upparbetat", money(report.totals.accumulated)),
              relieved: sum("Avräknat", money(report.totals.relieved)),
              value: sum("PIA", <strong className="num">{formatMoney(report.totalValue)}</strong>),
            }}
            renderCell={(row, key) => {
              switch (key) {
                case "order":
                  return <GatedLink href={`/tillverkning/ordrar/${row.manufacturingOrderId}`}>{row.orderNumber}</GatedLink>;
                case "article":
                  return <span className={styles.wrap}>{`${row.articleNumber} — ${row.articleName}`}</span>;
                case "received":
                  return (
                    <span className="num">
                      {formatQuantity(row.receivedQuantity)} av {formatQuantity(row.quantity)}
                    </span>
                  );
                case "material":
                  return money(row.material);
                case "labor":
                  return money(row.labor);
                case "subcontract":
                  return money(row.subcontract);
                case "overhead":
                  return money(row.overhead);
                case "accumulated":
                  return money(row.accumulated);
                case "relieved":
                  return money(row.relieved);
                case "value":
                  return (
                    <span className="num" title={row.capped ? "Avräknat överstiger upparbetat — PIA räknas som 0" : undefined}>
                      {row.capped && <span aria-label="Avräknat överstiger upparbetat">▼ </span>}
                      {row.value === null ? "ovärderad" : formatMoney(row.value)}
                    </span>
                  );
                default:
                  return null;
              }
            }}
          />
        </Card>
      )}
    </>
  );
}

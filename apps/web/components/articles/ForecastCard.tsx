"use client";

import { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { SectionHeading } from "../ui/SectionHeading";
import { Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormSaved } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatQuantity } from "../../lib/format";
import type { ArticleForecast, ArticleForecastMonth } from "../../lib/types";

interface MonthRow extends ArticleForecastMonth {
  id: string;
}

function baseline(months: ArticleForecastMonth[]): Record<string, string> {
  return Object.fromEntries(
    months.map((m) => [m.month, m.own === null ? "" : String(m.own)]),
  );
}

// Prognos card on the Lager tab (#10): the monthly forecast per article. The
// own quantity (Eget antal) overrides the average; an empty field = the
// average. Only the changed months are sent.
export function ForecastCard({
  articleId,
  unitCode,
}: {
  articleId: string;
  unitCode?: string | null;
}) {
  const canEdit = useCan()(["artiklar", "tillverkning"]);
  const [data, setData] = useState<ArticleForecast | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(next: ArticleForecast) {
    setData(next);
    setInputs(baseline(next.months));
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<ArticleForecast>(`/api/v1/articles/${articleId}/forecast`)
      .then((res) => {
        if (!cancelled) apply(res);
      })
      .catch((err) => {
        if (!cancelled)
          setError(apiErrorMessage(err, "Kunde inte hämta prognosen"));
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  if (!data) {
    return (
      <Card maxWidth={900} style={{ marginBottom: 20 }}>
        <SectionHeading>Prognos</SectionHeading>
        <FormError>{error}</FormError>
        {!error && <p>Hämtar…</p>}
      </Card>
    );
  }

  const original = baseline(data.months);
  const changed = data.months.filter(
    (m) => (inputs[m.month] ?? "") !== original[m.month],
  );
  const showConsumed = data.months.some((m) => m.alreadyConsumed !== null);
  const rows: MonthRow[] = data.months.map((m) => ({ ...m, id: m.month }));
  const unit = unitCode ? ` ${unitCode}` : "";

  async function save() {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const fresh = await apiFetch<ArticleForecast>(
        `/api/v1/articles/${articleId}/forecast`,
        {
          method: "PUT",
          body: JSON.stringify({
            months: changed.map((m) => {
              const raw = (inputs[m.month] ?? "").trim();
              return {
                month: m.month,
                quantity: raw === "" ? null : Number(raw),
              };
            }),
          }),
        },
      );
      apply(fresh);
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara prognosen"));
    } finally {
      setPending(false);
    }
  }

  const columns = [
    { key: "month", label: "Månad", width: "80px" },
    { key: "average", label: "Snitt", width: "80px", align: "right" as const },
    {
      key: "own",
      label: "Eget antal",
      width: "120px",
      align: "right" as const,
    },
    {
      key: "forecast",
      label: "Prognos",
      width: "80px",
      align: "right" as const,
    },
    {
      key: "actualDemand",
      label: "Order och behov",
      width: "110px",
      align: "right" as const,
    },
    ...(showConsumed
      ? [
          {
            key: "alreadyConsumed",
            label: "Redan förbrukat",
            width: "110px",
            align: "right" as const,
          },
        ]
      : []),
    {
      key: "forecastDemand",
      label: "Prognosbehov",
      width: "100px",
      align: "right" as const,
    },
  ];

  return (
    <Card maxWidth={900} style={{ marginBottom: 20 }}>
      <SectionHeading>Prognos</SectionHeading>
      <FormError>{error}</FormError>
      <Table<MonthRow>
        columns={columns}
        rows={rows}
        emptyText="Ingen horisont"
        renderCell={(row, key) => {
          switch (key) {
            case "month":
              return row.month;
            case "average":
              return formatQuantity(row.average);
            case "own":
              return canEdit ? (
                <Input
                  type="number"
                  size="sm"
                  min="0"
                  step="any"
                  aria-label={`Eget antal ${row.month}`}
                  placeholder={formatQuantity(row.average)}
                  value={inputs[row.month] ?? ""}
                  onChange={(e) => {
                    setSaved(false);
                    setInputs((prev) => ({
                      ...prev,
                      [row.month]: e.target.value,
                    }));
                  }}
                />
              ) : row.own === null ? (
                "—"
              ) : (
                formatQuantity(row.own)
              );
            case "forecast":
              return formatQuantity(row.forecast);
            case "actualDemand":
              return formatQuantity(row.actualDemand);
            case "alreadyConsumed":
              return row.alreadyConsumed === null
                ? "—"
                : formatQuantity(row.alreadyConsumed);
            case "forecastDemand":
              return <strong>{formatQuantity(row.forecastDemand)}</strong>;
            default:
              return null;
          }
        }}
      />
      <FormHint attached>
        Snitt: förbrukningen (kundorderutleveranser och materialuttag) de
        senaste {data.historyMonths} hela månaderna delat med antalet månader —{" "}
        {formatQuantity(data.average)}
        {unit} per månad. Eget antal ersätter snittet för månaden; tomt fält =
        snittet. Prognosbehov är prognosen minus månadens order och behov (och i
        innevarande månad det som redan förbrukats). Behovsberäkningen räknar
        dessutom av härlett behov från förslag på överordnade artiklar, så den
        kan visa ett mindre prognosbehov än kortet. Prognosen är inget skarpt
        behov och flyttar aldrig färdigdatum eller leveranstidskontroll.
      </FormHint>
      <FormActions>
        {canEdit && (
          <Button
            type="button"
            variant="primary"
            disabled={pending || changed.length === 0}
            onClick={save}
          >
            {pending ? "Sparar…" : "Spara"}
          </Button>
        )}
        {saved && !pending && <FormSaved>Sparat</FormSaved>}
      </FormActions>

      <SectionHeading spaced>Historik</SectionHeading>
      <Table<{ id: string; month: string; consumed: number }>
        columns={[
          { key: "month", label: "Månad", width: "120px" },
          {
            key: "consumed",
            label: "Förbrukat",
            width: "120px",
            align: "right",
          },
        ]}
        rows={[...data.history].reverse().map((h) => ({ ...h, id: h.month }))}
        emptyText="Ingen förbrukning"
        renderCell={(row, key) =>
          key === "month" ? row.month : formatQuantity(row.consumed)
        }
      />
      <FormHint attached>
        Historik: {data.historyMonths} hela månader före innevarande. Snittet är{" "}
        {formatQuantity(data.average)}
        {unit} per månad.
      </FormHint>
    </Card>
  );
}

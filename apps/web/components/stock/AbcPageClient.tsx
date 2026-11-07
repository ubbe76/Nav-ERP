"use client";

import { ArticleOverviewButton } from "../articles/ArticleOverviewButton";
import { GatedLink } from "../ui/GatedLink";
import {
  ListExportLink,
  ListFilterSelect,
  ListToolbar,
  Pagination,
} from "../ui/ListControls";
import { Table } from "../ui/Table";
import { formatMoney, formatPercent, formatQuantity } from "../../lib/format";
import type { AbcResponse, AbcRow } from "../../lib/types";

const TYPE_LABELS: Record<AbcRow["type"], string> = {
  purchased: "Köpt",
  manufactured: "Tillverkad",
};

export function AbcPageClient({
  data,
  pageSize,
}: {
  data: AbcResponse;
  pageSize: number;
}) {
  // Without the price permission the API nulls every value/share.
  const seePrices = data.summary.some((s) => s.value !== null);
  const { period, limits } = data;

  const columns = [
    { key: "articleNumber", label: "Artikelnummer", width: "130px" },
    { key: "name", label: "Benämning", width: "minmax(120px, 1fr)" },
    { key: "type", label: "Typ", width: "80px" },
    { key: "abcClass", label: "ABC", width: "50px" },
    {
      key: "consumed",
      label: "Förbrukat",
      width: "80px",
      align: "right" as const,
    },
    ...(seePrices
      ? [
          {
            key: "value",
            label: "Förbrukningsvärde",
            width: "120px",
            align: "right" as const,
          },
          {
            key: "share",
            label: "Andel",
            width: "70px",
            align: "right" as const,
          },
          {
            key: "cumulativeShare",
            label: "Ackumulerat",
            width: "100px",
            align: "right" as const,
          },
        ]
      : []),
    {
      key: "reorderPoint",
      label: "Beställningspunkt",
      width: "140px",
      align: "right" as const,
    },
    {
      key: "safetyStock",
      label: "Säkerhetslager",
      width: "120px",
      align: "right" as const,
    },
    { key: "forecastControlled", label: "Prognosstyrd", width: "100px" },
  ];

  const rows = data.rows.map((r) => ({ ...r, id: r.articleId }));

  return (
    <>
      <p style={{ margin: "0 0 12px" }}>
        Förbrukning {period.from}–{period.to} ({period.months}{" "}
        {period.months === 1 ? "månad" : "månader"}), A upp till{" "}
        {limits.aPercent} %, B upp till {limits.bPercent} %
      </p>

      <Table<{
        id: string;
        abcClass: string;
        count: number;
        value: number | null;
        share: number | null;
      }>
        columns={[
          { key: "abcClass", label: "Klass", width: "80px" },
          { key: "count", label: "Artiklar", width: "100px", align: "right" },
          ...(seePrices
            ? [
                {
                  key: "value",
                  label: "Förbrukningsvärde",
                  width: "160px",
                  align: "right" as const,
                },
                {
                  key: "share",
                  label: "Andel",
                  width: "90px",
                  align: "right" as const,
                },
              ]
            : []),
        ]}
        rows={data.summary.map((s) => ({ ...s, id: s.abcClass }))}
        renderCell={(row, key) => {
          switch (key) {
            case "abcClass":
              return <strong>{row.abcClass}</strong>;
            case "count":
              return row.count.toLocaleString("sv-SE");
            case "value":
              return row.value === null ? "–" : `${formatMoney(row.value)} kr`;
            case "share":
              return row.share === null
                ? "–"
                : `${formatPercent(row.share, 2)}`;
            default:
              return null;
          }
        }}
      />

      <div style={{ height: 16 }} />

      <ListToolbar placeholder="Sök artikelnummer eller benämning…">
        <ListFilterSelect
          param="class"
          allLabel="Alla klasser"
          ariaLabel="Filtrera på ABC-klass"
          options={[
            { value: "A", label: "A" },
            { value: "B", label: "B" },
            { value: "C", label: "C" },
          ]}
        />
        <ListFilterSelect
          param="type"
          allLabel="Alla typer"
          ariaLabel="Filtrera på artikeltyp"
          options={[
            { value: "purchased", label: "Köpt" },
            { value: "manufactured", label: "Tillverkad" },
          ]}
        />
        <ListExportLink endpoint="/api/v1/planning/abc/csv" />
      </ListToolbar>

      {/* Eleven columns: scroll the table inside its own box on mid-width
          screens instead of widening the page (phones stack the rows). */}
      <div style={{ overflowX: "auto" }}>
        <Table<AbcRow & { id: string }>
          columns={columns}
          rows={rows}
          emptyText="Inga artiklar matchar filtren"
          renderCell={(row, key) => {
            switch (key) {
              case "articleNumber":
                return (
                  <>
                    <GatedLink
                      href={`/artiklar/${row.articleId}`}
                      style={{ color: "var(--accent-fg)" }}
                    >
                      {row.articleNumber}
                    </GatedLink>
                    <ArticleOverviewButton
                      articleId={row.articleId}
                      articleNumber={row.articleNumber}
                    />
                  </>
                );
              case "name":
                return row.name;
              case "type":
                return TYPE_LABELS[row.type];
              case "abcClass":
                return <strong>{row.abcClass}</strong>;
              case "consumed":
                return formatQuantity(row.consumed);
              case "value":
                return (
                  <span>
                    {row.value === null ? "–" : `${formatMoney(row.value)} kr`}
                    {row.missingStandardCost && (
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.85em",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        saknar standardpris
                      </span>
                    )}
                  </span>
                );
              case "share":
                return row.share === null ? "–" : formatPercent(row.share, 2);
              case "cumulativeShare":
                return row.cumulativeShare === null
                  ? "–"
                  : formatPercent(row.cumulativeShare, 2);
              case "reorderPoint":
                return row.reorderPoint === null
                  ? "–"
                  : formatQuantity(row.reorderPoint);
              case "safetyStock":
                return row.safetyStock === null
                  ? "–"
                  : formatQuantity(row.safetyStock);
              case "forecastControlled":
                return row.forecastControlled ? "Ja" : "–";
              default:
                return null;
            }
          }}
        />
      </div>

      <Pagination total={data.total} pageSize={pageSize} />
    </>
  );
}

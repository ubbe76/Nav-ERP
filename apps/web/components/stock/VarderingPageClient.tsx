"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { Table } from "../ui/Table";
import { API_URL, apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import buttonStyles from "../ui/Button.module.css";
import {
  VALUATION_METHOD_LABELS,
  type ArticleGroup,
  type RegisterEntry,
  type ValuationMethod,
  type ValuationResponse,
} from "../../lib/types";

const VALUATION_METHODS: ValuationMethod[] = ["standard", "latest_purchase", "moving_average"];

function isValuationMethod(value: string | undefined): value is ValuationMethod {
  return value !== undefined && (VALUATION_METHODS as string[]).includes(value);
}

// One flat row per printed line — same discriminated-row technique as
// BalansrakningPageClient's SheetRow, except the group total already comes
// pre-summed from the API (valuation.service.ts excludes unvalued rows).
type ValuationDisplayRow =
  | { id: string; kind: "group"; label: string; total: number }
  | {
      id: string;
      kind: "article";
      articleNumber: string;
      articleName: string;
      unit: string;
      quantity: number;
      unitCost: number | null;
      value: number | null;
    }
  | { id: "summa"; kind: "summa"; total: number };

function flatten(report: ValuationResponse): ValuationDisplayRow[] {
  const rows: ValuationDisplayRow[] = [];
  for (const group of report.groups) {
    rows.push({ id: `group-${group.groupId ?? "none"}`, kind: "group", label: group.groupName, total: group.total });
    for (const row of group.rows) {
      rows.push({
        id: row.articleId,
        kind: "article",
        articleNumber: row.articleNumber,
        articleName: row.articleName,
        unit: row.unit,
        quantity: row.quantity,
        unitCost: row.unitCost,
        value: row.value,
      });
    }
  }
  rows.push({ id: "summa", kind: "summa", total: report.totalValue });
  return rows;
}

export function VarderingPageClient({
  groups,
  articleCodes,
  defaultAsOf,
  defaultMethod,
  defaultGroupId,
  defaultArticleCodeId,
  defaultGroupBy,
}: {
  groups: ArticleGroup[];
  articleCodes: RegisterEntry[];
  defaultAsOf?: string;
  defaultMethod?: string;
  defaultGroupId?: string;
  defaultArticleCodeId?: string;
  defaultGroupBy?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const initialAsOf = useMemo(() => defaultAsOf ?? new Date().toLocaleDateString("sv-SE"), [defaultAsOf]);
  const [asOf, setAsOf] = useState(initialAsOf);
  const [method, setMethod] = useState<ValuationMethod>(
    isValuationMethod(defaultMethod) ? defaultMethod : "standard"
  );
  const [groupId, setGroupId] = useState(defaultGroupId ?? "");
  const [articleCodeId, setArticleCodeId] = useState(defaultArticleCodeId ?? "");
  // What the report is split by: varugrupp (default) or artikelkod.
  const [groupBy, setGroupBy] = useState<"group" | "articleCode">(defaultGroupBy === "articleCode" ? "articleCode" : "group");
  const [report, setReport] = useState<ValuationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function queryString(): string {
    const params = new URLSearchParams({ asOf, method, groupBy });
    if (groupId) params.set("groupId", groupId);
    if (articleCodeId) params.set("articleCodeId", articleCodeId);
    return params.toString();
  }

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    apiFetch<ValuationResponse>(`/api/v1/stock/valuation?${queryString()}`)
      .then((data) => {
        if (cancelled) return;
        setReport(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setReport(null);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryString() is derived from these
  }, [asOf, method, groupId, articleCodeId, groupBy]);

  useEffect(() => {
    router.replace(`${pathname}?${queryString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryString() is derived from these
  }, [asOf, method, groupId, articleCodeId, groupBy, pathname, router]);

  const rows = report ? flatten(report) : [];

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormStack>
          <FormRow columns={3}>
            <Field label="Per datum" htmlFor="valAsOf">
              <Input id="valAsOf" type="date" size="sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
            <Field label="Metod" htmlFor="valMethod">
              <Select id="valMethod" value={method} onChange={(e) => setMethod(e.target.value as ValuationMethod)}>
                {VALUATION_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {VALUATION_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Gruppera" htmlFor="valGroupBy">
              <Select id="valGroupBy" value={groupBy} onChange={(e) => setGroupBy(e.target.value as "group" | "articleCode")}>
                <option value="group">Varugrupp</option>
                <option value="articleCode">Artikelkod</option>
              </Select>
            </Field>
          </FormRow>
          <FormRow columns={3}>
            <Field label="Varugrupp" htmlFor="valGroup">
              <Select id="valGroup" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Alla varugrupper</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.code} {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Artikelkod" htmlFor="valArticleCode">
              <Select id="valArticleCode" value={articleCodeId} onChange={(e) => setArticleCodeId(e.target.value)}>
                <option value="">Alla artikelkoder</option>
                {articleCodes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
        </FormStack>
        {report && (
          <a
            href={`${API_URL}/api/v1/stock/valuation/pdf?${queryString()}`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Ladda ner PDF
          </a>
        )}
      </Card>

      {error && <FormError>{error}</FormError>}

      {report && report.unvaluedCount > 0 && (
        <FormHint>
          {report.unvaluedCount} {report.unvaluedCount === 1 ? "artikel saknar" : "artiklar saknar"} pris för vald
          metod och ingår inte i summan.
        </FormHint>
      )}

      {report && !pending && (
        <Card maxWidth="none">
          <Table<ValuationDisplayRow>
            columns={[
              { key: "article", label: "Artikel", width: "110px" },
              { key: "name", label: "Benämning", width: "1.4fr" },
              { key: "quantity", label: "Antal", width: "120px", align: "right" },
              { key: "unitCost", label: "À-kostnad", width: "130px", align: "right" },
              { key: "value", label: "Värde", width: "140px", align: "right" },
            ]}
            rows={rows}
            emptyText="Inget lagersaldo att värdera"
            renderCell={(row, key) => {
              if (row.kind === "article") {
                switch (key) {
                  case "article":
                    return row.articleNumber;
                  case "name":
                    return row.articleName;
                  case "quantity":
                    return (
                      <span className="num">
                        {row.quantity.toLocaleString("sv-SE")} {row.unit}
                      </span>
                    );
                  case "unitCost":
                    return row.unitCost !== null ? (
                      <span className="num">{formatMoney(row.unitCost)}</span>
                    ) : (
                      <span className="num" style={{ color: "var(--color-text-muted)" }}>
                        pris saknas
                      </span>
                    );
                  case "value":
                    return <span className="num">{row.value !== null ? formatMoney(row.value) : "—"}</span>;
                  default:
                    return "";
                }
              }
              switch (key) {
                case "name":
                  return <strong>{row.kind === "summa" ? "SUMMA LAGERVÄRDE" : row.label}</strong>;
                case "value":
                  return (
                    <span className="num" style={{ fontWeight: 600 }}>
                      {formatMoney(row.total)}
                    </span>
                  );
                default:
                  return "";
              }
            }}
          />
        </Card>
      )}
    </>
  );
}

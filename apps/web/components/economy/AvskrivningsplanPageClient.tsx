"use client";

import { useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormNotice } from "../ui/Form";
import { Table } from "../ui/Table";
import { API_URL } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import type { FiscalYear, FixedAssetPlan, FixedAssetPlanRow, FixedAssetPlanTotals } from "../../lib/types";
import buttonStyles from "../ui/Button.module.css";

const COLUMNS = [
  { key: "assetNumber", label: "Nr", width: "80px" },
  { key: "name", label: "Benämning", width: "2fr" },
  { key: "acquisitionDate", label: "Anskaffad", width: "100px" },
  { key: "acquisitionOpening", label: "IB ansk.", width: "1fr", align: "right" as const },
  { key: "acquisitions", label: "Anskaffningar", width: "1fr", align: "right" as const },
  { key: "disposals", label: "Avyttringar", width: "1fr", align: "right" as const },
  { key: "acquisitionClosing", label: "UB ansk.", width: "1fr", align: "right" as const },
  { key: "depreciationOpening", label: "IB ack.", width: "1fr", align: "right" as const },
  { key: "depreciationYear", label: "Årets avskr.", width: "1fr", align: "right" as const },
  { key: "depreciationDisposed", label: "Avskr. avyttrat", width: "1fr", align: "right" as const },
  { key: "depreciationClosing", label: "UB ack.", width: "1fr", align: "right" as const },
  { key: "bookValueClosing", label: "Bokfört värde", width: "1fr", align: "right" as const },
];

const MONEY_KEYS: (keyof FixedAssetPlanTotals)[] = [
  "acquisitionOpening",
  "acquisitions",
  "disposals",
  "acquisitionClosing",
  "depreciationOpening",
  "depreciationYear",
  "depreciationDisposed",
  "depreciationClosing",
  "bookValueClosing",
];

type PlanTableRow = FixedAssetPlanRow & { id: string };

function renderPlanCell(row: PlanTableRow, key: string) {
  if ((MONEY_KEYS as string[]).includes(key)) return formatMoney(row[key as keyof FixedAssetPlanTotals]);
  // null, not "": a cell without content is hidden in the stacked phone layout
  // instead of printing its label next to nothing (the total row has no Nr/Anskaffad).
  const value = row[key as keyof FixedAssetPlanRow];
  return value === null || value === undefined || value === "" ? null : String(value);
}

function totalsFooter(totals: FixedAssetPlanTotals, label: string) {
  return Object.fromEntries([["name", label], ...MONEY_KEYS.map((key) => [key, formatMoney(totals[key])])]);
}

export function AvskrivningsplanPageClient({
  fiscalYears,
  selectedId,
  plan,
}: {
  fiscalYears: FiscalYear[];
  selectedId: string | null;
  plan: FixedAssetPlan | null;
}) {
  const router = useRouter();
  const mismatches = plan?.reconciliation.filter((row) => row.mismatch) ?? [];
  const grandTotal: PlanTableRow | null = plan
    ? {
        ...plan.totals,
        id: "total",
        assetId: "total",
        assetNumber: "",
        name: "Summa alla grupper",
        acquisitionDate: "",
        disposalDate: null,
      }
    : null;

  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <Field label="Räkenskapsår" htmlFor="plan-year">
          <Select id="plan-year" value={selectedId ?? ""} onChange={(e) => router.push(`/ekonomi/avskrivningsplan?fiscalYearId=${e.target.value}`)}>
            {fiscalYears.map((year) => (
              <option key={year.id} value={year.id}>
                {year.label}
              </option>
            ))}
          </Select>
        </Field>
        {selectedId && (
          <>
            <a href={`${API_URL}/api/v1/fixed-asset-plan/pdf?fiscalYearId=${selectedId}`} download className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Ladda ner PDF
            </a>
            <a href={`${API_URL}/api/v1/fixed-asset-plan/csv?fiscalYearId=${selectedId}`} download className={`${buttonStyles.button} ${buttonStyles.ghost}`}>
              Exportera CSV
            </a>
          </>
        )}
      </div>

      {!plan && <p>Det finns inget räkenskapsår att visa planen för.</p>}

      {plan && (
        <Card maxWidth="none" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>Avstämning mot huvudboken per {plan.fiscalYear.endDate}</h2>
          {mismatches.length === 0 ? (
            <p style={{ color: "var(--status-done-text)" }}>Registret stämmer mot huvudboken.</p>
          ) : (
            mismatches.map((row) => (
              <FormNotice key={row.accountId}>
                Registret stämmer inte mot konto {row.accountNumber} {row.accountName}: huvudbok {formatMoney(row.ledgerAmount)}, register{" "}
                {formatMoney(row.registerAmount)} (skillnad {row.difference > 0 ? "+" : ""}
                {formatMoney(row.difference)})
              </FormNotice>
            ))
          )}
          <Table
            columns={[
              { key: "account", label: "Konto", width: "2fr" },
              { key: "register", label: "Register", width: "1fr", align: "right" as const },
              { key: "ledger", label: "Huvudbok", width: "1fr", align: "right" as const },
              { key: "difference", label: "Skillnad", width: "1fr", align: "right" as const },
            ]}
            rows={plan.reconciliation.map((row) => ({ ...row, id: row.accountId }))}
            emptyText="Inga konton att stämma av"
            renderCell={(row, key) => {
              switch (key) {
                case "account":
                  return `${row.accountNumber} ${row.accountName}`;
                case "register":
                  return formatMoney(row.registerAmount);
                case "ledger":
                  return formatMoney(row.ledgerAmount);
                case "difference":
                  return <span style={row.mismatch ? { color: "var(--status-delayed-text)" } : undefined}>{formatMoney(row.difference)}</span>;
                default:
                  return null;
              }
            }}
          />
        </Card>
      )}

      {plan?.categories
        .filter((category) => category.assets.length > 0)
        .map((category) => (
          <Card key={category.categoryId} maxWidth="none" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>
              {category.categoryName} ({category.assetAccountNumber} / {category.accumulatedAccountNumber})
            </h2>
            <Table
              columns={COLUMNS}
              rows={category.assets.map((row) => ({ ...row, id: row.assetId }))}
              renderCell={renderPlanCell}
              footer={totalsFooter(category.totals, `Summa ${category.categoryName.toLowerCase()}`)}
            />
          </Card>
        ))}

      {plan && plan.categories.every((category) => category.assets.length === 0) && <p>Inga anläggningar under räkenskapsåret.</p>}

      {grandTotal && plan && plan.categories.some((category) => category.assets.length > 0) && (
        <Card maxWidth="none">
          <h2 style={{ marginTop: 0 }}>Alla grupper</h2>
          <Table columns={COLUMNS} rows={[grandTotal]} renderCell={renderPlanCell} />
        </Card>
      )}
    </>
  );
}

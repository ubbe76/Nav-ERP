"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormActions, FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import type { Account, FiscalYear, ResultTransferPreview, YearEndClosingDetail } from "../../lib/types";
import { YEAR_END_ROLE_LABELS, YEAR_END_STEP_LABELS } from "../../lib/yearEnd";
import { AccrualsCard } from "./bokslut/AccrualsCard";
import { ClosedYearPanel } from "./bokslut/ClosedYearPanel";
import { FxRevaluationCard } from "./bokslut/FxRevaluationCard";
import { ChecksCard, CloseCard, DepreciationCard, InventoryCard, ResultTransferCard, VerificationLink } from "./bokslut/StepCards";
import { useStepAction } from "./bokslut/useStepAction";

export function BokslutPageClient({
  fiscalYears,
  selectedId,
  closing,
  accounts,
  resultTransferPreview,
  resultTransferAccountsMissing,
}: {
  fiscalYears: FiscalYear[];
  selectedId: string | null;
  closing: YearEndClosingDetail | null;
  accounts: Account[];
  resultTransferPreview: ResultTransferPreview | null;
  resultTransferAccountsMissing: boolean;
}) {
  const router = useRouter();
  const year = fiscalYears.find((candidate) => candidate.id === selectedId) ?? null;

  return (
    // minmax(0, 1fr): a card's floor would otherwise be its content's
    // min-content (the step tables' px tracks and selects), widening the
    // page past a phone; wider content scrolls inside the Table instead.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
      <Card maxWidth="none">
        {fiscalYears.length === 0 ? (
          <p>Lägg upp ett räkenskapsår under Räkenskapsår först.</p>
        ) : (
          <Field label="Räkenskapsår" htmlFor="bokslutYear">
            <Select id="bokslutYear" value={selectedId ?? ""} onChange={(e) => router.push(`/ekonomi/bokslut?fiscalYearId=${e.target.value}`)}>
              {fiscalYears.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                  {candidate.status === "closed" ? " (stängt)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      {year && !closing && <StartClosingCard year={year} />}

      {closing?.status === "in_progress" && (
        <>
          <ClosingDateCard closing={closing} />
          <ChecksCard closing={closing} />
          <InventoryCard closing={closing} />
          <DepreciationCard closing={closing} />
          <AccrualsCard
            key={closing.steps.accruals.verification?.id ?? `none-${closing.steps.accruals.bookedAt ?? "unbooked"}`}
            closing={closing}
            accounts={accounts}
          />
          <FxRevaluationCard key={closing.id} closing={closing} />
          <ResultTransferCard closing={closing} preview={resultTransferPreview} accountsMissing={resultTransferAccountsMissing} />
          <CloseCard closing={closing} />
        </>
      )}

      {closing?.status === "closed" && <ClosedYearPanel closing={closing} />}

      {closing && <HistoryCard closing={closing} />}
    </div>
  );
}

// Last period = the month of the year's end date, clipped to the year start.
function lastPeriodStart(year: FiscalYear): string {
  const monthStart = `${year.endDate.slice(0, 7)}-01`;
  return monthStart < year.startDate ? year.startDate : monthStart;
}

function StartClosingCard({ year }: { year: FiscalYear }) {
  const [closingDate, setClosingDate] = useState(year.endDate);
  const action = useStepAction();
  return (
    <Card maxWidth="none">
      <SectionHeading>Starta bokslut för {year.label}</SectionHeading>
      <Field label="Bokslutsdatum" htmlFor="closingDate">
        <Input
          id="closingDate"
          type="date"
          min={lastPeriodStart(year)}
          max={year.endDate}
          value={closingDate}
          onChange={(e) => setClosingDate(e.target.value)}
        />
      </Field>
      <FormError>{action.error}</FormError>
      <FormActions>
        <Button
          type="button"
          disabled={action.pending}
          onClick={() =>
            action.run(async () => {
              await apiFetch("/api/v1/year-end-closings", {
                method: "POST",
                body: JSON.stringify({ fiscalYearId: year.id, closingDate }),
              });
              return null;
            })
          }
        >
          Starta bokslut
        </Button>
      </FormActions>
    </Card>
  );
}

// The closing date can change until the first step is booked (the API refuses
// afterwards and says so in closingDateLocked), so the field is only offered
// while nothing has been booked.
function ClosingDateCard({ closing }: { closing: YearEndClosingDetail }) {
  const [closingDate, setClosingDate] = useState(closing.closingDate);
  const action = useStepAction();
  const locked = closing.closingDateLocked;
  return (
    <Card maxWidth="none">
      <SectionHeading>Bokslutsdatum</SectionHeading>
      {locked ? (
        <p>{closing.closingDate}</p>
      ) : (
        <>
          <Field label="Bokslutsdatum" htmlFor="closingDateEdit">
            <Input
              id="closingDateEdit"
              type="date"
              min={closing.closingPeriod.startDate}
              max={closing.fiscalYear.endDate}
              value={closingDate}
              onChange={(e) => setClosingDate(e.target.value)}
            />
          </Field>
          <FormError>{action.error}</FormError>
          <FormActions>
            <Button
              type="button"
              variant="secondary"
              disabled={action.pending || closingDate === closing.closingDate || closingDate === ""}
              onClick={() =>
                action.run(async () => {
                  await apiFetch(`/api/v1/year-end-closings/${closing.id}`, { method: "PATCH", body: JSON.stringify({ closingDate }) });
                  return null;
                })
              }
            >
              Spara bokslutsdatum
            </Button>
          </FormActions>
        </>
      )}
    </Card>
  );
}

function HistoryCard({ closing }: { closing: YearEndClosingDetail }) {
  return (
    <Card maxWidth="none">
      <SectionHeading>Bokslutsverifikat</SectionHeading>
      <Table<YearEndClosingDetail["history"][number] & { id: string }>
        columns={[
          { key: "verification", label: "Verifikat", width: "140px" },
          { key: "date", label: "Datum", width: "110px" },
          { key: "step", label: "Steg", width: "1fr" },
          { key: "role", label: "Typ", width: "1fr" },
        ]}
        rows={closing.history.map((row) => ({ ...row, id: row.verification.id }))}
        emptyText="Inga bokslutsverifikat ännu."
        renderCell={(row, key) => {
          switch (key) {
            case "verification":
              return <VerificationLink verification={row.verification} />;
            case "date":
              return row.verification.date;
            case "step":
              return YEAR_END_STEP_LABELS[row.step];
            case "role":
              return YEAR_END_ROLE_LABELS[row.role];
            default:
              return null;
          }
        }}
      />
    </Card>
  );
}

"use client";

import { confirmDialog } from "../../../lib/confirm";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox, Field, Select } from "../../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../../ui/Form";
import { Modal } from "../../ui/Modal";
import { SectionHeading } from "../../ui/SectionHeading";
import { StatusPill } from "../../ui/StatusPill";
import { Table } from "../../ui/Table";
import { apiFetch } from "../../../lib/api";
import { monthLabel } from "../../../lib/fixedAssets";
import { formatMoney } from "../../../lib/format";
import {
  VALUATION_METHOD_LABELS,
  type DepreciationPreview,
  type InventoryPreview,
  type ResultTransferPreview,
  type ValuationMethod,
  type YearEndBookResult,
  type YearEndClosingDetail,
  type YearEndPostingRow,
  type YearEndVerificationRef,
} from "../../../lib/types";
import { STEP_STATUS_PILL } from "../../../lib/yearEnd";
import { UnlockPeriodForm } from "../UnlockPeriodForm";
import { bookedNotice, useStepAction } from "./useStepAction";
import styles from "./Bokslut.module.css";

type PillKey = keyof typeof STEP_STATUS_PILL;

export function StepHeader({ number, title, status }: { number: number; title: string; status: PillKey }) {
  const pill = STEP_STATUS_PILL[status];
  return <SectionHeading actions={<StatusPill status={pill.status} label={pill.label} compact />}>{`${number}. ${title}`}</SectionHeading>;
}

export function VerificationLink({ verification }: { verification: YearEndVerificationRef | null }) {
  if (!verification) return null;
  return <Link href={`/ekonomi/verifikat/${verification.id}`}>{verification.displayNumber}</Link>;
}

// Debit/credit table; an empty set gets its own sentence (Table draws no
// footer for zero rows).
export function PostingTable({ rows, empty }: { rows: YearEndPostingRow[]; empty: string }) {
  if (rows.length === 0) return <p>{empty}</p>;
  return (
    <Table<YearEndPostingRow & { id: string }>
      columns={[
        { key: "account", label: "Konto", width: "2fr" },
        { key: "debit", label: "Debet", width: "1fr", align: "right" },
        { key: "credit", label: "Kredit", width: "1fr", align: "right" },
      ]}
      rows={rows.map((row) => ({ ...row, id: row.accountNumber }))}
      renderCell={(row, key) => {
        if (key === "account") return row.accountName ? `${row.accountNumber} ${row.accountName}` : row.accountNumber;
        if (key === "debit") return row.debit ? formatMoney(row.debit) : "";
        return row.credit ? formatMoney(row.credit) : "";
      }}
    />
  );
}

function stepState(closing: YearEndClosingDetail, status: PillKey): PillKey {
  return closing.checks.stepBlockers.length > 0 && status !== "done" ? "blocked" : status;
}

export function ChecksCard({ closing }: { closing: YearEndClosingDetail }) {
  const router = useRouter();
  const [unlocking, setUnlocking] = useState(false);
  const { stepBlockers, warnings, draftVerifications } = closing.checks;
  const status: PillKey = stepBlockers.length > 0 ? "blocked" : warnings.length > 0 ? "warnings" : "done";
  return (
    <Card maxWidth="none">
      <StepHeader number={1} title="Kontroller" status={status} />
      {stepBlockers.length === 0 && warnings.length === 0 && <p>Inga spärrar eller varningar.</p>}
      {stepBlockers.map((check) => (
        <FormError key={check.code} margin="below">
          {check.message}
        </FormError>
      ))}
      {stepBlockers.some((check) => check.code === "draft-verifications") && draftVerifications.length > 0 && (
        <ul>
          {draftVerifications.map((draft) => (
            <li key={draft.id}>
              <Link href={`/ekonomi/verifikat/${draft.id}`}>
                {draft.date} {draft.description}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {stepBlockers.some((check) => check.code === "closing-period-locked") && (
        <FormActions className={styles.actions}>
          <Button type="button" variant="secondary" size="small" onClick={() => setUnlocking(true)}>
            Lås upp period
          </Button>
        </FormActions>
      )}
      {warnings.map((check) => (
        <FormNotice key={`${check.code}-${check.message}`}>{check.message}</FormNotice>
      ))}
      <Modal open={unlocking} onClose={() => setUnlocking(false)} title="Lås upp bokslutsmånaden">
        {unlocking && (
          <UnlockPeriodForm
            key={closing.closingPeriod.id}
            periodId={closing.closingPeriod.id}
            onDone={() => {
              setUnlocking(false);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </Card>
  );
}

export function InventoryCard({ closing }: { closing: YearEndClosingDetail }) {
  const step = closing.steps.inventory;
  const blocked = closing.checks.stepBlockers.length > 0;
  const [method, setMethod] = useState<ValuationMethod>(step.method ?? closing.defaultInventoryMethod);
  const [preview, setPreview] = useState<InventoryPreview | null>(null);
  const action = useStepAction();
  const base = `/api/v1/year-end-closings/${closing.id}`;

  return (
    <Card maxWidth="none">
      <StepHeader number={2} title="Lagerförändring" status={stepState(closing, step.status)} />
      {step.status !== "not_done" && (
        <p>
          Bokfört lagervärde {formatMoney(step.value ?? 0)} ({step.method ? VALUATION_METHOD_LABELS[step.method] : ""}){" "}
          {step.verification ? <VerificationLink verification={step.verification} /> : "— ingen skillnad att bokföra"}
        </p>
      )}
      {step.status === "stale" && <FormNotice>Lagerkontot har ändrats efter bokningen — gör om steget.</FormNotice>}
      <Field label="Värderingsmetod" htmlFor="inventoryMethod">
        <Select
          id="inventoryMethod"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as ValuationMethod);
            setPreview(null);
          }}
        >
          {(Object.keys(VALUATION_METHOD_LABELS) as ValuationMethod[]).map((key) => (
            <option key={key} value={key}>
              {VALUATION_METHOD_LABELS[key]}
            </option>
          ))}
        </Select>
      </Field>
      {preview && (
        <>
          <p>
            Lagervärde per {preview.asOf}: {formatMoney(preview.value)} · Saldo på lagerkontot: {formatMoney(preview.ledgerExcludingStep)} · Skillnad:{" "}
            {formatMoney(preview.difference)}
          </p>
          {preview.unvaluedCount > 0 && (
            <FormNotice>
              {preview.unvaluedCount} artiklar saknar pris och räknas som 0
              {preview.unvaluedArticles.length > 0 && `: ${preview.unvaluedArticles.map((a) => a.articleNumber).join(", ")}${preview.unvaluedCount > preview.unvaluedArticles.length ? " …" : ""}`}.
            </FormNotice>
          )}
          {preview.unchanged && <FormHint>Samma som redan bokfört.</FormHint>}
          <PostingTable rows={preview.rows} empty="Ingen skillnad att bokföra." />
        </>
      )}
      <FormError>{action.error}</FormError>
      {action.notice && <FormHint>{action.notice}</FormHint>}
      <FormActions className={styles.actions}>
        <Button
          type="button"
          variant="ghost"
          disabled={action.pending}
          onClick={() =>
            action.run(async () => {
              setPreview(await apiFetch<InventoryPreview>(`${base}/inventory-preview?method=${method}`));
              return null;
            }, false)
          }
        >
          Visa lagervärdering
        </Button>
        <Button
          type="button"
          disabled={action.pending || blocked}
          onClick={() =>
            action.run(async () => {
              const result = await apiFetch<YearEndBookResult>(`${base}/inventory`, { method: "POST", body: JSON.stringify({ method }) });
              setPreview(null);
              return bookedNotice("Lagerförändring", result);
            })
          }
        >
          Bokför lagerförändring
        </Button>
      </FormActions>
    </Card>
  );
}

export function DepreciationCard({ closing }: { closing: YearEndClosingDetail }) {
  const step = closing.steps.depreciation;
  const blocked = closing.checks.stepBlockers.length > 0;
  const [preview, setPreview] = useState<DepreciationPreview | null>(null);
  const action = useStepAction();

  return (
    <Card maxWidth="none">
      <StepHeader number={3} title="Avskrivningar" status={stepState(closing, step.status)} />
      <p>
        {step.status === "done"
          ? `Alla avskrivningar t.o.m. ${monthLabel(step.throughMonth)} är bokförda.`
          : `${step.missingAssets} anläggningar saknar avskrivning t.o.m. ${monthLabel(step.throughMonth)} (${formatMoney(step.missingAmount)}).`}{" "}
        <Link href="/ekonomi/anlaggningar">Anläggningsregistret</Link>
      </p>
      {preview && preview.assets.length > 0 && (
        <Table<DepreciationPreview["assets"][number] & { id: string }>
          columns={[
            { key: "assetNumber", label: "Nr", width: "90px" },
            { key: "name", label: "Benämning", width: "2fr" },
            { key: "months", label: "Månader", width: "1fr" },
            { key: "amount", label: "Belopp", width: "1fr", align: "right" },
          ]}
          rows={preview.assets.map((asset) => ({ ...asset, id: asset.assetId }))}
          renderCell={(row, key) => {
            if (key === "months") return row.months.map((m) => monthLabel(m.month)).join(", ");
            if (key === "amount") return formatMoney(row.amount);
            return String(row[key as "assetNumber" | "name"]);
          }}
          footer={{ name: "Summa", amount: formatMoney(preview.total) }}
        />
      )}
      {preview && preview.assets.length === 0 && <p>Inget att bokföra.</p>}
      <FormError>{action.error}</FormError>
      {action.notice && <FormHint>{action.notice}</FormHint>}
      {step.status !== "done" && (
        <FormActions className={styles.actions}>
          <Button
            type="button"
            variant="ghost"
            disabled={action.pending}
            onClick={() =>
              action.run(async () => {
                setPreview(await apiFetch<DepreciationPreview>(`/api/v1/fixed-asset-depreciation-runs/preview?throughMonth=${step.throughMonth}`));
                return null;
              }, false)
            }
          >
            Visa avskrivningar
          </Button>
          <Button
            type="button"
            disabled={action.pending || blocked}
            onClick={() =>
              action.run(async () => {
                const result = await apiFetch<{ unchanged: boolean; run: { verification: { displayNumber: string } } | null }>(
                  `/api/v1/year-end-closings/${closing.id}/depreciation`,
                  { method: "POST" }
                );
                setPreview(null);
                return result.run ? `Avskrivningar bokförda — Verifikat ${result.run.verification.displayNumber}` : "Inget att bokföra";
              })
            }
          >
            Bokför avskrivningar
          </Button>
        </FormActions>
      )}
    </Card>
  );
}

export function ResultTransferCard({
  closing,
  preview,
  accountsMissing,
}: {
  closing: YearEndClosingDetail;
  preview: ResultTransferPreview | null;
  accountsMissing: boolean;
}) {
  const step = closing.steps.resultTransfer;
  const blocked = closing.checks.stepBlockers.length > 0;
  const earlierDone =
    closing.steps.inventory.status !== "not_done" &&
    closing.steps.depreciation.status === "done" &&
    closing.steps.accruals.status === "done";
  const action = useStepAction();
  return (
    <Card maxWidth="none">
      <StepHeader number={5} title="Resultatöverföring" status={stepState(closing, step.status)} />
      <p>
        Årets resultat: {formatMoney(step.yearResult)} <VerificationLink verification={step.verification} />
      </p>
      {step.status === "stale" && <FormNotice>Bokföringen har ändrats efter överföringen — gör om steget.</FormNotice>}
      {accountsMissing ? (
        <FormNotice>
          Konto 8999 eller 2099 saknas eller är inaktivt — lägg upp eller aktivera det i{" "}
          <Link href="/ekonomi/kontoplan">Kontoplan</Link> (t.ex. med <strong>Förifyll BAS-urval</strong>).
        </FormNotice>
      ) : (
        <PostingTable rows={preview?.rows ?? []} empty="Resultatet är 0,00 — inget att överföra." />
      )}
      {!earlierDone && <FormHint>Gör stegen 2–4 först.</FormHint>}
      <FormError>{action.error}</FormError>
      {action.notice && <FormHint>{action.notice}</FormHint>}
      <FormActions className={styles.actions}>
        <Button
          type="button"
          disabled={action.pending || blocked || !earlierDone}
          onClick={() =>
            action.run(async () =>
              bookedNotice(
                "Resultatöverföring",
                await apiFetch<YearEndBookResult>(`/api/v1/year-end-closings/${closing.id}/result-transfer`, { method: "POST" })
              )
            )
          }
        >
          Bokför resultatöverföring
        </Button>
      </FormActions>
    </Card>
  );
}

export function CloseCard({ closing }: { closing: YearEndClosingDetail }) {
  const { closeBlockers, warnings } = closing.checks;
  const [reviewed, setReviewed] = useState(false);
  const action = useStepAction();
  const label = closing.fiscalYear.label;

  return (
    <Card maxWidth="none">
      <StepHeader number={6} title="Stäng året" status={closeBlockers.length > 0 ? "blocked" : "not_done"} />
      {closeBlockers.map((check) => (
        <FormError key={check.code} margin="below">
          {check.message}
        </FormError>
      ))}
      {warnings.map((check) => (
        <FormNotice key={`${check.code}-${check.message}`}>{check.message}</FormNotice>
      ))}
      {closing.ibCheck === null && <p>Nästa räkenskapsår är inte upplagt — inga ingående balanser att stämma av.</p>}
      {closing.ibCheck && closing.ibCheck.differences.length === 0 && (
        <p>Ingående balanser för {closing.ibCheck.nextFiscalYearLabel} stämmer med årets utgående balanser.</p>
      )}
      {closing.ibCheck && closing.ibCheck.differences.length > 0 && (
        <Table<{ id: string; accountNumber: string; accountName: string; ub: number; ib: number; difference: number }>
          columns={[
            { key: "account", label: "Konto", width: "2fr" },
            { key: "ub", label: `UB ${label}`, width: "1fr", align: "right" },
            { key: "ib", label: `IB ${closing.ibCheck.nextFiscalYearLabel}`, width: "1fr", align: "right" },
            { key: "difference", label: "Skillnad", width: "1fr", align: "right" },
          ]}
          rows={closing.ibCheck.differences.map((row) => ({ ...row, id: row.accountNumber }))}
          renderCell={(row, key) => {
            if (key === "account") return `${row.accountNumber} ${row.accountName}`;
            return formatMoney(row[key as "ub" | "ib" | "difference"]);
          }}
        />
      )}
      {warnings.length > 0 && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <Checkbox checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
          Jag har granskat varningarna
        </label>
      )}
      <FormError>{action.error}</FormError>
      <FormActions className={styles.actions}>
        <Button
          type="button"
          variant="danger"
          disabled={action.pending || closeBlockers.length > 0 || (warnings.length > 0 && !reviewed)}
          onClick={async () => {
            if (!(await confirmDialog(`Alla perioder låses och inga fler verifikat kan bokföras i ${label}. Fortsätt?`))) return;
            void action.run(async () => {
              await apiFetch(`/api/v1/year-end-closings/${closing.id}/close`, { method: "POST" });
              return null;
            });
          }}
        >
          Stäng räkenskapsåret
        </Button>
      </FormActions>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Input, Select } from "../../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../../ui/Form";
import { Table } from "../../ui/Table";
import { apiFetch } from "../../../lib/api";
import type { Account, YearEndClosingDetail } from "../../../lib/types";
import {
  DEFAULT_BALANCE_ACCOUNT,
  YEAR_END_ACCRUAL_KIND_LABELS,
  accrualPreview,
  highestNewRowSeq,
  type YearEndAccrualKind,
} from "../../../lib/yearEnd";
import { PostingTable, StepHeader, VerificationLink } from "./StepCards";
import { useStepAction } from "./useStepAction";
import styles from "./Bokslut.module.css";

type Draft = {
  id: string;
  kind: YearEndAccrualKind;
  balanceAccountId: string;
  resultAccountId: string;
  amount: string;
  description: string;
};

// Plain counter: the UUID API is undefined outside a secure context (plain http on the LAN).
let newRowSeq = 0;

function isComplete(row: Draft): boolean {
  return row.balanceAccountId !== "" && row.resultAccountId !== "" && Number(row.amount) > 0 && row.description.trim() !== "";
}

// The parent keys this card on the live accrual verification, so a booking
// (or "Inga periodiseringar") re-initialises the rows from the server.
export function AccrualsCard({ closing, accounts }: { closing: YearEndClosingDetail; accounts: Account[] }) {
  const step = closing.steps.accruals;
  const blocked = closing.checks.stepBlockers.length > 0;
  const storageKey = `bokslut-accruals-${closing.id}`;
  const action = useStepAction();
  const fromServer = (): Draft[] =>
    step.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      balanceAccountId: row.balanceAccountId,
      resultAccountId: row.resultAccountId,
      amount: String(row.amount),
      description: row.description,
    }));
  const [rows, setRows] = useState<Draft[]>(fromServer);
  // The booking a draft was made on (null = none yet). A draft made before
  // someone else booked the step would otherwise hide the rows they booked.
  const basis = step.bookedAt;
  const [discarded, setDiscarded] = useState(false);

  // An unsent draft survives a reload (per-viewer convenience only) — but
  // only on the booking it was made on; a stale one is dropped with a notice.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as { basis: string | null; rows: Draft[] } | Draft[] | null;
      if (stored === null || typeof stored !== "object") {
        window.localStorage.removeItem(storageKey);
        return;
      }
      // An array is a draft saved before the basis was stored: it can only
      // be trusted while nothing has been booked.
      const draft = Array.isArray(stored) ? (basis === null ? { basis, rows: stored } : null) : stored;
      if (!draft || draft.basis !== basis) {
        window.localStorage.removeItem(storageKey);
        setDiscarded(true);
        return;
      }
      newRowSeq = Math.max(newRowSeq, highestNewRowSeq(draft.rows.map((row) => row.id)));
      setRows(draft.rows);
    } catch {
      // storage blocked or corrupt — start from the server's rows
    }
  }, [storageKey, basis]);

  function update(next: Draft[]) {
    setRows(next);
    setDiscarded(false);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ basis, rows: next }));
    } catch {
      // ignore
    }
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

  const balanceAccounts = accounts.filter((a) => a.active && a.number < "3000");
  const resultAccounts = accounts.filter((a) => a.active && a.number >= "3000" && a.number <= "8999");
  const accountLabel = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    return account ? `${account.number} ${account.name}` : "";
  };
  const idForNumber = (number: string) => accounts.find((a) => a.number === number)?.id ?? "";
  const complete = rows.filter(isComplete);
  const preview = accrualPreview(complete.map((row) => ({ ...row, amount: Number(row.amount) }))).map((row) => ({
    accountNumber: accountLabel(row.accountId),
    debit: row.debit,
    credit: row.credit,
  }));
  const reversalText = closing.nextFiscalYear
    ? `Återförs automatiskt ${closing.nextFiscalYear.startDate}.`
    : `Räkenskapsåret efter ${closing.fiscalYear.label} skapas automatiskt när periodiseringarna bokförs.`;

  function setRow(id: string, patch: Partial<Draft>) {
    update(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function book(set: Draft[]) {
    await action.run(async () => {
      const result = await apiFetch<{ verification: { displayNumber: string } | null; unchanged: boolean }>(
        `/api/v1/year-end-closings/${closing.id}/accruals`,
        {
          method: "PUT",
          body: JSON.stringify({
            rows: set.map((row) => ({
              kind: row.kind,
              balanceAccountId: row.balanceAccountId,
              resultAccountId: row.resultAccountId,
              amount: Number(row.amount),
              description: row.description.trim(),
            })),
          }),
        }
      );
      clearDraft();
      if (result.unchanged) return "Periodiseringar: oförändrat — inget nytt verifikat";
      return result.verification ? `Periodiseringar bokförda — Verifikat ${result.verification.displayNumber}` : "Inga periodiseringar";
    });
  }

  return (
    <Card maxWidth="none">
      <StepHeader number={4} title="Periodiseringar" status={blocked && step.status !== "done" ? "blocked" : step.status} />
      {step.status === "done" && (
        <p>
          {step.verification ? (
            <>
              Bokfört <VerificationLink verification={step.verification} />, återföring{" "}
              <VerificationLink verification={step.reversalVerification} />.
            </>
          ) : (
            "Inga periodiseringar."
          )}
        </p>
      )}
      {discarded && (
        <FormNotice>
          Ett osparat utkast i den här webbläsaren gällde en tidigare bokföring av periodiseringarna och har tagits bort — raderna nedan är de
          som är bokförda nu.
        </FormNotice>
      )}
      <Table<Draft>
        columns={[
          { key: "kind", label: "Typ", width: "1.2fr" },
          { key: "balance", label: "Balanskonto", width: "1.4fr" },
          { key: "result", label: "Resultatkonto", width: "1.4fr" },
          { key: "amount", label: "Belopp", width: "120px", align: "right" },
          { key: "description", label: "Text", width: "1.6fr" },
          { key: "actions", label: "", width: "90px", align: "right" },
        ]}
        rows={rows}
        emptyText="Inga periodiseringsrader."
        renderCell={(row, key) => {
          switch (key) {
            case "kind":
              return (
                <Select
                  className={styles.control}
                  aria-label="Typ"
                  value={row.kind}
                  onChange={(e) => {
                    const kind = e.target.value as YearEndAccrualKind;
                    setRow(row.id, { kind, balanceAccountId: idForNumber(DEFAULT_BALANCE_ACCOUNT[kind]) });
                  }}
                >
                  {(Object.keys(YEAR_END_ACCRUAL_KIND_LABELS) as YearEndAccrualKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {YEAR_END_ACCRUAL_KIND_LABELS[kind]}
                    </option>
                  ))}
                </Select>
              );
            case "balance":
              return (
                <Select className={styles.control} aria-label="Balanskonto" value={row.balanceAccountId} onChange={(e) => setRow(row.id, { balanceAccountId: e.target.value })}>
                  <option value="">Välj konto</option>
                  {balanceAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} · {a.name}
                    </option>
                  ))}
                </Select>
              );
            case "result":
              return (
                <Select className={styles.control} aria-label="Resultatkonto" value={row.resultAccountId} onChange={(e) => setRow(row.id, { resultAccountId: e.target.value })}>
                  <option value="">Välj konto</option>
                  {resultAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} · {a.name}
                    </option>
                  ))}
                </Select>
              );
            case "amount":
              return (
                <Input
                  className={styles.control}
                  aria-label="Belopp"
                  type="number"
                  min="0"
                  step="0.01"
                  value={row.amount}
                  onChange={(e) => setRow(row.id, { amount: e.target.value })}
                />
              );
            case "description":
              return <Input className={styles.control} aria-label="Text" maxLength={255} value={row.description} onChange={(e) => setRow(row.id, { description: e.target.value })} />;
            case "actions":
              return (
                <Button type="button" variant="ghost" size="small" onClick={() => update(rows.filter((r) => r.id !== row.id))}>
                  Ta bort
                </Button>
              );
            default:
              return null;
          }
        }}
      />
      <FormHint>{reversalText}</FormHint>
      {closing.nextFiscalYear?.firstPeriodStatus === "locked" && (
        <FormNotice>
          Första perioden i {closing.nextFiscalYear.label} är låst — återföringen {closing.nextFiscalYear.startDate} kan inte bokföras. Lås upp
          perioden under Räkenskapsår innan du bokför periodiseringarna.
        </FormNotice>
      )}
      <PostingTable rows={preview} empty="Ingen kontering att visa." />
      <FormError>{action.error}</FormError>
      {action.notice && <FormHint>{action.notice}</FormHint>}
      <FormActions className={styles.actions}>
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            update([
              ...rows,
              {
                id: `new-${++newRowSeq}`,
                kind: "prepaid_expense",
                balanceAccountId: idForNumber(DEFAULT_BALANCE_ACCOUNT.prepaid_expense),
                resultAccountId: "",
                amount: "",
                description: "",
              },
            ])
          }
        >
          Lägg till rad
        </Button>
        <Button type="button" disabled={action.pending || blocked || rows.length === 0 || complete.length !== rows.length} onClick={() => book(rows)}>
          Bokför periodiseringar
        </Button>
        <Button type="button" variant="secondary" disabled={action.pending || blocked} onClick={() => book([])}>
          Inga periodiseringar
        </Button>
      </FormActions>
    </Card>
  );
}

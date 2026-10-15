"use client";

import { confirmDialog } from "../../../lib/confirm";
import { useState, type FormEvent } from "react";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Field, Input, Textarea } from "../../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../../ui/Form";
import { Modal } from "../../ui/Modal";
import { SectionHeading } from "../../ui/SectionHeading";
import { StatusPill } from "../../ui/StatusPill";
import { apiFetch } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import type { ProfitDispositionPreview, YearEndClosingDetail } from "../../../lib/types";
import { PostingTable, VerificationLink } from "./StepCards";
import { useStepAction } from "./useStepAction";
import styles from "./Bokslut.module.css";

function stockholmDate(timestamp: string | null): string {
  return timestamp ? new Date(timestamp).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }) : "";
}

export function ClosedYearPanel({ closing }: { closing: YearEndClosingDetail }) {
  const { steps } = closing;
  return (
    <>
      <Card maxWidth="none">
        <SectionHeading actions={<StatusPill status="done" label="Stängt" compact />}>Räkenskapsåret {closing.fiscalYear.label}</SectionHeading>
        <p>
          Stängt {stockholmDate(closing.fiscalYear.closedAt)} · Bokslutsdatum {closing.closingDate}
        </p>
        <p>
          Lagerförändring: <VerificationLink verification={steps.inventory.verification} />
          {!steps.inventory.verification && "inget verifikat"} · Periodiseringar: <VerificationLink verification={steps.accruals.verification} />
          {!steps.accruals.verification && "inga"} · Resultatöverföring: <VerificationLink verification={steps.resultTransfer.verification} />
          {!steps.resultTransfer.verification && "inget verifikat"}
        </p>
      </Card>
      <ProfitDispositionCard closing={closing} />
      <ReopenCard closing={closing} />
    </>
  );
}

function ProfitDispositionCard({ closing }: { closing: YearEndClosingDetail }) {
  const disposition = closing.profitDisposition;
  const [agmDate, setAgmDate] = useState("");
  const [dividend, setDividend] = useState("0");
  const [preview, setPreview] = useState<ProfitDispositionPreview | null>(null);
  const action = useStepAction();
  const base = `/api/v1/year-end-closings/${closing.id}`;

  if (disposition) {
    return (
      <Card maxWidth="none">
        <SectionHeading>Vinstdisposition</SectionHeading>
        <p>
          Stämma {disposition.agmDate} · Disponerat {formatMoney(disposition.resultAmount)} · Utdelning {formatMoney(disposition.dividendAmount)}{" "}
          <VerificationLink verification={disposition.verification} />
        </p>
        <FormError>{action.error}</FormError>
        <FormActions className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            disabled={action.pending}
            onClick={async () => {
              if (!(await confirmDialog("Vinstdispositionen omförs på stämmodatumet. Fortsätt?"))) return;
              void action.run(async () => {
                await apiFetch(`${base}/profit-disposition/undo`, { method: "POST" });
                return null;
              });
            }}
          >
            Ångra
          </Button>
        </FormActions>
      </Card>
    );
  }

  return (
    <Card maxWidth="none">
      <SectionHeading>Vinstdisposition</SectionHeading>
      <FormHint>Bokför årsstämmans beslut: årets resultat från 2099 till 2091, och eventuell utdelning till 2898.</FormHint>
      <Field label="Stämmodatum" htmlFor="agmDate">
        <Input id="agmDate" type="date" value={agmDate} onChange={(e) => { setAgmDate(e.target.value); setPreview(null); }} />
      </Field>
      <Field label="Utdelning (kr)" htmlFor="dividend">
        <Input id="dividend" type="number" min="0" step="0.01" value={dividend} onChange={(e) => { setDividend(e.target.value); setPreview(null); }} />
      </Field>
      {preview && (
        <>
          {preview.warnings.map((warning) => (
            <FormNotice key={warning}>{warning}</FormNotice>
          ))}
          <PostingTable rows={preview.rows} empty="Inget att bokföra." />
        </>
      )}
      <FormError>{action.error}</FormError>
      {action.notice && <FormHint>{action.notice}</FormHint>}
      <FormActions className={styles.actions}>
        <Button
          type="button"
          variant="ghost"
          disabled={action.pending || agmDate === ""}
          onClick={() =>
            action.run(async () => {
              setPreview(
                await apiFetch<ProfitDispositionPreview>(
                  `${base}/profit-disposition-preview?agmDate=${agmDate}&dividendAmount=${Number(dividend) || 0}`
                )
              );
              return null;
            }, false)
          }
        >
          Visa kontering
        </Button>
        <Button
          type="button"
          disabled={action.pending || agmDate === ""}
          onClick={() =>
            action.run(async () => {
              const result = await apiFetch<{ verification: { displayNumber: string } }>(`${base}/profit-disposition`, {
                method: "POST",
                body: JSON.stringify({ agmDate, dividendAmount: Number(dividend) || 0 }),
              });
              return `Vinstdisposition bokförd — Verifikat ${result.verification.displayNumber}`;
            })
          }
        >
          Bokför vinstdisposition
        </Button>
      </FormActions>
    </Card>
  );
}

function ReopenCard({ closing }: { closing: YearEndClosingDetail }) {
  const [open, setOpen] = useState(false);
  // The API refuses a reopen while a profit disposition is booked.
  const dispositionActive = closing.profitDisposition !== null;
  return (
    <Card maxWidth="none">
      <SectionHeading>Öppna året igen</SectionHeading>
      <FormHint>Resultatöverföringen omförs och bokslutsmånaden låses upp. Lagerförändring, avskrivningar och periodiseringar ligger kvar.</FormHint>
      {dispositionActive && <FormHint>Vinstdispositionen är bokförd — ångra den först för att kunna öppna året igen.</FormHint>}
      <FormActions className={styles.actions}>
        <Button type="button" variant="danger" disabled={dispositionActive} onClick={() => setOpen(true)}>
          Öppna året igen
        </Button>
      </FormActions>
      <Modal open={open} onClose={() => setOpen(false)} title={`Öppna ${closing.fiscalYear.label} igen`}>
        {open && <ReopenForm key={closing.id} closingId={closing.id} onDone={() => setOpen(false)} />}
      </Modal>
    </Card>
  );
}

function ReopenForm({ closingId, onDone }: { closingId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const action = useStepAction();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      await apiFetch(`/api/v1/year-end-closings/${closingId}/reopen`, { method: "POST", body: JSON.stringify({ reason }) });
      onDone();
      return null;
    });
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{action.error}</FormError>
      <FormHint>Motiveringen sparas i händelseloggen tillsammans med vem som öppnade året.</FormHint>
      <Field label="Motivering" htmlFor="reopenReason">
        <Textarea id="reopenReason" required minLength={5} maxLength={255} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <FormActions className={styles.actions}>
        <Button type="submit" variant="danger" disabled={action.pending || reason.trim().length < 5}>
          Öppna året igen
        </Button>
      </FormActions>
    </Form>
  );
}

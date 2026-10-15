"use client";

import { confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch, ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { MONTH_NAMES_SV, type AccountingPeriod, type FiscalYear, type FiscalYearDetail } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { UnlockPeriodForm } from "./UnlockPeriodForm";

// Next 1 Jan – 31 Dec, prefilled in the create form: brutna räkenskapsår are
// supported by the API (arbitrary start/end), but the common case is a
// calendar year, and the next one (not the current) is what a bookkeeper
// sets up ahead of time.
function nextCalendarYearBounds(): { label: string; start: string; end: string } {
  const year = new Date().getFullYear() + 1;
  return { label: String(year), start: `${year}-01-01`, end: `${year}-12-31` };
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("sv-SE");
}

// "2026-01" -> "Januari 2026" — same capitalize-the-lowercase-name idiom as
// the attestering/löneunderlag pages' monthLabel.
function monthLabel(startDate: string): string {
  const [year, month] = startDate.split("-");
  const name = MONTH_NAMES_SV[Number(month) - 1] ?? "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

function formatFiscalYearError(err: unknown): string {
  // A zod-refine failure (endDate must be after startDate) is not a named
  // domain error: app.ts answers every ZodError with the same
  // { error: "Validation failed", code: "validation-failed", issues } body,
  // so ApiError.message is always "Validation failed" and the refine text
  // only ever appears inside `issues`. Read it there — matching on the
  // message would never fire.
  if (err instanceof ApiError) {
    const issues = (err.body as { issues?: { message?: string }[] } | undefined)?.issues;
    if (issues?.some((issue) => issue.message?.includes("endDate must be after"))) {
      return "Slutdatumet måste vara efter startdatumet";
    }
  }
  return apiErrorMessage(err, "Kunde inte skapa räkenskapsåret");
}

export function RakenskapsarPageClient({ fiscalYears }: { fiscalYears: FiscalYear[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Räkenskapsår</div>
          <div className={shellStyles.meta}>{fiscalYears.length} räkenskapsår</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Nytt räkenskapsår
          </Button>
          <HelpLink chapter="ekonomi" anchor="rakenskapsar-och-perioder" label="Hjälp om räkenskapsår" />
        </div>
      </div>

      {fiscalYears.length === 0 ? (
        <p>Inga räkenskapsår registrerade än.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {fiscalYears.map((year) => (
            <FiscalYearCard key={year.id} year={year} />
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt räkenskapsår">
        <NewFiscalYearForm
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

function NewFiscalYearForm({ onDone }: { onDone: () => void }) {
  const defaults = nextCalendarYearBounds();
  const [label, setLabel] = useState(defaults.label);
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/fiscal-years", { method: "POST", body: JSON.stringify({ label, startDate, endDate }) });
      onDone();
    } catch (err) {
      setError(formatFiscalYearError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Namn" htmlFor="fiscalYearLabel">
        <Input id="fiscalYearLabel" required maxLength={20} size="md" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>

      <FormRow>
        <Field label="Startdatum" htmlFor="fiscalYearStart">
          <Input
            id="fiscalYearStart"
            type="date"
            required
            size="sm"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <Field label="Slutdatum" htmlFor="fiscalYearEnd">
          <Input id="fiscalYearEnd" type="date" required size="sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
      </FormRow>
      <FormHint>Systemet skapar automatiskt en period per kalendermånad inom intervallet.</FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa räkenskapsår"}
        </Button>
      </FormActions>
    </Form>
  );
}

function FiscalYearCard({ year }: { year: FiscalYear }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<FiscalYearDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingPeriodId, setPendingPeriodId] = useState<string | null>(null);
  const [unlockPeriod, setUnlockPeriod] = useState<AccountingPeriod | null>(null);

  async function loadDetail() {
    setLoading(true);
    setFetchError(null);
    try {
      setDetail(await apiFetch<FiscalYearDetail>(`/api/v1/fiscal-years/${year.id}`));
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Kunde inte hämta perioder");
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (!expanded && !detail) await loadDetail();
    setExpanded((current) => !current);
  }

  async function lockPeriod(period: AccountingPeriod) {
    const label = monthLabel(period.startDate);
    const confirmed = await confirmDialog(
      `Låser ${label} — bokföring på datum i perioden blockeras, men utkast går fortfarande att skapa och redigera. Fortsätt?`
    );
    if (!confirmed) return;
    setActionError(null);
    setPendingPeriodId(period.id);
    try {
      await apiFetch(`/api/v1/accounting-periods/${period.id}/lock`, { method: "POST" });
      await loadDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Kunde inte låsa perioden");
    } finally {
      setPendingPeriodId(null);
    }
  }

  return (
    <Card maxWidth="none">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <strong style={{ fontSize: 16 }}>{year.label}</strong>{" "}
          {year.status === "closed" && <StatusPill status="done" label="Stängt" compact />}{" "}
          <Link href={`/ekonomi/bokslut?fiscalYearId=${year.id}`}>Bokslut</Link>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--color-text-secondary)" }}>
            {formatDate(year.startDate)} – {formatDate(year.endDate)} · {year.periodCount} perioder
          </div>
        </div>
        <Button type="button" variant="ghost" size="small" disabled={loading} onClick={toggle}>
          {loading ? "Hämtar…" : expanded ? "Dölj perioder" : "Visa perioder"}
        </Button>
      </div>

      {expanded && (
        <div style={{ marginTop: 16 }}>
          <FormError margin="below">{fetchError ?? actionError}</FormError>
          {detail && (
            <Table<AccountingPeriod>
              columns={[
                { key: "month", label: "Månad", width: "1fr" },
                { key: "status", label: "Status", width: "140px" },
                { key: "action", label: "", width: "170px", align: "right" },
              ]}
              rows={detail.periods}
              renderCell={(period, key) => {
                switch (key) {
                  case "month":
                    return monthLabel(period.startDate);
                  case "status":
                    return period.status === "locked" ? (
                      <StatusPill status="stopped" label="Låst" compact />
                    ) : (
                      <StatusPill status="running" label="Öppen" compact />
                    );
                  case "action":
                    if (year.status === "closed") {
                      return <span style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Året är stängt</span>;
                    }
                    return period.status === "locked" ? (
                      <Button type="button" variant="danger" size="small" onClick={() => setUnlockPeriod(period)}>
                        Lås upp period
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={pendingPeriodId === period.id}
                        onClick={() => lockPeriod(period)}
                      >
                        {pendingPeriodId === period.id ? "Låser…" : "Lås period"}
                      </Button>
                    );
                  default:
                    return null;
                }
              }}
            />
          )}
        </div>
      )}

      <Modal
        open={unlockPeriod !== null}
        onClose={() => setUnlockPeriod(null)}
        title={unlockPeriod ? `Lås upp ${monthLabel(unlockPeriod.startDate)}` : ""}
      >
        {unlockPeriod && (
          <UnlockPeriodForm
            periodId={unlockPeriod.id}
            onDone={() => {
              setUnlockPeriod(null);
              loadDetail();
            }}
          />
        )}
      </Modal>
    </Card>
  );
}

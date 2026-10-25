"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { FormError } from "../ui/Form";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { confirmDelete } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type { BudgetCopyResult, BudgetDetail, BudgetSummary, FiscalYear } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

// Ekonomi → Budget: the budgets of one fiscal year.
export function BudgetListPageClient({
  fiscalYears,
  fiscalYearId,
  budgets,
}: {
  fiscalYears: FiscalYear[];
  fiscalYearId: string;
  budgets: BudgetSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copying, setCopying] = useState<BudgetSummary | null>(null);

  async function makeDefault(budget: BudgetSummary) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/budgets/${budget.id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte göras förvald"));
    } finally {
      setPending(false);
    }
  }

  async function remove(budget: BudgetSummary) {
    if (!(await confirmDelete(`Ta bort budgeten ${budget.name}? Alla budgetrader tas bort.`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/budgets/${budget.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte tas bort"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Budget</div>
          <div className={shellStyles.meta}>Planerade intäkter och kostnader per månad och konto</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" disabled={fiscalYears.length === 0} onClick={() => setCreating(true)}>
            + Ny budget
          </Button>
          <HelpLink chapter="ekonomi" anchor="budget" label="Hjälp om budget" />
        </div>
      </div>

      {fiscalYears.length === 0 ? (
        <p>
          Det finns inget räkenskapsår än — lägg upp ett under <Link href="/ekonomi/rakenskapsar">Räkenskapsår</Link> först.
        </p>
      ) : (
        <>
          <div style={{ maxWidth: 280, marginBottom: 16 }}>
            <Field label="Räkenskapsår" htmlFor="budgetYear">
              <Select
                id="budgetYear"
                value={fiscalYearId}
                onChange={(e) => router.push(`${pathname}?fiscalYearId=${e.target.value}`)}
              >
                {fiscalYears.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <FormError>{error}</FormError>

          <Table<BudgetSummary>
            columns={[
              { key: "name", label: "Namn", width: "1.4fr" },
              { key: "isDefault", label: "Förvald", width: "100px" },
              { key: "revenue", label: "Intäkter", width: "130px", align: "right" },
              { key: "costs", label: "Kostnader", width: "130px", align: "right" },
              { key: "result", label: "Resultat", width: "130px", align: "right" },
              { key: "id", label: "", width: "290px", align: "right" },
            ]}
            rows={budgets}
            emptyText="Det finns inga budgetar för räkenskapsåret än"
            renderCell={(b, key) => {
              switch (key) {
                case "name":
                  return <Link href={`/ekonomi/budget/${b.id}`}>{b.name}</Link>;
                case "isDefault":
                  return b.isDefault ? <StatusPill status="running" label="Förvald" compact /> : "";
                case "revenue":
                  return <span className="num">{formatMoney(b.revenue)}</span>;
                case "costs":
                  return <span className="num">{formatMoney(b.costs)}</span>;
                case "result":
                  return <span className="num">{formatMoney(b.result)}</span>;
                case "id":
                  return (
                    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {!b.isDefault && (
                        <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void makeDefault(b)}>
                          Gör förvald
                        </Button>
                      )}
                      <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => setCopying(b)}>
                        Kopiera budget
                      </Button>
                      <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => void remove(b)}>
                        Ta bort
                      </Button>
                    </span>
                  );
                default:
                  return null;
              }
            }}
          />
        </>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Ny budget">
        <NewBudgetForm
          fiscalYears={fiscalYears}
          defaultYearId={fiscalYearId}
          onCancel={() => setCreating(false)}
          onDone={(id) => router.push(`/ekonomi/budget/${id}`)}
        />
      </Modal>

      <Modal open={copying !== null} onClose={() => setCopying(null)} title="Kopiera budget">
        {copying && (
          <CopyBudgetForm
            source={copying}
            fiscalYears={fiscalYears}
            onCancel={() => setCopying(null)}
            onDone={(id, dropped) => router.push(`/ekonomi/budget/${id}${dropped > 0 ? `?dropped=${dropped}` : ""}`)}
          />
        )}
      </Modal>
    </>
  );
}

function NewBudgetForm({
  fiscalYears,
  defaultYearId,
  onCancel,
  onDone,
}: {
  fiscalYears: FiscalYear[];
  defaultYearId: string;
  onCancel: () => void;
  onDone: (id: string) => void;
}) {
  const [yearId, setYearId] = useState(defaultYearId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (name.trim() === "") return setError("Ange ett namn.");
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<BudgetDetail>("/api/v1/budgets", {
        method: "POST",
        body: JSON.stringify({ fiscalYearId: yearId, name: name.trim() }),
      });
      onDone(created.id);
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte skapas"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <FormError>{error}</FormError>
      <Field label="Räkenskapsår" htmlFor="newBudgetYear">
        <Select id="newBudgetYear" value={yearId} onChange={(e) => setYearId(e.target.value)}>
          {fiscalYears.map((y) => (
            <option key={y.id} value={y.id}>
              {y.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Namn" htmlFor="newBudgetName">
        <Input id="newBudgetName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa budget"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </form>
  );
}

function CopyBudgetForm({
  source,
  fiscalYears,
  onCancel,
  onDone,
}: {
  source: BudgetSummary;
  fiscalYears: FiscalYear[];
  onCancel: () => void;
  onDone: (id: string, dropped: number) => void;
}) {
  const [yearId, setYearId] = useState(source.fiscalYearId);
  const [name, setName] = useState(`${source.name} (kopia)`.slice(0, 100));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (name.trim() === "") return setError("Ange ett namn.");
    setError(null);
    setPending(true);
    try {
      const copy = await apiFetch<BudgetCopyResult>(`/api/v1/budgets/${source.id}/copy`, {
        method: "POST",
        body: JSON.stringify({ fiscalYearId: yearId, name: name.trim() }),
      });
      onDone(copy.id, copy.droppedMonths ?? 0);
    } catch (err) {
      setError(apiErrorMessage(err, "Budgeten kunde inte kopieras"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <FormError>{error}</FormError>
      <Field label="Räkenskapsår" htmlFor="copyBudgetYear">
        <Select id="copyBudgetYear" value={yearId} onChange={(e) => setYearId(e.target.value)}>
          {fiscalYears.map((y) => (
            <option key={y.id} value={y.id}>
              {y.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Namn" htmlFor="copyBudgetName">
        <Input id="copyBudgetName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Kopierar…" : "Kopiera"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </form>
  );
}

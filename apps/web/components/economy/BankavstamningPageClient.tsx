"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { useListNavigation } from "../ui/ListControls";
import { SectionHeading } from "../ui/SectionHeading";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { Table } from "../ui/Table";
import { ApiError, apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { BANK_MATCH_KIND_LABELS, isIsoDate, sumAmounts } from "../../lib/bankReconciliation";
import { formatMoney, round2 } from "../../lib/format";
import type {
  Account,
  BankAccount,
  BankBookByRuleResult,
  BankLedgerRow,
  BankMatch,
  BankMatchProposal,
  BankReconciliationRecord,
  BankReconciliationView,
  BankStatementEntry,
  BankStatementImportResult,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import styles from "./Bankavstamning.module.css";
import { BankBookDialog, type BookedEntry } from "./BankBookDialog";
import { BankImportDialog } from "./BankImportDialog";

const BASIS_LABELS = { reference: "referens", amount_date: "belopp och datum" } as const;

function toggled(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

// Ekonomi → Bankavstämning: the kontoutdrag against the ledger account of one
// bank account for a period. Posts on the statement and rows in the ledger
// are matched to each other (sums must be equal); what is left over is the
// explanation of the difference between the two balances.
export function BankavstamningPageClient({
  bankAccounts,
  selectedId,
  view,
  viewError,
  from,
  to,
  accounts,
}: {
  bankAccounts: BankAccount[];
  selectedId: string | null;
  view: BankReconciliationView | null;
  viewError: string | null;
  from: string;
  to: string;
  accounts: Account[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const nav = useListNavigation();

  const [selEntries, setSelEntries] = useState<Set<string>>(new Set());
  const [selRows, setSelRows] = useState<Set<string>>(new Set());
  const [fromInput, setFromInput] = useState(from);
  const [toInput, setToInput] = useState(to);
  const [reconcileDate, setReconcileDate] = useState("");
  const [notice, setNotice] = useState<ReactNode>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bookEntry, setBookEntry] = useState<BankStatementEntry | null>(null);

  useEffect(() => setFromInput(from), [from]);
  useEffect(() => setToInput(to), [to]);
  // A fresh answer from the server (after refresh or another account/period):
  // the old selection may point at rows that are gone.
  useEffect(() => {
    setSelEntries(new Set());
    setSelRows(new Set());
    setReconcileDate(view ? (view.summary.statementBalanceDate ?? view.to) : "");
  }, [view]);

  const entries = view?.statementEntries ?? [];
  const rows = view?.ledgerRows ?? [];

  const proposalByEntry = useMemo(() => {
    const map = new Map<string, BankMatchProposal>();
    for (const p of view?.proposals ?? []) for (const id of p.entryIds) if (!map.has(id)) map.set(id, p);
    return map;
  }, [view]);
  const proposalByRow = useMemo(() => {
    const map = new Map<string, BankMatchProposal>();
    for (const p of view?.proposals ?? []) for (const id of p.rowIds) if (!map.has(id)) map.set(id, p);
    return map;
  }, [view]);

  const chosenEntries = entries.filter((e) => selEntries.has(e.id));
  const chosenRows = rows.filter((r) => selRows.has(r.id));
  const entriesSum = sumAmounts(chosenEntries);
  const rowsSum = sumAmounts(chosenRows);
  // The sums must be equal; one side may be empty — a reversal netted against
  // its original (entries only) or two rows cancelling each other (rows only)
  // is a matching too, as long as the chosen side sums to 0.
  const canMatch = chosenEntries.length + chosenRows.length > 0 && round2(entriesSum - rowsSum) === 0;
  const ruleEntries = chosenEntries.filter((e) => e.ruleSuggestion !== null);

  async function run(action: () => Promise<void>, fallback: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setFailures([]);
    try {
      await action();
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
    } finally {
      setPending(false);
    }
  }

  function changeAccount(id: string) {
    void nav.setFilter("account", id || null);
  }

  function changeDate(key: "from" | "to", value: string) {
    if (key === "from") setFromInput(value);
    else setToInput(value);
    if (isIsoDate(value)) void nav.setFilter(key, value);
  }

  function selectProposal(p: BankMatchProposal) {
    setSelEntries(new Set(p.entryIds));
    setSelRows(new Set(p.rowIds));
  }

  function match() {
    if (!view || !canMatch) return;
    void run(async () => {
      await apiFetch<BankMatch>("/api/v1/bank-matches", {
        method: "POST",
        body: JSON.stringify({
          bankAccountId: view.bankAccount.id,
          entryIds: chosenEntries.map((e) => e.id),
          verificationRowIds: chosenRows.map((r) => r.id),
        }),
      });
      const posts = `${chosenEntries.length} ${chosenEntries.length === 1 ? "post" : "poster"}`;
      const lines = `${chosenRows.length} ${chosenRows.length === 1 ? "rad" : "rader"}`;
      setNotice(
        chosenRows.length === 0
          ? `${posts} på kontoutdraget nettades mot varandra.`
          : chosenEntries.length === 0
            ? `${lines} i bokföringen nettades mot varandra.`
            : `${posts} matchades mot ${lines}.`
      );
      router.refresh();
    }, "Matchningen misslyckades");
  }

  function autoMatch() {
    if (!view) return;
    void run(async () => {
      const result = await apiFetch<{ matched: number; ambiguous: number }>("/api/v1/bank-matches/auto", {
        method: "POST",
        body: JSON.stringify({ bankAccountId: view.bankAccount.id, from: view.from, to: view.to }),
      });
      setNotice(
        `${result.matched} ${result.matched === 1 ? "matchning gjordes" : "matchningar gjordes"} automatiskt.` +
          (result.ambiguous > 0 ? ` ${result.ambiguous} ${result.ambiguous === 1 ? "post har" : "poster har"} flera möjliga rader och lämnades till dig.` : "")
      );
      router.refresh();
    }, "Den automatiska matchningen misslyckades");
  }

  async function undo(m: BankMatch) {
    const ok = await confirmDialog(
      `Ångra matchningen av ${m.entries.length} ${m.entries.length === 1 ? "post" : "poster"} och ${m.rows.length} ${m.rows.length === 1 ? "rad" : "rader"}? Posterna och raderna blir omatchade igen${m.kind === "created" ? " — verifikatet som bokfördes från posten ligger kvar" : ""}.`,
      { confirmLabel: "Ångra matchningen", danger: true }
    );
    if (!ok) return;
    void run(async () => {
      await apiFetch<BankMatch>(`/api/v1/bank-matches/${m.id}/undo`, { method: "POST" });
      setNotice("Matchningen ångrades.");
      router.refresh();
    }, "Matchningen kunde inte ångras");
  }

  async function bookByRule() {
    if (ruleEntries.length === 0) return;
    const ok = await confirmDialog(
      `Bokför ${ruleEntries.length} ${ruleEntries.length === 1 ? "post" : "poster"} enligt bankreglerna? Ett verifikat skapas per post.`,
      { confirmLabel: "Bokför" }
    );
    if (!ok) return;
    void run(async () => {
      const result = await apiFetch<BankBookByRuleResult>("/api/v1/bank-statement-entries/book-by-rule", {
        method: "POST",
        body: JSON.stringify({ entryIds: ruleEntries.map((e) => e.id) }),
      });
      setNotice(
        `${result.booked.length} ${result.booked.length === 1 ? "post bokfördes" : "poster bokfördes"} enligt regel` +
          (result.booked.length > 0 ? `: ${result.booked.map((b) => b.displayNumber).join(", ")}.` : ".")
      );
      // Each failure carries the API's error envelope — translate it like a
      // 4xx answer.
      setFailures(
        result.failed.map(
          (f) =>
            `${entries.find((e) => e.id === f.entryId)?.text ?? f.entryId}: ${apiErrorMessage(new ApiError(f.error.error, 409, f.error.code, f.error), "Posten kunde inte bokföras")}`
        )
      );
      router.refresh();
    }, "Posterna kunde inte bokföras");
  }

  async function reconcile() {
    if (!view) return;
    if (!isIsoDate(reconcileDate)) return setError("Ange ett datum.");
    const ok = await confirmDialog(
      `Markera ${view.bankAccount.name} som avstämd t.o.m. ${reconcileDate}?`,
      { confirmLabel: "Markera som avstämd" }
    );
    if (!ok) return;
    void run(async () => {
      await apiFetch<BankReconciliationRecord>("/api/v1/bank-reconciliations", {
        method: "POST",
        body: JSON.stringify({ bankAccountId: view.bankAccount.id, throughDate: reconcileDate }),
      });
      setNotice(`${view.bankAccount.name} är avstämt t.o.m. ${reconcileDate}.`);
      router.refresh();
    }, "Avstämningen kunde inte sparas");
  }

  function booked(entry: BankStatementEntry, result: BookedEntry) {
    setBookEntry(null);
    setError(null);
    setFailures([]);
    setNotice(
      <>
        Verifikat <Link href={`/ekonomi/verifikat/${result.verification.id}`}>{result.verification.displayNumber}</Link> bokfördes och
        matchades mot posten {entry.text}.
      </>
    );
    router.refresh();
  }

  function imported(result: BankStatementImportResult) {
    setImportOpen(false);
    setError(null);
    setFailures([]);
    const lines = [
      `${result.imported} ${result.imported === 1 ? "post importerades" : "poster importerades"}` +
        (result.duplicates > 0 ? `, ${result.duplicates} ${result.duplicates === 1 ? "dubblett hoppades" : "dubbletter hoppades"} över.` : "."),
    ];
    if (result.autoMatched > 0) lines.push(`${result.autoMatched} matchades automatiskt.`);
    if (result.autoBooked > 0) lines.push(`${result.autoBooked} bokfördes direkt enligt bankregler.`);
    lines.push(...result.warnings);
    setNotice(
      <>
        {lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </>
    );
    // Show the account and period the statement covers.
    const statement = result.statements[0];
    const params = new URLSearchParams();
    const account = statement?.bankAccountId ?? selectedId;
    if (account) params.set("account", account);
    const newFrom = statement?.from && statement.from < from ? statement.from : from;
    const newTo = statement?.to && statement.to > to ? statement.to : to;
    params.set("from", newFrom);
    params.set("to", newTo);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    router.refresh();
  }

  const bankAccount = view?.bankAccount ?? null;
  const summary = view?.summary ?? null;
  // The day the summary is measured on: the latest statement balance on or
  // before Till (else Till itself) — the ledger balance and the unmatched
  // sums are taken through that day, not just within the period.
  const balanceDate = summary?.statementBalanceDate ?? view?.to ?? to;
  const activeAccounts = bankAccounts.filter((a) => a.active || a.id === selectedId);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Bankavstämning</div>
          <div className={shellStyles.meta}>
            {bankAccount ? `${bankAccount.name} · konto ${bankAccount.ledgerAccount} · ${from} – ${to}` : "Matcha kontoutdraget mot bokföringen"}
          </div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" disabled={pending || bankAccounts.length === 0} onClick={() => setImportOpen(true)}>
            Importera kontoutdrag
          </Button>
          <Button type="button" variant="secondary" disabled={pending || !view} onClick={autoMatch}>
            Matcha automatiskt
          </Button>
          <HelpLink chapter="ekonomi" anchor="bankavstamning" label="Hjälp om bankavstämning" />
        </div>
      </div>

      {bankAccounts.length === 0 ? (
        <FormNotice>
          Det finns inget bankkonto än. Lägg upp ett under <Link href="/ekonomi/bankkonton">Bankkonton</Link> först.
        </FormNotice>
      ) : (
        <div className={styles.controls}>
          <div className={styles.controlAccount}>
            <Field label="Bankkonto" htmlFor="bankReconAccount">
              <Select id="bankReconAccount" value={selectedId ?? ""} onChange={(e) => changeAccount(e.target.value)}>
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.ledgerAccount}
                    {a.unmatchedCount > 0 ? ` (${a.unmatchedCount} omatchade)` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Från" htmlFor="bankReconFrom">
            <Input id="bankReconFrom" type="date" size="sm" value={fromInput} onChange={(e) => changeDate("from", e.target.value)} />
          </Field>
          <Field label="Till" htmlFor="bankReconTo">
            <Input id="bankReconTo" type="date" size="sm" value={toInput} onChange={(e) => changeDate("to", e.target.value)} />
          </Field>
        </div>
      )}

      <FormError>{viewError}</FormError>
      <FormError>{error}</FormError>
      {failures.length > 0 && (
        <FormError>
          {failures.map((f) => (
            <div key={f}>{f}</div>
          ))}
        </FormError>
      )}
      {notice && <FormNotice>{notice}</FormNotice>}
      {view?.changedAfterReconciliation && (
        <FormNotice>
          Bokföringen har ändrats efter avstämningen {view.changedAfterReconciliation.through}:{" "}
          {view.changedAfterReconciliation.rows} {view.changedAfterReconciliation.rows === 1 ? "rad" : "rader"} på bankkontot med
          datum t.o.m. den dagen har tillkommit. Kontrollera och stäm av igen.
        </FormNotice>
      )}

      {view && bankAccount && summary && (
        <>
          <div className={styles.summary}>
            <Tile
              label="Saldo enligt kontoutdraget"
              value={summary.statementBalance === null ? "Saknas" : `${formatMoney(summary.statementBalance)} kr`}
              sub={summary.statementBalanceDate ? `per ${summary.statementBalanceDate}` : "Importera ett kontoutdrag"}
            />
            <Tile
              label="Saldo i bokföringen"
              value={`${formatMoney(summary.ledgerBalance)} kr`}
              sub={`konto ${bankAccount.ledgerAccount} per ${balanceDate}`}
            />
            <Tile
              label="Omatchade poster"
              value={`${formatMoney(summary.unmatchedEntriesSum)} kr`}
              sub={`t.o.m. ${balanceDate} · ${entries.length} ${entries.length === 1 ? "post" : "poster"} i perioden`}
            />
            <Tile
              label="Omatchade rader"
              value={`${formatMoney(summary.unmatchedRowsSum)} kr`}
              sub={`t.o.m. ${balanceDate} · ${rows.length} ${rows.length === 1 ? "rad" : "rader"} i perioden`}
            />
            <Tile
              label="Skillnad"
              value={summary.difference === null ? "–" : `${formatMoney(summary.difference)} kr`}
              sub={`kontoutdraget minus bokföringen per ${balanceDate}`}
            />
          </div>
          {summary.difference === null ? (
            <div className={`${styles.verdict} ${styles.verdictNeutral}`}>
              Det finns inget kontoutdragssaldo till och med {view.to}. Importera kontoutdraget så kan saldona jämföras.
            </div>
          ) : summary.explained ? (
            <div className={`${styles.verdict} ${styles.verdictOk}`}>
              Skillnaden per {balanceDate} är förklarad: den motsvarar de omatchade posterna minus de omatchade raderna till och med den
              dagen ({formatMoney(round2(summary.unmatchedEntriesSum - summary.unmatchedRowsSum))} kr).
            </div>
          ) : (
            <div className={`${styles.verdict} ${styles.verdictBad}`}>
              Avvikelse per {balanceDate}: skillnaden på {formatMoney(summary.difference)} kr förklaras inte av de omatchade posterna
              och raderna till och med den dagen ({formatMoney(round2(summary.unmatchedEntriesSum - summary.unmatchedRowsSum))} kr). Det
              beror oftast på att ett kontoutdrag saknas för en del av perioden, eller att något har ändrats efter importen.
            </div>
          )}

          <div className={styles.matchBar} role="group" aria-label="Markerat">
            <div className={styles.matchBarSums}>
              <span>
                Markerade poster: {chosenEntries.length} · {formatMoney(entriesSum)} kr
              </span>
              <span>
                Markerade rader: {chosenRows.length} · {formatMoney(rowsSum)} kr
              </span>
              <span className={round2(entriesSum - rowsSum) === 0 ? styles.balanced : styles.differs}>
                Skillnad: {formatMoney(round2(entriesSum - rowsSum))} kr
              </span>
            </div>
            <div className={styles.listActions}>
              <Button type="button" variant="primary" disabled={pending || !canMatch} onClick={match}>
                Matcha
              </Button>
              <Button type="button" variant="secondary" disabled={pending || ruleEntries.length === 0} onClick={() => void bookByRule()}>
                Bokför enligt regel{ruleEntries.length > 0 ? ` (${ruleEntries.length})` : ""}
              </Button>
            </div>
          </div>

          <SectionHeading>Omatchade poster på kontoutdraget</SectionHeading>
          <Table<BankStatementEntry>
            columns={[
              {
                key: "sel",
                label: "Markera",
                width: "28px",
                header: (
                  <SelectAllCheckbox
                    ariaLabel="Markera alla poster"
                    checked={entries.length > 0 && selEntries.size === entries.length}
                    indeterminate={selEntries.size > 0 && selEntries.size < entries.length}
                    disabled={entries.length === 0}
                    onChange={(on) => setSelEntries(on ? new Set(entries.map((e) => e.id)) : new Set())}
                  />
                ),
              },
              { key: "date", label: "Datum", width: "100px" },
              { key: "text", label: "Text", width: "1.8fr" },
              { key: "amount", label: "Belopp", width: "110px", align: "right" },
              { key: "id", label: "", width: "170px", align: "right" },
            ]}
            rows={entries}
            emptyText="Inga omatchade poster — allt på kontoutdraget är matchat"
            renderCell={(entry, key) => {
              switch (key) {
                case "sel":
                  return (
                    <Checkbox
                      checked={selEntries.has(entry.id)}
                      aria-label={`Markera posten ${entry.text}`}
                      onChange={(e) => setSelEntries((s) => toggled(s, entry.id, e.target.checked))}
                    />
                  );
                case "date":
                  return entry.bookingDate;
                case "text": {
                  const proposal = proposalByEntry.get(entry.id);
                  return (
                    <>
                      {entry.text}
                      {entry.reversal && <span className={`${styles.badge} ${styles.badgeRule}`}>Återföring</span>}
                      {proposal && <ProposalBadge proposal={proposal} />}
                      {(entry.counterparty || entry.reference) && (
                        <span className={styles.sub}>{[entry.counterparty, entry.reference].filter(Boolean).join(" · ")}</span>
                      )}
                      {entry.ruleSuggestion && (
                        <span className={styles.sub}>
                          Regel: konto {entry.ruleSuggestion.accountNumber}
                          {entry.ruleSuggestion.vatCode ? ` · ${entry.ruleSuggestion.vatCode}` : ""}
                          {entry.ruleSuggestion.description ? ` · ${entry.ruleSuggestion.description}` : ""}
                        </span>
                      )}
                    </>
                  );
                }
                case "amount":
                  return formatMoney(entry.amount);
                case "id": {
                  const proposal = proposalByEntry.get(entry.id);
                  return (
                    <span className={styles.listActions} style={{ justifyContent: "flex-end" }}>
                      {proposal && (
                        <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => selectProposal(proposal)}>
                          {proposal.ambiguous ? "Markera kandidaterna" : "Markera förslaget"}
                        </Button>
                      )}
                      <Button type="button" size="small" variant="secondary" disabled={pending} onClick={() => setBookEntry(entry)}>
                        Bokför
                      </Button>
                    </span>
                  );
                }
                default:
                  return null;
              }
            }}
          />

          <SectionHeading spaced>Omatchade rader i bokföringen</SectionHeading>
          <Table<BankLedgerRow>
            columns={[
              {
                key: "sel",
                label: "Markera",
                width: "28px",
                header: (
                  <SelectAllCheckbox
                    ariaLabel="Markera alla rader"
                    checked={rows.length > 0 && selRows.size === rows.length}
                    indeterminate={selRows.size > 0 && selRows.size < rows.length}
                    disabled={rows.length === 0}
                    onChange={(on) => setSelRows(on ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                ),
              },
              { key: "date", label: "Datum", width: "100px" },
              { key: "verification", label: "Verifikat", width: "100px" },
              { key: "description", label: "Beskrivning", width: "1.6fr" },
              { key: "amount", label: "Belopp", width: "110px", align: "right" },
              { key: "id", label: "", width: "170px", align: "right" },
            ]}
            rows={rows}
            emptyText="Inga omatchade rader — allt på bankkontot i bokföringen är matchat"
            renderCell={(row, key) => {
              switch (key) {
                case "sel":
                  return (
                    <Checkbox
                      checked={selRows.has(row.id)}
                      aria-label={`Markera raden i verifikat ${row.verificationDisplayNumber}`}
                      onChange={(e) => setSelRows((s) => toggled(s, row.id, e.target.checked))}
                    />
                  );
                case "date":
                  return row.date;
                case "verification":
                  return <Link href={`/ekonomi/verifikat/${row.verificationId}`}>{row.verificationDisplayNumber}</Link>;
                case "description": {
                  const proposal = proposalByRow.get(row.id);
                  return (
                    <>
                      {row.description}
                      {proposal && <ProposalBadge proposal={proposal} />}
                    </>
                  );
                }
                case "amount":
                  return formatMoney(row.amount);
                case "id": {
                  const proposal = proposalByRow.get(row.id);
                  return proposal ? (
                    <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => selectProposal(proposal)}>
                      {proposal.ambiguous ? "Markera kandidaterna" : "Markera förslaget"}
                    </Button>
                  ) : null;
                }
                default:
                  return null;
              }
            }}
          />

          <SectionHeading spaced>Matchat</SectionHeading>
          {view.matches.length === 0 ? (
            <FormHint>Inget är matchat i perioden än.</FormHint>
          ) : (
            view.matches.map((m) => <MatchCard key={m.id} match={m} pending={pending} onUndo={() => void undo(m)} />)
          )}

          <SectionHeading spaced>Avstämd t.o.m.</SectionHeading>
          <p style={{ margin: "0 0 12px" }}>
            {bankAccount.reconciledThrough
              ? `${bankAccount.name} är senast avstämt t.o.m. ${bankAccount.reconciledThrough}.`
              : `${bankAccount.name} har inte stämts av än.`}
          </p>
          <div className={styles.reconcile}>
            <Field label="Datum" htmlFor="bankReconThrough">
              <Input
                id="bankReconThrough"
                type="date"
                size="sm"
                value={reconcileDate}
                onChange={(e) => setReconcileDate(e.target.value)}
              />
            </Field>
            <Button type="button" variant="primary" disabled={pending || !isIsoDate(reconcileDate)} onClick={() => void reconcile()}>
              Markera som avstämd
            </Button>
          </div>
          <FormHint>
            Går bara när allt till och med datumet är matchat och kontoutdragets saldo stämmer med bokföringens.
          </FormHint>
          {view.reconciliations.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer" }}>Tidigare avstämningar ({view.reconciliations.length})</summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {view.reconciliations.map((r) => (
                  <li key={r.id}>
                    t.o.m. {r.throughDate} — saldo {formatMoney(r.statementBalance)} kr, markerad {r.createdAt.slice(0, 10)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <BankBookDialog
            entry={bookEntry}
            bankAccount={bankAccount}
            accounts={accounts}
            onClose={() => setBookEntry(null)}
            onBooked={booked}
          />
        </>
      )}

      <BankImportDialog
        open={importOpen}
        bankAccounts={bankAccounts}
        defaultBankAccountId={selectedId}
        onClose={() => setImportOpen(false)}
        onImported={imported}
      />
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      {sub && <div className={styles.tileSub}>{sub}</div>}
    </div>
  );
}

function ProposalBadge({ proposal }: { proposal: BankMatchProposal }) {
  return proposal.ambiguous ? (
    <span className={`${styles.badge} ${styles.badgeAmbiguous}`} title="Flera möjliga rader eller poster — välj själv">
      Flera möjliga
    </span>
  ) : (
    <span className={`${styles.badge} ${styles.badgeProposal}`} title="Förslag på matchning">
      Förslag · {BASIS_LABELS[proposal.basis]}
    </span>
  );
}

function MatchCard({ match, pending, onUndo }: { match: BankMatch; pending: boolean; onUndo: () => void }) {
  const sum = sumAmounts(match.entries);
  return (
    <details className={styles.match}>
      <summary>
        <strong>{BANK_MATCH_KIND_LABELS[match.kind]}</strong>
        <span>{match.createdAt.slice(0, 10)}</span>
        <span>
          {match.entries.length} {match.entries.length === 1 ? "post" : "poster"} · {match.rows.length}{" "}
          {match.rows.length === 1 ? "rad" : "rader"}
        </span>
        <span>{formatMoney(sum)} kr</span>
      </summary>
      <div className={styles.matchBody}>
        <div>
          <div className={styles.matchColumnTitle}>Poster på kontoutdraget</div>
          {match.entries.map((e) => (
            <div className={styles.matchLine} key={e.id}>
              <span className={styles.matchLineText}>
                {e.bookingDate} · {e.text}
              </span>
              <span className={styles.matchLineAmount}>{formatMoney(e.amount)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className={styles.matchColumnTitle}>Rader i bokföringen</div>
          {match.rows.map((r) => (
            <div className={styles.matchLine} key={r.id}>
              <span className={styles.matchLineText}>
                {r.date} · <Link href={`/ekonomi/verifikat/${r.verificationId}`}>{r.verificationDisplayNumber}</Link> · {r.description}
              </span>
              <span className={styles.matchLineAmount}>{formatMoney(r.amount)}</span>
            </div>
          ))}
        </div>
        <div className={styles.matchActions}>
          <Button type="button" size="small" variant="danger" disabled={pending} onClick={onUndo}>
            Ångra
          </Button>
        </div>
      </div>
    </details>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox, Field, Toggle } from "../ui/Field";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { HelpLink } from "../ui/HelpLink";
import { FormError, FormHint } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type { CollectiveInvoicingCandidate, CollectiveInvoicingResult } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";
import styles from "../../app/forsaljning/samlingsfakturering/page.module.css";

interface DisplayCandidate extends CollectiveInvoicingCandidate {
  id: string;
}

function withId(candidates: CollectiveInvoicingCandidate[]): DisplayCandidate[] {
  return candidates.map((c) => ({ ...c, id: c.customerId }));
}

// Default selection: every candidate, unless the routine was opened from a
// specific customer (Fakturera-länken on a sales order / New invoice dialog)
// — then only that customer starts checked.
function defaultSelection(candidates: DisplayCandidate[], preselectCustomerId?: string): Set<string> {
  if (preselectCustomerId && candidates.some((c) => c.customerId === preselectCustomerId)) {
    return new Set([preselectCustomerId]);
  }
  return new Set(candidates.map((c) => c.id));
}

const RESULT_STATUS: Record<CollectiveInvoicingResult["status"], { status: "draft" | "done" | "stopped"; label: string }> = {
  draft: { status: "draft", label: "Utkast" },
  issued: { status: "done", label: "Utfärdad" },
  skipped: { status: "stopped", label: "Inget att fakturera" },
  failed: { status: "stopped", label: "Misslyckades" },
};

export function CollectiveInvoicingClient({
  initialCandidates,
  preselectCustomerId,
}: {
  initialCandidates: CollectiveInvoicingCandidate[];
  preselectCustomerId?: string;
}) {
  const [candidates, setCandidates] = useState<DisplayCandidate[]>(() => withId(initialCandidates));
  const [selected, setSelected] = useState<Set<string>>(() =>
    defaultSelection(withId(initialCandidates), preselectCustomerId)
  );
  const [issue, setIssue] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CollectiveInvoicingResult[] | null>(null);

  // Valuta: the Valutor column only when some candidate sells in another
  // currency than SEK (for SEK-only it would repeat "SEK" on every row).
  const anyForeign = candidates.some((c) => c.currencies.some((currency) => currency !== "SEK"));
  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleOne(customerId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(customerId);
      else next.delete(customerId);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(candidates.map((c) => c.id)) : new Set());
  }

  const totalAmount = useMemo(
    () => candidates.filter((c) => selected.has(c.id)).reduce((sum, c) => sum + c.netAmount, 0),
    [candidates, selected]
  );

  async function runInvoicing() {
    setError(null);
    setRunning(true);
    try {
      const res = await apiFetch<{ results: CollectiveInvoicingResult[] }>("/api/v1/collective-invoicing/run", {
        method: "POST",
        body: JSON.stringify({ customerIds: Array.from(selected), issue }),
      });
      setResults(res.results);
      const fresh = withId(await apiFetch<CollectiveInvoicingCandidate[]>("/api/v1/collective-invoicing/candidates"));
      setCandidates(fresh);
      setSelected(defaultSelection(fresh));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa samlingsfakturor"));
    } finally {
      setRunning(false);
    }
  }

  // The run button renders twice — under the table on desktop, in the sticky
  // bar above it in the mobile stack — so build it once.
  const runButton = (
    <Button type="button" variant="primary" disabled={selected.size === 0 || running} onClick={runInvoicing}>
      {running ? "Skapar…" : "Skapa samlingsfakturor"}
    </Button>
  );

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Samlingsfakturering</div>
          <div className={shellStyles.meta}>
            {candidates.length.toLocaleString("sv-SE")} kunder med levererade, ofakturerade order
          </div>
        </div>
        <HelpLink chapter="forsaljning" anchor="samlingsfakturering" label="Hjälp om samlingsfakturering" />
      </div>

      {/* Mobile stack (≤640px): the header row with its select-all checkbox
          is hidden and the controls under the cards are out of reach — this
          sticky bar carries them instead. CSS hides it on wider screens. */}
      <div className={styles.selectBar} role="region" aria-label="Markera kunder">
        <label className={styles.selectAllLabel}>
          <SelectAllCheckbox
            checked={allSelected}
            indeterminate={someSelected}
            disabled={candidates.length === 0}
            onChange={toggleAll}
            ariaLabel="Välj alla kunder"
          />
          Välj alla ({candidates.length})
        </label>
        {candidates.length > 0 && (
          <span>
            {selected.size} valda · {formatMoney(totalAmount)} kr
          </span>
        )}
        <label className={styles.toggleLabel}>
          <Toggle checked={issue} onChange={(e) => setIssue(e.target.checked)} aria-label="Utfärda direkt" />
          Utfärda direkt
        </label>
        {runButton}
      </div>

      <Table<DisplayCandidate>
        columns={[
          {
            key: "select",
            label: "",
            width: "36px",
            header: (
              <SelectAllCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={candidates.length === 0}
                onChange={toggleAll}
                ariaLabel="Välj alla kunder"
              />
            ),
          },
          { key: "customerNumber", label: "Kundnr", width: "110px" },
          { key: "name", label: "Kund", width: "1.6fr" },
          { key: "orderCount", label: "Order", width: "90px", align: "right" },
          { key: "rowCount", label: "Rader", width: "90px", align: "right" },
          { key: "shipmentCount", label: "Frakter", width: "90px", align: "right" },
          // Valuta: one invoice is made per currency a customer has orders in.
          ...(anyForeign ? [{ key: "currencies", label: "Valutor", width: "110px" }] : []),
          { key: "netAmount", label: anyForeign ? "Belopp exkl. moms (SEK)" : "Belopp exkl. moms", width: "170px", align: "right" },
        ]}
        rows={candidates}
        emptyText="Inga kunder med Samlingsfaktura har levererade, ofakturerade order."
        renderCell={(candidate, key) => {
          switch (key) {
            case "select":
              return (
                <Checkbox
                  checked={selected.has(candidate.id)}
                  onChange={(e) => toggleOne(candidate.id, e.target.checked)}
                  aria-label={`Välj ${candidate.name}`}
                />
              );
            case "customerNumber":
              return candidate.customerNumber;
            case "name":
              return (
                <Link href={`/kunder/${candidate.customerId}`} className={listStyles.rowLink}>
                  {candidate.name}
                </Link>
              );
            case "orderCount":
              return candidate.orderCount.toLocaleString("sv-SE");
            case "rowCount":
              return candidate.rowCount.toLocaleString("sv-SE");
            case "shipmentCount":
              return candidate.shipmentCount.toLocaleString("sv-SE");
            case "currencies":
              return candidate.currencies.length > 0 ? candidate.currencies.join(", ") : "–";
            case "netAmount":
              return `${formatMoney(candidate.netAmount)} kr`;
            default:
              return null;
          }
        }}
        footer={
          candidates.length > 0
            ? { name: `${selected.size} valda`, netAmount: `${formatMoney(totalAmount)} kr` }
            : undefined
        }
      />

      {anyForeign && (
        <FormHint>
          En faktura har en valuta: en kund med order i flera valutor får en faktura per valuta. Beloppen i tabellen är
          omräknade till SEK med orderns kurs; fakturans kurs sätts när den utfärdas.
        </FormHint>
      )}

      <div className={styles.actionBar}>
        <div>
          <Field label="Utfärda direkt" htmlFor="issue">
            <Toggle id="issue" checked={issue} onChange={(e) => setIssue(e.target.checked)} />
          </Field>
          <FormHint>Fakturorna får fakturanummer och bokförs (serie F) direkt. Avstängt: de skapas som utkast.</FormHint>
        </div>
        {runButton}
      </div>

      <FormError margin="above">{error}</FormError>

      {results && (
        <div style={{ marginTop: 24 }}>
          <SectionHeading>Resultat</SectionHeading>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {results.map((r) => (
              <li key={`${r.customerId}-${r.currency ?? ""}`} style={{ marginBottom: 6 }}>
                {r.customerNumber ?? "–"} {r.name ?? ""}
                {r.currency && r.currency !== "SEK" ? ` (${r.currency})` : ""} —{" "}
                <StatusPill
                  {...RESULT_STATUS[r.status]}
                  label={r.onHold ? "Utkast — Faktura i vänteläge" : undefined}
                  compact
                />
                {r.invoiceId && (
                  <>
                    {" "}
                    <Link href={`/forsaljning/fakturor/${r.invoiceId}`}>{r.invoiceNumber ?? "Utkast"}</Link>
                  </>
                )}
                {r.error && (
                  <FormError inline margin="above">
                    {r.error}
                  </FormError>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

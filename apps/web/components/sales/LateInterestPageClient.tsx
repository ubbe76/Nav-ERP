"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusPill } from "../ui/StatusPill";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { SelectAllCheckbox } from "../ui/SelectAllCheckbox";
import { HelpLink } from "../ui/HelpLink";
import { GatedLink } from "../ui/GatedLink";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import {
  customerSummaries,
  defaultSelection,
  halfYearLabel,
  hasChargeableInterest,
  periodText,
  rateText,
  runItems,
} from "../../lib/lateInterest";
import { INVOICE_STATUS_PILL } from "../../lib/types";
import type {
  Customer,
  InvoiceStatus,
  LateInterestCandidate,
  LateInterestCandidates,
  LateInterestRunResult,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import listStyles from "../../app/forsaljning/ordrar/page.module.css";
import styles from "../../app/forsaljning/rantefakturering/page.module.css";

type DisplayRow = LateInterestCandidate & { id: string };
type SummaryRow = { id: string; customerId: string; customerName: string; interest: number; fee: number; total: number; note: string };

const withId = (rows: LateInterestCandidate[]): DisplayRow[] => rows.map((r) => ({ ...r, id: r.invoiceId }));

export function LateInterestPageClient(
  props:
    | { enabled: false }
    | {
        enabled: true;
        asOf: string;
        customerId: string;
        includeUnpaid: boolean;
        initial: LateInterestCandidates;
        customers: Customer[];
        lateFeeEnabled: boolean;
        minAmount: number;
      }
) {
  if (!props.enabled) {
    return (
      <>
        <Topbar subtitle="Avstängd" />
        <Card maxWidth={620}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Dröjsmålsränta är avstängd</div>
          <FormHint>
            Räntefakturering kräver att Debitera dröjsmålsränta är på. Slå på den under{" "}
            <GatedLink href="/ekonomi/konteringsregler">Konteringsregler</GatedLink> i sektionen Dröjsmålsränta och
            förseningsersättning — där ställs också räntemarginalen, minsta räntebelopp, förseningsersättningen och
            kontona in. Räntan följer Riksbankens <GatedLink href="/ekonomi/referensranta">referensränta</GatedLink>.
          </FormHint>
        </Card>
      </>
    );
  }
  return <Routine {...props} />;
}

function Topbar({ subtitle }: { subtitle: string }) {
  return (
    <div className={shellStyles.topbar}>
      <div>
        <div className={shellStyles.title}>Räntefakturering</div>
        <div className={shellStyles.meta}>{subtitle}</div>
      </div>
      <HelpLink chapter="forsaljning" anchor="rantefakturering" label="Hjälp om räntefakturering" />
    </div>
  );
}

function Routine({
  asOf,
  customerId,
  includeUnpaid,
  initial,
  customers,
  lateFeeEnabled,
  minAmount,
}: {
  asOf: string;
  customerId: string;
  includeUnpaid: boolean;
  initial: LateInterestCandidates;
  customers: Customer[];
  lateFeeEnabled: boolean;
  minAmount: number;
}) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const [data, setData] = useState<LateInterestCandidates>(initial);
  const rows = useMemo(() => withId(data.rows), [data.rows]);
  const [interestSel, setInterestSel] = useState<Set<string>>(() => defaultSelection(initial.rows).interest);
  const [feeSel, setFeeSel] = useState<Set<string>>(() => defaultSelection(initial.rows).fee);
  const [issue, setIssue] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LateInterestRunResult | null>(null);

  // The urval form: applied by navigating, so the URL carries it.
  const [fAsOf, setFAsOf] = useState(asOf);
  const [fCustomerId, setFCustomerId] = useState(customerId);
  const [fIncludeUnpaid, setFIncludeUnpaid] = useState(includeUnpaid);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    const query = new URLSearchParams();
    if (fAsOf) query.set("asOf", fAsOf);
    if (fCustomerId) query.set("customerId", fCustomerId);
    if (!fIncludeUnpaid) query.set("includeUnpaid", "false");
    const qs = query.toString();
    startNavigation(() => router.push(`/forsaljning/rantefakturering${qs ? `?${qs}` : ""}`));
  }

  const summaries = useMemo(
    () => customerSummaries(rows, { interest: interestSel, fee: feeSel }, minAmount),
    [rows, interestSel, feeSel, minAmount]
  );
  const items = useMemo(() => runItems(rows, { interest: interestSel, fee: feeSel }), [rows, interestSel, feeSel]);
  const invoicingCustomers = summaries.filter((s) => s.total > 0);
  const grandTotal = invoicingCustomers.reduce((sum, s) => sum + s.total, 0);

  const selectable = rows.filter(hasChargeableInterest);
  const allSelected = selectable.length > 0 && selectable.every((r) => interestSel.has(r.invoiceId));
  const someSelected = selectable.some((r) => interestSel.has(r.invoiceId)) && !allSelected;

  function toggle(setter: (fn: (prev: Set<string>) => Set<string>) => void, id: string, checked: boolean) {
    setter((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setInterestSel(checked ? new Set(selectable.map((r) => r.invoiceId)) : new Set());
  }

  async function reload() {
    const query = new URLSearchParams({ asOf, includeUnpaid: String(includeUnpaid) });
    if (customerId) query.set("customerId", customerId);
    const fresh = await apiFetch<LateInterestCandidates>(`/api/v1/late-interest/candidates?${query.toString()}`);
    const sel = defaultSelection(fresh.rows);
    setData(fresh);
    setInterestSel(sel.interest);
    setFeeSel(sel.fee);
  }

  async function run() {
    const customersText = `${invoicingCustomers.length} ${invoicingCustomers.length === 1 ? "kund" : "kunder"}`;
    const ok = await confirmDialog(
      `Skapa räntefakturor för ${customersText} på sammanlagt ${formatMoney(grandTotal)} kr? ` +
        (issue
          ? "De får fakturanummer och bokförs direkt."
          : "De skapas som utkast som du utfärdar under Fakturor."),
      { confirmLabel: "Skapa räntefakturor" }
    );
    if (!ok) return;
    setError(null);
    setRunning(true);
    try {
      const res = await apiFetch<LateInterestRunResult>("/api/v1/late-interest/invoices", {
        method: "POST",
        body: JSON.stringify({ asOf, issue, items }),
      });
      setResult(res);
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte skapa räntefakturorna"));
      // Whatever made the run fail (someone else charged the period first,
      // a rate arrived) — show the list as it stands now.
      await reload().catch(() => undefined);
    } finally {
      setRunning(false);
    }
  }

  const runButton = (
    <Button type="button" variant="primary" disabled={items.length === 0 || running} onClick={run}>
      {running ? "Skapar…" : "Skapa räntefakturor"}
    </Button>
  );

  const summaryRows: SummaryRow[] = summaries.map((s) => ({
    id: s.customerId,
    customerId: s.customerId,
    customerName: s.customerName,
    interest: s.interest,
    fee: s.fee,
    total: s.total,
    note:
      s.total === 0
        ? "Ingen räntefaktura — räntan är under minsta räntebelopp"
        : s.interestBelowMinimum
          ? `Räntan är under minsta räntebelopp (${formatMoney(minAmount)} kr) — bara förseningsersättningen faktureras`
          : "",
  }));

  const selectedInterestTotal = rows
    .filter((r) => interestSel.has(r.invoiceId) && hasChargeableInterest(r))
    .reduce((sum, r) => sum + (r.interest ?? 0), 0);

  return (
    <>
      <Topbar subtitle={`${rows.length.toLocaleString("sv-SE")} ${rows.length === 1 ? "faktura" : "fakturor"} med ränta eller förseningsersättning`} />

      <form onSubmit={applyFilters} className={styles.filters}>
        <Field label="T.o.m. datum" htmlFor="lateAsOf">
          <Input id="lateAsOf" type="date" size="sm" required value={fAsOf} onChange={(e) => setFAsOf(e.target.value)} />
        </Field>
        <Field label="Kund" htmlFor="lateCustomer">
          <Select id="lateCustomer" value={fCustomerId} onChange={(e) => setFCustomerId(e.target.value)}>
            <option value="">Alla kunder</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customerNumber} {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className={styles.checkLabel}>
          <Checkbox checked={fIncludeUnpaid} onChange={(e) => setFIncludeUnpaid(e.target.checked)} />
          Ta med obetalda fakturor
        </label>
        <Button type="submit" variant="secondary" disabled={navigating}>
          {navigating ? "Hämtar…" : "Visa"}
        </Button>
      </form>
      <FormHint style={{ marginTop: -6, marginBottom: 14 }}>
        Sent betalda fakturor räknas till betalningsdagen. Obetalda fakturor räknas till T.o.m. datum och kan faktureras
        igen nästa gång — räntan börjar då dagen efter den förra perioden.
      </FormHint>

      {data.rateMissing.length > 0 && (
        <FormNotice style={{ marginBottom: 14 }}>
          Referensränta saknas för {data.rateMissing.map(halfYearLabel).join(" och ")} — fakturor med ränta för{" "}
          {data.rateMissing.length === 1 ? "det halvåret" : "de halvåren"} visas utan belopp och kan inte faktureras
          för räntan. Lägg in räntan under <GatedLink href="/ekonomi/referensranta">Referensränta</GatedLink> (eller
          hämta den från Riksbanken där) och visa listan igen.
        </FormNotice>
      )}

      {/* Mobile stack (≤640px): the header row with its select-all checkbox is
          hidden and the controls under the cards are out of reach — this
          sticky bar carries them instead. CSS hides it on wider screens. */}
      <div className={styles.selectBar} role="region" aria-label="Markera fakturor">
        <label className={styles.selectAllLabel}>
          <SelectAllCheckbox
            checked={allSelected}
            indeterminate={someSelected}
            disabled={selectable.length === 0}
            onChange={toggleAll}
            ariaLabel="Välj alla fakturor med ränta"
          />
          Välj alla ({selectable.length})
        </label>
        {rows.length > 0 && <span>{formatMoney(grandTotal)} kr att fakturera</span>}
        <label className={styles.toggleLabel}>
          <Toggle checked={issue} onChange={(e) => setIssue(e.target.checked)} aria-label="Utfärda direkt" />
          Utfärda direkt
        </label>
        {runButton}
      </div>

      <Table<DisplayRow>
        columns={[
          {
            key: "select",
            label: "",
            width: "36px",
            header: (
              <SelectAllCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={selectable.length === 0}
                onChange={toggleAll}
                ariaLabel="Välj alla fakturor med ränta"
              />
            ),
          },
          { key: "customerName", label: "Kund", width: "1.2fr" },
          { key: "invoiceNumber", label: "Faktura", width: "120px" },
          { key: "dueDate", label: "Förfallodag", width: "105px" },
          { key: "paidDate", label: "Betald", width: "105px" },
          { key: "period", label: "Period", width: "190px" },
          { key: "days", label: "Dagar", width: "60px", align: "right" },
          { key: "rate", label: "Räntesats", width: "110px", align: "right" },
          { key: "interest", label: "Ränta", width: "120px", align: "right" },
          ...(lateFeeEnabled
            ? [{ key: "fee", label: "Förseningsersättning", width: "190px", align: "right" as const }]
            : []),
        ]}
        rows={rows}
        emptyText="Inga fakturor har ränta eller förseningsersättning att fakturera."
        renderCell={(row, key) => {
          switch (key) {
            case "select":
              return (
                <Checkbox
                  checked={interestSel.has(row.id) && hasChargeableInterest(row)}
                  disabled={!hasChargeableInterest(row)}
                  onChange={(e) => toggle(setInterestSel, row.id, e.target.checked)}
                  aria-label={`Fakturera ränta på ${row.invoiceNumber}`}
                />
              );
            case "customerName":
              return (
                <Link href={`/kunder/${row.customerId}`} className={listStyles.rowLink}>
                  {row.customerName}
                </Link>
              );
            case "invoiceNumber":
              return (
                <>
                  <Link href={`/forsaljning/fakturor/${row.invoiceId}`}>{row.invoiceNumber}</Link>
                  <span className={styles.sub}>Brutto {formatMoney(row.principal)} kr</span>
                </>
              );
            case "dueDate":
              return row.dueDate;
            case "paidDate":
              return row.paidDate ?? (
                <>
                  Obetald
                  <span className={styles.sub}>Öppet {formatMoney(row.openAmount)} kr</span>
                </>
              );
            case "period":
              return periodText(row);
            case "days":
              return row.days > 0 ? row.days.toLocaleString("sv-SE") : "–";
            case "rate":
              return rateText(row);
            case "interest":
              if (row.rateMissing || row.interest === null) return "Saknas";
              return (
                <>
                  {formatMoney(row.interest)} kr
                  {row.belowMinimum && <span className={styles.sub}>Under minsta belopp</span>}
                </>
              );
            case "fee":
              return row.fee > 0 ? (
                <span className={styles.feeCell}>
                  <Checkbox
                    checked={feeSel.has(row.id)}
                    onChange={(e) => toggle(setFeeSel, row.id, e.target.checked)}
                    aria-label={`Fakturera förseningsersättning på ${row.invoiceNumber}`}
                  />
                  {formatMoney(row.fee)} kr
                </span>
              ) : (
                "–"
              );
            default:
              return null;
          }
        }}
        footer={
          rows.length > 0
            ? {
                customerName: `${items.length} valda`,
                interest: `${formatMoney(selectedInterestTotal)} kr`,
              }
            : undefined
        }
      />

      {summaryRows.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <SectionHeading>Summa per kund</SectionHeading>
          <Table<SummaryRow>
            columns={[
              { key: "customerName", label: "Kund", width: "1.2fr" },
              { key: "interest", label: "Ränta", width: "130px", align: "right" },
              ...(lateFeeEnabled ? [{ key: "fee", label: "Förseningsersättning", width: "190px", align: "right" as const }] : []),
              { key: "total", label: "Räntefaktura", width: "140px", align: "right" },
              { key: "note", label: "", width: "1.4fr" },
            ]}
            rows={summaryRows}
            renderCell={(row, key) => {
              switch (key) {
                case "customerName":
                  return row.customerName;
                case "interest":
                  return `${formatMoney(row.interest)} kr`;
                case "fee":
                  return `${formatMoney(row.fee)} kr`;
                case "total":
                  return row.total > 0 ? `${formatMoney(row.total)} kr` : "–";
                case "note":
                  return row.note;
                default:
                  return null;
              }
            }}
            footer={{ customerName: `${invoicingCustomers.length} räntefakturor`, total: `${formatMoney(grandTotal)} kr` }}
          />
          <FormHint>
            Minsta räntebelopp ({formatMoney(minAmount)} kr) gäller räntan per räntefaktura — summan för kunden, inte
            varje faktura för sig. Ränta och förseningsersättning är utanför momsens tillämpningsområde.
          </FormHint>
        </div>
      )}

      <div className={styles.actionBar}>
        <div>
          <Field label="Utfärda direkt" htmlFor="lateIssue">
            <Toggle id="lateIssue" checked={issue} onChange={(e) => setIssue(e.target.checked)} />
          </Field>
          <FormHint>Räntefakturorna får fakturanummer och bokförs (serie F) direkt. Avstängt: de skapas som utkast.</FormHint>
        </div>
        {runButton}
      </div>

      <FormError margin="above">{error}</FormError>

      {result && (
        <div style={{ marginTop: 24 }}>
          <SectionHeading>Resultat</SectionHeading>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.created.map((c) => {
              const pill = INVOICE_STATUS_PILL[c.status as InvoiceStatus];
              return (
                <li key={c.invoiceId} style={{ marginBottom: 6 }}>
                  {c.customerName} —{" "}
                  <Link href={`/forsaljning/fakturor/${c.invoiceId}`}>{c.invoiceNumber ?? "Utkast"}</Link>{" "}
                  {pill && <StatusPill status={pill.status} label={pill.label} compact />} {formatMoney(c.total)} kr
                </li>
              );
            })}
            {result.skipped.map((s) => (
              <li key={`skipped-${s.customerName}`} style={{ marginBottom: 6 }}>
                {s.customerName} — <StatusPill status="stopped" label="Inget att fakturera" compact /> {s.reason}
              </li>
            ))}
          </ul>
          {result.issueFailed.length > 0 && (
            <FormError margin="above">
              {result.issueFailed.length === 1 ? "En räntefaktura" : `${result.issueFailed.length} räntefakturor`} kunde
              inte utfärdas och {result.issueFailed.length === 1 ? "ligger" : "ligger"} kvar som utkast:{" "}
              {result.issueFailed.map((f) => {
                const created = result.created.find((c) => c.invoiceId === f.invoiceId);
                return `${created?.customerName ?? f.invoiceId}: ${f.error}`;
              }).join(" · ")}
            </FormError>
          )}
        </div>
      )}
    </>
  );
}

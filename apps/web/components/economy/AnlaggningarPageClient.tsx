"use client";

import { confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusPill } from "../ui/StatusPill";
import { ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { FIXED_ASSET_STATUS_LABELS, currentMonthKey, monthLabel } from "../../lib/fixedAssets";
import type { DepreciationPreview, DepreciationRun, DepreciationRunResult, FixedAsset, FixedAssetCategory, Paged, SupplierInvoice } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

const DEPRECIATION_WARNINGS: Record<DepreciationPreview["warnings"][number], string> = {
  "period-locked": "Perioden för verifikatdatumet är låst — lås upp månaden under Räkenskapsår först.",
  "no-period": "Inget räkenskapsår täcker verifikatdatumet.",
  "month-in-future": "Månaden har inte passerat — avskrivningar förbokas inte.",
  "inactive-account": "Ett av gruppens konton är inaktivt i kontoplanen — aktivera kontot eller byt konto på gruppen:",
};

// Förval och max: förra månaden — innevarande månad är inte slut, och en
// vanlig körning dateras månadens sista dag (ingen förbokning).
function previousMonthKey(): string {
  const [year, month] = currentMonthKey().split("-").map(Number);
  const previous = new Date(Date.UTC(year!, month! - 2, 1));
  return previous.toISOString().slice(0, 7);
}

export function AnlaggningarPageClient({
  assets,
  categories,
  runs,
  supplierInvoices,
  pageSize,
}: {
  assets: Paged<FixedAsset>;
  categories: FixedAssetCategory[];
  runs: Paged<DepreciationRun>;
  supplierInvoices: SupplierInvoice[];
  pageSize: number;
}) {
  const [createOpen, setCreateOpen] = useState(false);

  const columns = [
    { key: "assetNumber", label: "Nr", width: "90px" },
    { key: "name", label: "Benämning", width: "2fr" },
    { key: "categoryName", label: "Grupp", width: "1.2fr" },
    { key: "acquisitionDate", label: "Anskaffad", width: "110px" },
    { key: "acquisitionCost", label: "Anskaffningsvärde", width: "1fr", align: "right" as const },
    { key: "accumulated", label: "Ack. avskrivning", width: "1fr", align: "right" as const },
    { key: "bookValue", label: "Bokfört värde", width: "1fr", align: "right" as const },
    { key: "status", label: "Status", width: "110px" },
  ];

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Anläggningsregister</div>
          <div className={shellStyles.meta}>{assets.total.toLocaleString("sv-SE")} anläggningar</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Ny anläggning
          </Button>
          <HelpLink chapter="ekonomi" anchor="anlaggningsregister" label="Hjälp om anläggningsregistret" />
        </div>
      </div>

      <DepreciationSection runs={runs} />

      <ListToolbar placeholder="Sök nr eller benämning…">
        <ListFilterSelect
          param="status"
          allLabel="Aktiva"
          ariaLabel="Status"
          options={[
            { value: "disposed", label: "Avyttrade" },
            { value: "all", label: "Alla" },
          ]}
        />
        <ListFilterSelect
          param="categoryId"
          allLabel="Alla grupper"
          ariaLabel="Grupp"
          options={categories.map((category) => ({ value: category.id, label: category.name }))}
        />
      </ListToolbar>

      <Table
        columns={columns}
        rows={assets.rows}
        emptyText="Inga anläggningar."
        renderCell={(asset, key) => {
          switch (key) {
            case "assetNumber":
              return <Link href={`/ekonomi/anlaggningar/${asset.id}`}>{asset.assetNumber}</Link>;
            case "name":
              return <Link href={`/ekonomi/anlaggningar/${asset.id}`}>{asset.name}</Link>;
            case "categoryName":
              return asset.categoryName;
            case "acquisitionDate":
              return asset.acquisitionDate;
            case "acquisitionCost":
              return formatMoney(asset.acquisitionCost);
            case "accumulated":
              return formatMoney(asset.accumulatedDepreciation);
            case "bookValue":
              return formatMoney(asset.bookValue);
            case "status":
              return <StatusPill status={asset.status === "active" ? "running" : "done"} label={FIXED_ASSET_STATUS_LABELS[asset.status]} />;
            default:
              return null;
          }
        }}
      />
      <Pagination total={assets.total} pageSize={pageSize} />

      {/* Mounted only while open so a cancelled form starts blank next time. */}
      {createOpen && <NewAssetModal open onClose={() => setCreateOpen(false)} categories={categories} supplierInvoices={supplierInvoices} />}
    </>
  );
}

function DepreciationSection({ runs }: { runs: Paged<DepreciationRun> }) {
  const router = useRouter();
  const [throughMonth, setThroughMonth] = useState(previousMonthKey());
  const [preview, setPreview] = useState<DepreciationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const latest = runs.rows.find((run) => !run.reversalVerification) ?? null;
  const undoable = runs.rows.find((run) => run.undoable) ?? null;

  async function openPreview() {
    setLoading(true);
    setError(null);
    try {
      setPreview(await apiFetch<DepreciationPreview>(`/api/v1/fixed-asset-depreciation-runs/preview?throughMonth=${throughMonth}`));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta förhandsgranskningen"));
    } finally {
      setLoading(false);
    }
  }

  async function book() {
    setBooking(true);
    setError(null);
    try {
      const booked = await apiFetch<DepreciationRunResult>("/api/v1/fixed-asset-depreciation-runs", {
        method: "POST",
        body: JSON.stringify({ throughMonth }),
      });
      setResult(`Avskrivningar bokförda — Verifikat ${booked.verification.displayNumber}`);
      setPreview(null);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte bokföra avskrivningarna"));
    } finally {
      setBooking(false);
    }
  }

  async function undo() {
    if (!undoable) return;
    if (!(await confirmDialog(`Ångra körningen t.o.m. ${monthLabel(undoable.throughMonth)} (${undoable.verification.displayNumber})? En omföring bokförs på körningens datum.`))) return;
    setError(null);
    try {
      const undone = await apiFetch<{ reversalVerification: { displayNumber: string } }>(`/api/v1/fixed-asset-depreciation-runs/${undoable.id}/undo`, { method: "POST" });
      setResult(`Körningen ångrad — Omföring ${undone.reversalVerification.displayNumber}`);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ångra körningen"));
    }
  }

  return (
    <Card maxWidth="none" style={{ marginBottom: 20 }}>
      <h2 style={{ marginTop: 0 }}>Avskrivningar</h2>
      <p style={{ color: "var(--color-text-secondary)" }}>
        {latest ? (
          <>
            Senast bokförd t.o.m. <strong>{monthLabel(latest.throughMonth)}</strong> (
            <Link href={`/ekonomi/verifikat/${latest.verification.id}`}>{latest.verification.displayNumber}</Link>, {latest.verification.date})
          </>
        ) : (
          "Inga avskrivningar bokförda"
        )}
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="T.o.m. månad" htmlFor="through-month">
          <Input id="through-month" type="month" value={throughMonth} max={previousMonthKey()} onChange={(e) => setThroughMonth(e.target.value)} />
        </Field>
        <Button type="button" disabled={loading || !throughMonth} onClick={openPreview}>
          {loading ? "Hämtar…" : "Bokför avskrivningar"}
        </Button>
        {undoable && (
          <Button type="button" variant="secondary" onClick={undo}>
            Ångra senaste körning
          </Button>
        )}
      </div>
      {result && <FormNotice style={{ marginTop: 12 }}>{result}</FormNotice>}
      <FormError margin="above">{error}</FormError>

      {runs.rows.length > 0 && (
        <Table
          columns={[
            { key: "throughMonth", label: "T.o.m.", width: "1fr" },
            { key: "date", label: "Datum", width: "110px" },
            { key: "verification", label: "Verifikat", width: "1fr" },
            { key: "amount", label: "Belopp", width: "1fr", align: "right" as const },
            { key: "state", label: "", width: "1.5fr" },
          ]}
          rows={runs.rows}
          renderCell={(run, key) => {
            switch (key) {
              case "throughMonth":
                return run.disposalAssetNumber ? `${monthLabel(run.throughMonth)} (avyttring ${run.disposalAssetNumber})` : monthLabel(run.throughMonth);
              case "date":
                return run.verification.date;
              case "verification":
                return <Link href={`/ekonomi/verifikat/${run.verification.id}`}>{run.verification.displayNumber}</Link>;
              case "amount":
                return formatMoney(run.amount);
              case "state":
                return run.reversalVerification ? (
                  <>
                    Omförd genom <Link href={`/ekonomi/verifikat/${run.reversalVerification.id}`}>{run.reversalVerification.displayNumber}</Link>
                  </>
                ) : (
                  `${run.rowCount} rader`
                );
              default:
                return null;
            }
          }}
        />
      )}

      <Modal open={preview !== null} onClose={() => setPreview(null)} title={`Bokför avskrivningar t.o.m. ${preview ? monthLabel(preview.throughMonth) : ""}`} wide>
        {preview && (
          <>
            {preview.warnings.map((warning) => (
              <FormNotice key={warning} style={{ marginBottom: 12 }}>
                {DEPRECIATION_WARNINGS[warning]}
                {warning === "inactive-account" && (
                  <> {preview.inactiveAccounts.map((row) => `${row.accountNumber} ${row.accountName} (${row.categoryName})`).join(", ")}</>
                )}
              </FormNotice>
            ))}
            {preview.assets.length === 0 ? (
              <p>Inget att bokföra — alla månader t.o.m. {monthLabel(preview.throughMonth)} är redan avskrivna.</p>
            ) : (
              <>
                <p>
                  Verifikatdatum <strong>{preview.date}</strong>, serie AV. Totalt <strong>{formatMoney(preview.total)}</strong>.
                </p>
                <Table
                  columns={[
                    { key: "categoryName", label: "Grupp", width: "2fr" },
                    { key: "accounts", label: "Konton (debet / kredit)", width: "1.5fr" },
                    { key: "amount", label: "Belopp", width: "1fr", align: "right" as const },
                  ]}
                  rows={preview.byCategory.map((row) => ({ ...row, id: row.categoryId }))}
                  renderCell={(row, key) =>
                    key === "categoryName" ? row.categoryName : key === "accounts" ? `${row.expenseAccountNumber} / ${row.accumulatedAccountNumber}` : formatMoney(row.amount)
                  }
                />
                <Table
                  columns={[
                    { key: "assetNumber", label: "Nr", width: "90px" },
                    { key: "name", label: "Benämning", width: "2fr" },
                    { key: "months", label: "Månader", width: "2fr" },
                    { key: "amount", label: "Belopp", width: "1fr", align: "right" as const },
                  ]}
                  rows={preview.assets.map((row) => ({ ...row, id: row.assetId }))}
                  renderCell={(row, key) => {
                    switch (key) {
                      case "assetNumber":
                        return row.assetNumber;
                      case "name":
                        return row.name;
                      case "months":
                        return row.months
                          .map((month) => (row.catchUpMonths.includes(month.month) ? `${month.month} (hämtas ikapp)` : month.month))
                          .join(", ");
                      case "amount":
                        return formatMoney(row.amount);
                      default:
                        return null;
                    }
                  }}
                />
                {preview.assets.some((row) => row.catchUpMonths.length > 0) && (
                  <FormHint>Månader markerade <em>hämtas ikapp</em> ligger i låsta perioder och bokförs på verifikatdatumet ovan.</FormHint>
                )}
              </>
            )}
            <FormActions>
              <Button type="button" variant="secondary" onClick={() => setPreview(null)}>
                Avbryt
              </Button>
              <Button type="button" disabled={booking || preview.assets.length === 0 || preview.warnings.length > 0} onClick={book}>
                {booking ? "Bokför…" : "Bokför avskrivningar"}
              </Button>
            </FormActions>
          </>
        )}
      </Modal>
    </Card>
  );
}

function NewAssetModal({
  open,
  onClose,
  categories,
  supplierInvoices,
}: {
  open: boolean;
  onClose: () => void;
  categories: FixedAssetCategory[];
  supplierInvoices: SupplierInvoice[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    categoryId: categories[0]?.id ?? "",
    acquisitionDate: "",
    acquisitionCost: "",
    residualValue: "0",
    usefulLifeMonths: String(categories[0]?.defaultUsefulLifeMonths ?? 60),
    depreciationStartMonth: "",
    openingDepreciation: "",
    openingDepreciationThroughMonth: "",
    supplierInvoiceId: "",
    note: "",
  });
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>("/api/v1/fixed-assets", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          categoryId: form.categoryId,
          acquisitionDate: form.acquisitionDate,
          acquisitionCost: form.acquisitionCost,
          residualValue: form.residualValue,
          usefulLifeMonths: form.usefulLifeMonths,
          depreciationStartMonth: form.depreciationStartMonth || undefined,
          openingDepreciation: form.openingDepreciation || "0",
          openingDepreciationThroughMonth: form.openingDepreciationThroughMonth || null,
          supplierInvoiceId: form.supplierInvoiceId || null,
          note: form.note || null,
        }),
      });
      onClose();
      router.push(`/ekonomi/anlaggningar/${created.id}`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara anläggningen"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Ny anläggning">
      <Form onSubmit={submit}>
        <FormRow>
          <Field label="Benämning" htmlFor="asset-name">
            <Input id="asset-name" value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={200} />
          </Field>
          <Field label="Grupp" htmlFor="asset-category">
            <Select
              id="asset-category"
              value={form.categoryId}
              onChange={(e) => {
                const category = categories.find((c) => c.id === e.target.value);
                set({ categoryId: e.target.value, usefulLifeMonths: String(category?.defaultUsefulLifeMonths ?? form.usefulLifeMonths) });
              }}
              required
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Anskaffningsdatum" htmlFor="asset-date">
            <Input
              id="asset-date"
              type="date"
              value={form.acquisitionDate}
              onChange={(e) => set({ acquisitionDate: e.target.value, depreciationStartMonth: form.depreciationStartMonth || e.target.value.slice(0, 7) })}
              required
            />
          </Field>
          <Field label="Avskrivningsstart" htmlFor="asset-start">
            <Input id="asset-start" type="month" value={form.depreciationStartMonth} min={form.acquisitionDate.slice(0, 7)} onChange={(e) => set({ depreciationStartMonth: e.target.value })} />
          </Field>
        </FormRow>
        <FormRow columns={3}>
          <Field label="Anskaffningsvärde" htmlFor="asset-cost">
            <Input id="asset-cost" type="number" step="0.01" min="0" value={form.acquisitionCost} onChange={(e) => set({ acquisitionCost: e.target.value })} required />
          </Field>
          <Field label="Restvärde" htmlFor="asset-residual">
            <Input id="asset-residual" type="number" step="0.01" min="0" value={form.residualValue} onChange={(e) => set({ residualValue: e.target.value })} />
          </Field>
          <Field label="Nyttjandetid (månader)" htmlFor="asset-life">
            <Input id="asset-life" type="number" min="0" step="any" value={form.usefulLifeMonths} onChange={(e) => set({ usefulLifeMonths: e.target.value })} required />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Ingående avskrivning" htmlFor="asset-opening">
            <Input id="asset-opening" type="number" step="0.01" min="0" value={form.openingDepreciation} required={form.openingDepreciationThroughMonth !== ""} onChange={(e) => set({ openingDepreciation: e.target.value })} />
          </Field>
          <Field label="Avskriven t.o.m. månad" htmlFor="asset-opening-month">
            <Input
              id="asset-opening-month"
              type="month"
              required={form.openingDepreciation.trim() !== "" && Number(form.openingDepreciation) !== 0}
              value={form.openingDepreciationThroughMonth}
              onChange={(e) => set({ openingDepreciationThroughMonth: e.target.value })}
            />
          </Field>
        </FormRow>
        <FormHint>Fylls i för tillgångar som anskaffats före Nav: den ackumulerade avskrivning som redan ligger i ingående balansen. Första körningen fortsätter månaden efter. Ingående avskrivning och Avskriven t.o.m. månad hör ihop: fyll i båda eller ingen av dem.</FormHint>
        <FormRow>
          <Field label="Leverantörsfaktura" htmlFor="asset-invoice">
            <Select id="asset-invoice" value={form.supplierInvoiceId} onChange={(e) => set({ supplierInvoiceId: e.target.value })}>
              <option value="">Ingen</option>
              {supplierInvoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.registrationNumber} · {invoice.invoiceNumber}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Anteckning" htmlFor="asset-note">
            <Textarea id="asset-note" value={form.note} onChange={(e) => set({ note: e.target.value })} rows={2} />
          </Field>
        </FormRow>
        <FormHint>Anskaffningen bokförs inte här — den är redan bokförd via leverantörsfakturan eller ett manuellt verifikat. Avskrivningsstart förvalet är anskaffningsmånaden.</FormHint>
        <FormError>{error}</FormError>
        <FormActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Sparar…" : "Spara"}
          </Button>
        </FormActions>
      </Form>
    </Modal>
  );
}

"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCan } from "../PermissionsProvider";
import { AuditTrailSection } from "../system/AuditTrailSection";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import { stockholmToday } from "../../lib/date";
import { FIXED_ASSET_DISPOSAL_TYPE_LABELS, monthLabel } from "../../lib/fixedAssets";
import type { Account, DisposalPreview, DisposalResult, FixedAssetCategory, FixedAssetDetail } from "../../lib/types";

export function AnlaggningCard({ asset, categories, accounts }: { asset: FixedAssetDetail; categories: FixedAssetCategory[]; accounts: Account[] }) {
  const router = useRouter();
  const can = useCan();
  const [editOpen, setEditOpen] = useState(false);
  const [disposeOpen, setDisposeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = asset.bookedMonthCount > 0;
  const disposed = asset.status === "disposed";

  async function remove() {
    if (!(await confirmDelete(`Ta bort ${asset.assetNumber} ${asset.name}?`))) return;
    try {
      await apiFetch<void>(`/api/v1/fixed-assets/${asset.id}`, { method: "DELETE" });
      router.push("/ekonomi/anlaggningar");
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort anläggningen"));
    }
  }

  const planRows = [
    ...asset.depreciations.map((row) => ({ id: row.id, month: row.month, amount: row.amount, verification: row, planned: false })),
    ...asset.plannedMonths.map((row) => ({ id: `planned-${row.month}`, month: row.month, amount: row.amount, verification: null, planned: true })),
  ];

  return (
    <div>
      <FormError margin="below">{error}</FormError>

      <Card maxWidth={620} style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Allmänt</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" variant="secondary" size="small" onClick={() => setEditOpen(true)}>
              Redigera
            </Button>
            {!disposed && asset.depreciations.length === 0 && (
              <Button type="button" variant="danger" size="small" onClick={remove}>
                Ta bort
              </Button>
            )}
          </div>
        </div>
        <FormStack>
          <FormRow>
            <div>
              <strong>Grupp</strong>
              <div>{asset.category.name}</div>
            </div>
            <div>
              <strong>Anskaffningsdatum</strong>
              <div>{asset.acquisitionDate}</div>
            </div>
            <div>
              <strong>Avskrivningsstart</strong>
              <div>{monthLabel(asset.depreciationStartMonth.slice(0, 7))}</div>
            </div>
          </FormRow>
          <FormRow>
            <div>
              <strong>Anskaffningsvärde</strong>
              <div>{formatMoney(asset.acquisitionCost)}</div>
            </div>
            <div>
              <strong>Restvärde</strong>
              <div>{formatMoney(asset.residualValue)}</div>
            </div>
            <div>
              <strong>Nyttjandetid</strong>
              <div>{asset.usefulLifeMonths} månader</div>
            </div>
          </FormRow>
          <FormRow>
            <div>
              <strong>Ack. avskrivning</strong>
              <div>{formatMoney(asset.accumulatedDepreciation)}</div>
            </div>
            <div>
              <strong>Bokfört värde</strong>
              <div>{formatMoney(asset.bookValue)}</div>
            </div>
            <div>
              <strong>Leverantörsfaktura</strong>
              <div>
                {asset.supplierInvoice ? (
                  <GatedLink href={`/inkop/leverantorsfakturor/${asset.supplierInvoice.id}`}>{asset.supplierInvoice.registrationNumber}</GatedLink>
                ) : (
                  "–"
                )}
              </div>
            </div>
          </FormRow>
          {Number(asset.openingDepreciation) > 0 && asset.openingDepreciationThroughMonth && (
            <div>
              <strong>Ingående avskrivning</strong>
              <div>
                {formatMoney(asset.openingDepreciation)} t.o.m. {monthLabel(asset.openingDepreciationThroughMonth.slice(0, 7))}
              </div>
            </div>
          )}
          {asset.note && (
            <div>
              <strong>Anteckning</strong>
              <div style={{ whiteSpace: "pre-wrap" }}>{asset.note}</div>
            </div>
          )}
        </FormStack>
      </Card>

      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Avskrivningsplan</h2>
        <Table
          columns={[
            { key: "month", label: "Månad", width: "1fr" },
            { key: "amount", label: "Belopp", width: "1fr", align: "right" as const },
            { key: "verification", label: "Verifikat", width: "1fr" },
            { key: "state", label: "", width: "1fr" },
          ]}
          rows={planRows}
          emptyText="Ingen avskrivning planerad (restvärde = anskaffningsvärde)."
          renderCell={(row, key) => {
            const muted = row.planned || row.verification?.reversed;
            const style = muted ? { color: "var(--color-text-secondary)" } : undefined;
            switch (key) {
              case "month":
                return <span style={style}>{monthLabel(row.month)}</span>;
              case "amount":
                return <span style={style}>{formatMoney(row.amount)}</span>;
              case "verification":
                return row.verification ? (
                  <Link href={`/ekonomi/verifikat/${row.verification.verificationId}`}>{row.verification.displayNumber}</Link>
                ) : (
                  <span style={style}>Planerad</span>
                );
              case "state":
                return row.verification?.reversed ? <span style={style}>Omförd</span> : null;
              default:
                return null;
            }
          }}
          footer={{ month: "Bokfört / bokfört värde", amount: `${formatMoney(asset.accumulatedDepreciation)} / ${formatMoney(asset.bookValue)}` }}
        />
      </Card>

      <Card maxWidth={620} style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Avyttring</h2>
        {disposed ? (
          <FormStack>
            <FormRow>
              <div>
                <strong>Typ</strong>
                <div>{asset.disposalType ? FIXED_ASSET_DISPOSAL_TYPE_LABELS[asset.disposalType] : "–"}</div>
              </div>
              <div>
                <strong>Datum</strong>
                <div>{asset.disposalDate}</div>
              </div>
              <div>
                <strong>Försäljningspris</strong>
                <div>{asset.disposalPrice !== null ? formatMoney(asset.disposalPrice) : "–"}</div>
              </div>
            </FormRow>
            <div>
              <strong>Avyttringsverifikat</strong>{" "}
              {asset.disposalVerification && (
                <Link href={`/ekonomi/verifikat/${asset.disposalVerification.id}`}>{asset.disposalVerification.displayNumber}</Link>
              )}
            </div>
          </FormStack>
        ) : (
          <>
            <p style={{ color: "var(--color-text-secondary)" }}>
              Avskrivning bokförs t.o.m. avyttringsmånaden, därefter tas anskaffningsvärde och ackumulerade avskrivningar bort och vinst/förlust bokförs. Avyttringen kan inte ångras.
            </p>
            <Button type="button" variant="secondary" onClick={() => setDisposeOpen(true)}>
              Avyttra
            </Button>
          </>
        )}
      </Card>

      {/* The audit-log API is admin-only. */}
      {can(["admin"]) && <AuditTrailSection entityType="fixed_asset" entityId={asset.assetNumber} />}

      <EditAssetModal key={asset.updatedAt} open={editOpen} onClose={() => setEditOpen(false)} asset={asset} categories={categories} locked={locked} disposed={disposed} />
      <DisposeModal open={disposeOpen} onClose={() => setDisposeOpen(false)} asset={asset} accounts={accounts} />
    </div>
  );
}

function EditAssetModal({
  open,
  onClose,
  asset,
  categories,
  locked,
  disposed,
}: {
  open: boolean;
  onClose: () => void;
  asset: FixedAssetDetail;
  categories: FixedAssetCategory[];
  locked: boolean;
  disposed: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: asset.name,
    note: asset.note ?? "",
    categoryId: asset.categoryId,
    acquisitionDate: asset.acquisitionDate,
    acquisitionCost: asset.acquisitionCost,
    residualValue: asset.residualValue,
    usefulLifeMonths: String(asset.usefulLifeMonths),
    depreciationStartMonth: asset.depreciationStartMonth.slice(0, 7),
    openingDepreciation: String(Number(asset.openingDepreciation)),
    openingDepreciationThroughMonth: asset.openingDepreciationThroughMonth?.slice(0, 7) ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { note: form.note || null };
      if (!disposed) {
        Object.assign(payload, { name: form.name, residualValue: form.residualValue, usefulLifeMonths: form.usefulLifeMonths });
        if (!locked) {
          Object.assign(payload, {
            categoryId: form.categoryId,
            acquisitionDate: form.acquisitionDate,
            acquisitionCost: form.acquisitionCost,
            depreciationStartMonth: form.depreciationStartMonth,
            openingDepreciation: form.openingDepreciation || "0",
            openingDepreciationThroughMonth: form.openingDepreciationThroughMonth || null,
          });
        }
      }
      await apiFetch<FixedAssetDetail>(`/api/v1/fixed-assets/${asset.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      router.refresh();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara anläggningen"));
    } finally {
      setSaving(false);
    }
  }

  const lockedHint = "Låst — avskrivning är bokförd";

  return (
    <Modal open={open} onClose={onClose} title={`Redigera ${asset.assetNumber}`}>
      <Form onSubmit={submit}>
        <FormRow>
          <Field label="Benämning" htmlFor="edit-name">
            <Input id="edit-name" value={form.name} disabled={disposed} onChange={(e) => set({ name: e.target.value })} required maxLength={200} />
          </Field>
          <Field label="Grupp" htmlFor="edit-category">
            <Select id="edit-category" value={form.categoryId} disabled={locked || disposed} onChange={(e) => set({ categoryId: e.target.value })}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Anskaffningsdatum" htmlFor="edit-date">
            <Input id="edit-date" type="date" value={form.acquisitionDate} disabled={locked || disposed} onChange={(e) => set({ acquisitionDate: e.target.value })} />
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
          <Field label="Avskrivningsstart" htmlFor="edit-start">
            <Input id="edit-start" type="month" value={form.depreciationStartMonth} disabled={locked || disposed} onChange={(e) => set({ depreciationStartMonth: e.target.value })} />
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Anskaffningsvärde" htmlFor="edit-cost">
            <Input id="edit-cost" type="number" step="0.01" min="0" value={form.acquisitionCost} disabled={locked || disposed} onChange={(e) => set({ acquisitionCost: e.target.value })} />
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
          <Field label="Restvärde" htmlFor="edit-residual">
            <Input id="edit-residual" type="number" step="0.01" min="0" value={form.residualValue} disabled={disposed} onChange={(e) => set({ residualValue: e.target.value })} />
          </Field>
          <Field label="Nyttjandetid (månader)" htmlFor="edit-life">
            <Input id="edit-life" type="number" min="0" step="any" value={form.usefulLifeMonths} disabled={disposed} onChange={(e) => set({ usefulLifeMonths: e.target.value })} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Ingående avskrivning" htmlFor="edit-opening">
            <Input id="edit-opening" type="number" step="0.01" min="0" value={form.openingDepreciation} disabled={locked || disposed} onChange={(e) => set({ openingDepreciation: e.target.value })} />
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
          <Field label="Avskriven t.o.m. månad" htmlFor="edit-opening-month">
            <Input id="edit-opening-month" type="month" value={form.openingDepreciationThroughMonth} disabled={locked || disposed} onChange={(e) => set({ openingDepreciationThroughMonth: e.target.value })} />
            {locked && <FormHint attached>{lockedHint}</FormHint>}
          </Field>
        </FormRow>
        {locked && !disposed && <FormHint>Ändras nyttjandetid eller restvärde fördelas det återstående underlaget jämnt på de återstående månaderna. Bokförda avskrivningar ändras aldrig.</FormHint>}
        <FormRow>
          <Field label="Anteckning" htmlFor="edit-note">
            <Textarea id="edit-note" value={form.note} onChange={(e) => set({ note: e.target.value })} rows={2} />
          </Field>
        </FormRow>
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

function DisposeModal({ open, onClose, asset, accounts }: { open: boolean; onClose: () => void; asset: FixedAssetDetail; accounts: Account[] }) {
  const router = useRouter();
  const [disposalType, setDisposalType] = useState<"sale" | "scrap">("sale");
  const [disposalDate, setDisposalDate] = useState(stockholmToday());
  const [disposalPrice, setDisposalPrice] = useState("");
  const [intermediateAccountId, setIntermediateAccountId] = useState(asset.category.disposalGainAccountId);
  const [preview, setPreview] = useState<DisposalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function query() {
    const params = new URLSearchParams({ disposalType, disposalDate });
    if (disposalType === "sale") {
      params.set("disposalPrice", disposalPrice || "0");
      params.set("intermediateAccountId", intermediateAccountId);
    }
    return params.toString();
  }

  async function showPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await apiFetch<DisposalPreview>(`/api/v1/fixed-assets/${asset.id}/disposal-preview?${query()}`));
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta konteringen"));
    } finally {
      setBusy(false);
    }
  }

  async function dispose() {
    setBusy(true);
    setError(null);
    try {
      const body = disposalType === "sale" ? { disposalType, disposalDate, disposalPrice: disposalPrice || "0", intermediateAccountId } : { disposalType, disposalDate };
      await apiFetch<DisposalResult>(`/api/v1/fixed-assets/${asset.id}/dispose`, { method: "POST", body: JSON.stringify(body) });
      router.refresh();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte bokföra avyttringen"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Avyttra ${asset.assetNumber}`} wide>
      <Form onSubmit={showPreview}>
        <FormRow>
          <Field label="Typ" htmlFor="dispose-type">
            <Select
              id="dispose-type"
              value={disposalType}
              onChange={(e) => {
                setDisposalType(e.target.value as "sale" | "scrap");
                setPreview(null);
              }}
            >
              <option value="sale">Försäljning</option>
              <option value="scrap">Utrangering</option>
            </Select>
          </Field>
          <Field label="Datum" htmlFor="dispose-date">
            <Input id="dispose-date" type="date" value={disposalDate} min={asset.acquisitionDate} max={stockholmToday()} onChange={(e) => { setDisposalDate(e.target.value); setPreview(null); }} required />
          </Field>
        </FormRow>
        {disposalType === "sale" && (
          <FormRow>
            <Field label="Försäljningspris exkl. moms" htmlFor="dispose-price">
              <Input id="dispose-price" type="number" step="0.01" min="0" value={disposalPrice} onChange={(e) => { setDisposalPrice(e.target.value); setPreview(null); }} required />
            </Field>
            <Field label="Mellankonto" htmlFor="dispose-account">
              <Select id="dispose-account" value={intermediateAccountId} onChange={(e) => { setIntermediateAccountId(e.target.value); setPreview(null); }} required>
                {accounts.filter((account) => account.active).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.number} {account.name}
                  </option>
                ))}
              </Select>
              <FormHint attached>Kundfakturans intäktsrad ska konteras på samma konto.</FormHint>
            </Field>
          </FormRow>
        )}
        <FormError>{error}</FormError>
        {preview && (
          <>
            {preview.warnings.includes("intermediate-account-not-box-05") && (
              <FormError margin="below">Mellankontot saknar momsruta 05 — försäljningen kommer inte med i ruta 05 i momsrapporten</FormError>
            )}
            <p>
              {preview.catchUpMonths.length > 0 ? `Avskrivning ${preview.catchUpMonths.map((row) => monthLabel(row.month)).join(", ")} bokförs först (${formatMoney(preview.catchUpMonths.reduce((sum, row) => sum + row.amount, 0))}). ` : ""}
              Ack. avskrivning {formatMoney(preview.accumulatedDepreciation)}, bokfört värde <strong>{formatMoney(preview.bookValue)}</strong>
              {preview.gain > 0 && <>, vinst <strong>{formatMoney(preview.gain)}</strong></>}
              {preview.loss > 0 && <>, förlust <strong>{formatMoney(preview.loss)}</strong></>}.
            </p>
            <Table
              columns={[
                { key: "account", label: "Konto", width: "2fr" },
                { key: "debit", label: "Debet", width: "1fr", align: "right" as const },
                { key: "credit", label: "Kredit", width: "1fr", align: "right" as const },
              ]}
              rows={preview.rows.map((row, index) => ({ ...row, id: `${index}-${row.accountNumber}` }))}
              renderCell={(row, key) =>
                key === "account" ? `${row.accountNumber} ${row.accountName}` : key === "debit" ? (row.debit ? formatMoney(row.debit) : "") : row.credit ? formatMoney(row.credit) : ""
              }
            />
          </>
        )}
        <FormActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          {preview ? (
            <Button type="button" disabled={busy} onClick={dispose}>
              {busy ? "Bokför…" : "Bokför avyttring"}
            </Button>
          ) : (
            <Button type="submit" disabled={busy}>
              {busy ? "Hämtar…" : "Visa kontering"}
            </Button>
          )}
        </FormActions>
      </Form>
    </Modal>
  );
}

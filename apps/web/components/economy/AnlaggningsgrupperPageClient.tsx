"use client";

import { confirmDelete } from "../../lib/confirm";
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Account, FixedAssetCategory } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

// `posting`: the three accounts the group's depreciation sits on — locked
// (disabled in the edit dialog) once the group has booked or opening
// depreciation; gain/loss stay editable.
const ACCOUNT_FIELDS = [
  { key: "assetAccountId", role: "asset", label: "Tillgångskonto", posting: true },
  { key: "accumulatedDepreciationAccountId", role: "accumulated", label: "Ack. avskrivningar", posting: true },
  { key: "depreciationExpenseAccountId", role: "expense", label: "Avskrivningskostnad", posting: true },
  { key: "disposalGainAccountId", role: "gain", label: "Vinst vid avyttring", posting: false },
  { key: "disposalLossAccountId", role: "loss", label: "Förlust vid avyttring", posting: false },
] as const;

type AccountKey = (typeof ACCOUNT_FIELDS)[number]["key"];

// Same safety net as Konteringsregler's accountIdOptions: an account that
// was deactivated after being chosen stays selectable as "(inaktivt konto)"
// instead of silently jumping the select to another account.
function accountOptions(accounts: Account[], currentId: string, currentLabel: string | null): ReactNode {
  const hasCurrent = currentId === "" || accounts.some((account) => account.id === currentId);
  return (
    <>
      <option value="">Välj konto…</option>
      {!hasCurrent && currentLabel && <option value={currentId}>{currentLabel} (inaktivt konto)</option>}
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.number} {account.name}
        </option>
      ))}
    </>
  );
}

export function AnlaggningsgrupperPageClient({ categories, accounts }: { categories: FixedAssetCategory[]; accounts: Account[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<FixedAssetCategory | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function seed() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiFetch<{ created: string[]; skipped: string[] }>("/api/v1/fixed-asset-categories/generate-bas", { method: "POST" });
      setNotice(
        result.created.length === 0
          ? "Alla BAS-grupper fanns redan"
          : `${result.created.length} grupper skapade${result.skipped.length > 0 ? `, ${result.skipped.length} fanns redan` : ""}`
      );
      router.refresh();
    } catch (err) {
      setNotice(apiErrorMessage(err, "Kunde inte förifylla"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(category: FixedAssetCategory) {
    if (!(await confirmDelete(`Ta bort gruppen ${category.name}?`))) return;
    setNotice(null);
    try {
      await apiFetch<void>(`/api/v1/fixed-asset-categories/${category.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setNotice(apiErrorMessage(err, "Kunde inte ta bort gruppen"));
    }
  }

  const columns = [
    { key: "name", label: "Namn", width: "2fr" },
    { key: "asset", label: "Tillgångskonto", width: "1fr" },
    { key: "accumulated", label: "Ack. avskr.", width: "1fr" },
    { key: "expense", label: "Kostnadskonto", width: "1fr" },
    { key: "gain", label: "Vinst", width: "0.7fr" },
    { key: "loss", label: "Förlust", width: "0.7fr" },
    { key: "life", label: "Nyttjandetid", width: "0.8fr", align: "right" as const },
    { key: "count", label: "Anläggningar", width: "0.8fr", align: "right" as const },
    { key: "actions", label: "", width: "120px", align: "right" as const },
  ];

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Anläggningsgrupper</div>
          <div className={shellStyles.meta}>{categories.length.toLocaleString("sv-SE")} grupper</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {notice && <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{notice}</span>}
          <Button type="button" variant="secondary" disabled={busy} onClick={seed}>
            {busy ? "Förifyller…" : "Förifyll BAS-grupper"}
          </Button>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Ny grupp
          </Button>
          <HelpLink chapter="ekonomi" anchor="anlaggningsgrupper" label="Hjälp om anläggningsgrupper" />
        </div>
      </div>

      <Table
        columns={columns}
        rows={categories}
        emptyText="Inga grupper ännu — använd Förifyll BAS-grupper eller skapa en."
        renderCell={(category, key) => {
          switch (key) {
            case "name":
              return (
                <button type="button" onClick={() => setEditing(category)} style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}>
                  {category.name}
                </button>
              );
            case "asset":
            case "accumulated":
            case "expense":
            case "gain":
            case "loss":
              return `${category.accounts[key].number} ${category.accounts[key].name}`;
            case "life":
              return `${category.defaultUsefulLifeMonths} mån`;
            case "count":
              return category.assetCount.toLocaleString("sv-SE");
            case "actions":
              return (
                <Button type="button" variant="ghost" size="small" disabled={category.assetCount > 0} onClick={() => remove(category)}>
                  Ta bort
                </Button>
              );
            default:
              return null;
          }
        }}
      />

      <CategoryModal open={createOpen} onClose={() => setCreateOpen(false)} accounts={accounts} category={null} />
      <CategoryModal key={editing?.id ?? "none"} open={editing !== null} onClose={() => setEditing(null)} accounts={accounts} category={editing} />
    </>
  );
}

function CategoryModal({
  open,
  onClose,
  accounts,
  category,
}: {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  category: FixedAssetCategory | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const accountsLocked = category?.postingAccountsLocked ?? false;
  const [name, setName] = useState(category?.name ?? "");
  const [life, setLife] = useState(String(category?.defaultUsefulLifeMonths ?? 60));
  const [accountIds, setAccountIds] = useState<Record<AccountKey, string>>({
    assetAccountId: category?.assetAccountId ?? "",
    accumulatedDepreciationAccountId: category?.accumulatedDepreciationAccountId ?? "",
    depreciationExpenseAccountId: category?.depreciationExpenseAccountId ?? "",
    disposalGainAccountId: category?.disposalGainAccountId ?? "",
    disposalLossAccountId: category?.disposalLossAccountId ?? "",
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { name, defaultUsefulLifeMonths: life, ...accountIds };
      if (category) {
        await apiFetch<FixedAssetCategory>(`/api/v1/fixed-asset-categories/${category.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch<FixedAssetCategory>("/api/v1/fixed-asset-categories", { method: "POST", body: JSON.stringify(payload) });
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara gruppen"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={category ? `Redigera ${category.name}` : "Ny anläggningsgrupp"}>
      <Form onSubmit={submit}>
        <FormRow>
          <Field label="Namn" htmlFor="category-name">
            <Input id="category-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </Field>
          <Field label="Förvald nyttjandetid (månader)" htmlFor="category-life">
            <Input id="category-life" type="number" min="0" step="any" value={life} onChange={(e) => setLife(e.target.value)} required />
          </Field>
        </FormRow>
        {ACCOUNT_FIELDS.map((field) => (
          <FormRow key={field.key}>
            <Field label={field.label} htmlFor={`category-${field.key}`}>
              <Select
                id={`category-${field.key}`}
                value={accountIds[field.key]}
                onChange={(e) => setAccountIds({ ...accountIds, [field.key]: e.target.value })}
                disabled={field.posting && accountsLocked}
                required
              >
                {accountOptions(
                  accounts,
                  accountIds[field.key],
                  category ? `${category.accounts[field.role].number} ${category.accounts[field.role].name}` : null
                )}
              </Select>
            </Field>
          </FormRow>
        ))}
        {accountsLocked && (
          <FormHint>Tillgångskonto, ack-konto och kostnadskonto är låsta — gruppen har bokförd eller ingående avskrivning på de kontona. Vinst- och förlustkonto, namn och nyttjandetid kan ändras.</FormHint>
        )}
        <FormHint>Tillgångskonto, ack-konto och kostnadskonto måste vara tre olika konton. Vinst- och förlustkontot får vara samma konto.</FormHint>
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

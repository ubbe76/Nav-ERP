"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination } from "../ui/ListControls";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Account, Paged } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { VAT_BOXES, VAT_BOX_LABELS, vatBoxLabel, type VatBoxSetting } from "../../lib/vatBoxes";

const rowLinkStyle = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
} as const;

// DuplicateAccountNumberError translated to fixed Swedish copy by the shared
// error-code dictionary — same idiom as payroll's formatPayrollError.
function formatAccountError(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte spara kontot");
}

export function KontoplanPageClient({ accounts, pageSize }: { accounts: Paged<Account>; pageSize: number }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [seedNotice, setSeedNotice] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  async function runSeed() {
    setSeeding(true);
    setSeedNotice(null);
    try {
      const result = await apiFetch<{ created: number; skipped: number }>("/api/v1/accounts/generate-bas", {
        method: "POST",
      });
      setSeedNotice(
        result.created === 0
          ? "Alla poster fanns redan"
          : `${result.created} skapade${result.skipped > 0 ? `, ${result.skipped} fanns redan` : ""}`
      );
      router.refresh();
    } catch (err) {
      setSeedNotice(err instanceof Error ? err.message : "Kunde inte förifylla");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Kontoplan</div>
          <div className={shellStyles.meta}>{accounts.total.toLocaleString("sv-SE")} konton</div>
        </div>
        <div className={shellStyles.topbarActions}>
          {seedNotice && (
            <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--color-text-secondary)" }}>
              {seedNotice}
            </span>
          )}
          <Button type="button" variant="secondary" disabled={seeding} onClick={runSeed}>
            {seeding ? "Förifyller…" : "Förifyll BAS-urval"}
          </Button>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            + Nytt konto
          </Button>
          <HelpLink chapter="ekonomi" anchor="kontoplan" label="Hjälp om kontoplanen" />
        </div>
      </div>

      <ListToolbar placeholder="Sök kontonummer eller namn…">
        <ListFilterSelect
          param="includeInactive"
          allLabel="Endast aktiva"
          ariaLabel="Filtrera på status"
          options={[{ value: "true", label: "Visa alla (inkl. inaktiva)" }]}
        />
        <ListExportLink endpoint="/api/v1/accounts/csv" />
      </ListToolbar>

      <Table<Account>
        columns={[
          { key: "number", label: "Nummer", width: "140px" },
          { key: "name", label: "Namn", width: "1fr" },
          { key: "vatBox", label: "Momsruta", width: "220px" },
          { key: "costCenter", label: "Kräver kostnadsställe", width: "130px" },
          { key: "active", label: "Status", width: "120px" },
        ]}
        rows={accounts.rows}
        emptyText="Inga konton matchar sökningen"
        renderCell={(account, key) => {
          switch (key) {
            case "number":
              return (
                <button type="button" onClick={() => setEditing(account)} style={rowLinkStyle}>
                  <span className="num">{account.number}</span>
                </button>
              );
            case "name":
              return (
                <button type="button" onClick={() => setEditing(account)} style={rowLinkStyle}>
                  <strong>{account.name}</strong>
                </button>
              );
            case "vatBox":
              if (account.vatBox !== null) return vatBoxLabel(account.vatBox);
              // Only revenue (3xxx) and VAT (26xx) accounts are checked by the
              // VAT report — elsewhere an unset box is not worth a label.
              return (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {account.number.startsWith("3") || account.number.startsWith("26") ? vatBoxLabel(null) : "—"}
                </span>
              );
            case "costCenter":
              return account.costCenterRequired ? "Ja" : <span style={{ color: "var(--color-text-muted)" }}>—</span>;
            case "active":
              return account.active ? (
                <StatusPill status="running" label="Aktiv" compact />
              ) : (
                <StatusPill status="draft" label="Inaktiv" compact />
              );
            default:
              return null;
          }
        }}
      />

      <Pagination total={accounts.total} pageSize={pageSize} />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nytt konto">
        <AccountForm
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.number} · ${editing.name}` : ""}
      >
        {editing && (
          <AccountForm
            account={editing}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

// number is immutable once created (updateAccountSchema has no `number`
// field) — the input is disabled on edit rather than omitted, so the
// existing value stays visible.
function AccountForm({ account, onDone }: { account?: Account; onDone: () => void }) {
  const [number, setNumber] = useState(account?.number ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [active, setActive] = useState(account?.active ?? true);
  // "default" is a form-only value (omitted from the POST so the server
  // applies the BAS default); "" = Ej angiven (null).
  const [vatBox, setVatBox] = useState<string>(account ? (account.vatBox ?? "") : "default");
  const [costCenterRequired, setCostCenterRequired] = useState(account?.costCenterRequired ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const vatBoxPayload: VatBoxSetting | null = vatBox === "" ? null : (vatBox as VatBoxSetting);
      if (account) {
        await apiFetch(`/api/v1/accounts/${account.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, active, vatBox: vatBoxPayload, costCenterRequired }),
        });
      } else {
        await apiFetch("/api/v1/accounts", {
          method: "POST",
          body: JSON.stringify({
            number,
            name,
            ...(vatBox === "default" ? {} : { vatBox: vatBoxPayload }),
            ...(costCenterRequired ? { costCenterRequired: true } : {}),
          }),
        });
      }
      onDone();
    } catch (err) {
      setError(formatAccountError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Nummer (4 siffror)" htmlFor="accountNumber">
          <Input
            id="accountNumber"
            required
            disabled={!!account}
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            title="Exakt 4 siffror"
            size="xs"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Field label="Aktiv" htmlFor="accountActive">
          {account ? (
            <Toggle id="accountActive" checked={active} onChange={(e) => setActive(e.target.checked)} />
          ) : (
            // New accounts always start active — createAccountSchema takes no
            // `active` field, so this is a fixed, disabled indicator.
            <Toggle id="accountActive" checked disabled />
          )}
        </Field>
      </FormRow>

      <Field label="Namn" htmlFor="accountName">
        <Input id="accountName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Momsruta" htmlFor="accountVatBox">
        <Select id="accountVatBox" value={vatBox} onChange={(e) => setVatBox(e.target.value)}>
          {!account && <option value="default">Förval enligt BAS</option>}
          <option value="">Ej angiven</option>
          <option value="none">Ingen ruta</option>
          {VAT_BOXES.map((box) => (
            <option key={box} value={box}>
              {box} · {VAT_BOX_LABELS[box]}
            </option>
          ))}
        </Select>
      </Field>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Checkbox checked={costCenterRequired} onChange={(e) => setCostCenterRequired(e.target.checked)} />
        Kräver kostnadsställe
      </label>
      <FormHint>
        En bokning på kontot utan kostnadsställe vägras i manuella verifikat. Automatiskt konterade verifikat bokas ändå, med en
        varning på verifikatet och i Aviseringar.
      </FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : account ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}

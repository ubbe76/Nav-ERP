"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormStack } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import type { Account, BankAccount } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

// Ekonomi → Bankkonton: the register of the company's bank accounts. A
// kontoutdrag is matched to its account by the identifier (IBAN or account
// number); the huvudbokskonto is the ledger account the reconciliation reads.
export function BankkontonPageClient({ bankAccounts, accounts }: { bankAccounts: BankAccount[]; accounts: Account[] }) {
  const router = useRouter();
  // null = the list, "new" = the empty form, otherwise the account edited.
  const [editing, setEditing] = useState<BankAccount | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function toggleActive(account: BankAccount) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/bank-accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !account.active }),
      });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Bankkonton</div>
          <div className={shellStyles.meta}>{bankAccounts.length} bankkonton</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" disabled={editing !== null} onClick={() => setEditing("new")}>
            + Nytt bankkonto
          </Button>
          <HelpLink chapter="ekonomi" anchor="bankkonton" label="Hjälp om bankkonton" />
        </div>
      </div>

      <FormError>{error}</FormError>

      {editing !== null && (
        <BankAccountForm
          key={editing === "new" ? "new" : editing.id}
          bankAccount={editing === "new" ? null : editing}
          accounts={accounts}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <Table<BankAccount>
        columns={[
          { key: "name", label: "Namn", width: "1.1fr" },
          { key: "identifier", label: "IBAN / kontonummer", width: "1.3fr" },
          { key: "ledger", label: "Huvudbokskonto", width: "1.2fr" },
          { key: "reconciled", label: "Avstämd t.o.m.", width: "120px" },
          { key: "statement", label: "Senaste kontoutdrag", width: "130px" },
          { key: "unmatched", label: "Omatchade", width: "90px", align: "right" },
          { key: "status", label: "Status", width: "90px" },
          { key: "id", label: "", width: "260px", align: "right" },
        ]}
        rows={bankAccounts}
        emptyText="Det finns inga bankkonton än"
        renderCell={(a, key) => {
          switch (key) {
            case "name":
              return a.name;
            case "identifier":
              return a.identifier;
            case "ledger":
              return a.ledgerAccountName ? `${a.ledgerAccount} · ${a.ledgerAccountName}` : a.ledgerAccount;
            case "reconciled":
              return a.reconciledThrough ?? "–";
            case "statement":
              return a.lastStatementDate ?? "–";
            case "unmatched":
              return a.unmatchedCount;
            case "status":
              return <StatusPill status={a.active ? "running" : "draft"} label={a.active ? "Aktivt" : "Inaktivt"} compact />;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Link
                    href={`/ekonomi/bankavstamning?account=${a.id}`}
                    style={{ alignSelf: "center" }}
                    aria-label={`Stäm av ${a.name}`}
                  >
                    Stäm av
                  </Link>
                  <Button type="button" size="small" variant="ghost" disabled={editing !== null} onClick={() => setEditing(a)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void toggleActive(a)}>
                    {a.active ? "Inaktivera" : "Aktivera"}
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />
    </>
  );
}

function BankAccountForm({
  bankAccount,
  accounts,
  onDone,
  onCancel,
}: {
  bankAccount: BankAccount | null;
  accounts: Account[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(bankAccount?.name ?? "");
  const [identifier, setIdentifier] = useState(bankAccount?.identifier ?? "");
  const [ledgerAccount, setLedgerAccount] = useState(bankAccount?.ledgerAccount ?? "");
  const [active, setActive] = useState(bankAccount?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const dirty =
    !done &&
    (name !== (bankAccount?.name ?? "") ||
      identifier !== (bankAccount?.identifier ?? "") ||
      ledgerAccount !== (bankAccount?.ledgerAccount ?? "") ||
      active !== (bankAccount?.active ?? true));
  useUnsavedGuard(dirty);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (name.trim() === "") return setError("Ange ett namn.");
    if (identifier.trim() === "") return setError("Ange IBAN eller kontonummer.");
    if (!accounts.some((a) => a.number === ledgerAccount.trim())) {
      return setError(`Huvudbokskonto ${ledgerAccount.trim() || "saknas"} finns inte eller är inaktivt — välj ett konto ur kontoplanen.`);
    }
    setError(null);
    setPending(true);
    try {
      const payload = { name: name.trim(), identifier: identifier.trim(), ledgerAccount: ledgerAccount.trim() };
      if (bankAccount) {
        await apiFetch(`/api/v1/bank-accounts/${bankAccount.id}`, { method: "PATCH", body: JSON.stringify({ ...payload, active }) });
      } else {
        await apiFetch("/api/v1/bank-accounts", { method: "POST", body: JSON.stringify(payload) });
      }
      setDone(true);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Bankkontot kunde inte sparas"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} style={{ marginBottom: 24 }}>
      <Card maxWidth={560}>
        <FormStack>
          <strong>{bankAccount ? `Ändra ${bankAccount.name}` : "Nytt bankkonto"}</strong>
          <FormError>{error}</FormError>
          <Field label="Namn" htmlFor="bankAccountName">
            <Input id="bankAccountName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="IBAN eller kontonummer" htmlFor="bankAccountIdentifier">
            <Input
              id="bankAccountIdentifier"
              required
              maxLength={60}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </Field>
          <FormHint attached>
            Kontoutdraget känns igen på det här numret. Mellanslag och bindestreck spelar ingen roll.
          </FormHint>
          <Field label="Huvudbokskonto" htmlFor="bankAccountLedger">
            <Input
              id="bankAccountLedger"
              required
              list="bankAccountLedgerOptions"
              inputMode="numeric"
              maxLength={10}
              size="sm"
              value={ledgerAccount}
              onChange={(e) => setLedgerAccount(e.target.value)}
            />
          </Field>
          <datalist id="bankAccountLedgerOptions">
            {accounts.map((a) => (
              <option key={a.id} value={a.number}>
                {a.name}
              </option>
            ))}
          </datalist>
          {bankAccount && (
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Aktivt
            </label>
          )}
        </FormStack>
      </Card>
      <FormActions style={{ marginTop: 16 }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </form>
  );
}

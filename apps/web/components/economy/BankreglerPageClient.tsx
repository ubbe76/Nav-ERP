"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { confirmDelete } from "../../lib/confirm";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { BANK_RULE_DIRECTION_LABELS } from "../../lib/bankReconciliation";
import { splitVatApplies } from "../../lib/splitVat";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { useVatCodes } from "../../lib/useVatCodes";
import { vatCodeOptionLabel } from "../../lib/vatCodes";
import type { Account, BankRule, BankRuleDirection } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

// Ekonomi → Bankregler: recognises recurring entries on the kontoutdrag by
// their text and suggests the counter account (and Momskod) when the entry is
// booked. A rule with Bokför direkt books unambiguous entries at import.
export function BankreglerPageClient({ rules, accounts }: { rules: BankRule[]; accounts: Account[] }) {
  const router = useRouter();
  // null = the list, "new" = the empty form, otherwise the rule edited.
  const [editing, setEditing] = useState<BankRule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function toggleActive(rule: BankRule) {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/bank-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ active: !rule.active }) });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Åtgärden misslyckades"));
    } finally {
      setPending(false);
    }
  }

  async function remove(rule: BankRule) {
    if (!(await confirmDelete(`Ta bort regeln för "${rule.textContains}"?`))) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/bank-rules/${rule.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Regeln kunde inte tas bort"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Bankregler</div>
          <div className={shellStyles.meta}>{rules.length} regler</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="primary" disabled={editing !== null} onClick={() => setEditing("new")}>
            + Ny regel
          </Button>
          <HelpLink chapter="ekonomi" anchor="bankregler" label="Hjälp om bankregler" />
        </div>
      </div>

      <FormError>{error}</FormError>

      {editing !== null && (
        <RuleForm
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          accounts={accounts}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <Table<BankRule>
        columns={[
          { key: "text", label: "Texten innehåller", width: "1.2fr" },
          { key: "direction", label: "Riktning", width: "80px" },
          { key: "account", label: "Konto", width: "1.2fr" },
          { key: "vat", label: "Momskod", width: "90px" },
          { key: "description", label: "Beskrivning", width: "1.2fr" },
          { key: "autoBook", label: "Bokför direkt", width: "100px" },
          { key: "status", label: "Status", width: "90px" },
          { key: "id", label: "", width: "250px", align: "right" },
        ]}
        rows={rules}
        emptyText="Det finns inga bankregler än"
        renderCell={(r, key) => {
          switch (key) {
            case "text":
              return r.textContains;
            case "direction":
              return BANK_RULE_DIRECTION_LABELS[r.direction];
            case "account":
              return r.accountName ? `${r.accountNumber} · ${r.accountName}` : r.accountNumber;
            case "vat":
              return r.vatCode ?? "–";
            case "description":
              return r.description ?? "–";
            case "autoBook":
              return r.autoBook ? "Ja" : "Nej";
            case "status":
              return <StatusPill status={r.active ? "running" : "draft"} label={r.active ? "Aktiv" : "Inaktiv"} compact />;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Button type="button" size="small" variant="ghost" disabled={editing !== null} onClick={() => setEditing(r)}>
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void toggleActive(r)}>
                    {r.active ? "Inaktivera" : "Aktivera"}
                  </Button>
                  <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => void remove(r)}>
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
  );
}

function RuleForm({
  rule,
  accounts,
  onDone,
  onCancel,
}: {
  rule: BankRule | null;
  accounts: Account[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { codes: vatCodes } = useVatCodes();
  const [textContains, setTextContains] = useState(rule?.textContains ?? "");
  const [direction, setDirection] = useState<BankRuleDirection>(rule?.direction ?? "both");
  const [accountNumber, setAccountNumber] = useState(rule?.accountNumber ?? "");
  const [vatCode, setVatCode] = useState(rule?.vatCode ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [autoBook, setAutoBook] = useState(rule?.autoBook ?? false);
  const [active, setActive] = useState(rule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const dirty =
    !done &&
    (textContains !== (rule?.textContains ?? "") ||
      direction !== (rule?.direction ?? "both") ||
      accountNumber !== (rule?.accountNumber ?? "") ||
      vatCode !== (rule?.vatCode ?? "") ||
      description !== (rule?.description ?? "") ||
      autoBook !== (rule?.autoBook ?? false) ||
      active !== (rule?.active ?? true));
  useUnsavedGuard(dirty);

  // The codes a bank entry can carry VAT under (the same set the Momskod cell
  // of the verification table splits), plus the rule's own code when it is no
  // longer offered so that saving never changes it silently.
  const options = vatCodes.filter((c) => (c.active && splitVatApplies(c)) || c.code === rule?.vatCode);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (textContains.trim() === "") return setError("Ange texten som ska finnas i posten.");
    if (!accounts.some((a) => a.number === accountNumber.trim())) {
      return setError(`Konto ${accountNumber.trim() || "saknas"} finns inte eller är inaktivt — välj ett konto ur kontoplanen.`);
    }
    setError(null);
    setPending(true);
    try {
      const payload = {
        textContains: textContains.trim(),
        direction,
        accountNumber: accountNumber.trim(),
        vatCode: vatCode || null,
        description: description.trim() || null,
        autoBook,
        active,
      };
      if (rule) {
        await apiFetch(`/api/v1/bank-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/api/v1/bank-rules", { method: "POST", body: JSON.stringify(payload) });
      }
      setDone(true);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Regeln kunde inte sparas"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} style={{ marginBottom: 24 }}>
      <Card maxWidth={600}>
        <FormStack>
          <strong>{rule ? `Ändra regeln för "${rule.textContains}"` : "Ny regel"}</strong>
          <FormError>{error}</FormError>
          <Field label="Texten innehåller" htmlFor="bankRuleText">
            <Input id="bankRuleText" required maxLength={100} value={textContains} onChange={(e) => setTextContains(e.target.value)} />
          </Field>
          <FormHint attached>Skiftläge spelar ingen roll.</FormHint>
          <FormRow>
            <Field label="Riktning" htmlFor="bankRuleDirection">
              <Select id="bankRuleDirection" value={direction} onChange={(e) => setDirection(e.target.value as BankRuleDirection)}>
                <option value="in">In — inbetalningar</option>
                <option value="out">Ut — utbetalningar</option>
                <option value="both">Båda</option>
              </Select>
            </Field>
            <Field label="Konto" htmlFor="bankRuleAccount">
              <Input
                id="bankRuleAccount"
                required
                list="bankRuleAccountOptions"
                inputMode="numeric"
                maxLength={10}
                size="sm"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
              />
            </Field>
          </FormRow>
          <datalist id="bankRuleAccountOptions">
            {accounts.map((a) => (
              <option key={a.id} value={a.number}>
                {a.name}
              </option>
            ))}
          </datalist>
          <Field label="Momskod" htmlFor="bankRuleVatCode">
            <Select id="bankRuleVatCode" value={vatCode} onChange={(e) => setVatCode(e.target.value)}>
              <option value="">— Ingen moms —</option>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {vatCodeOptionLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <FormHint attached>Med en momskod tolkas beloppet på posten som inklusive moms och momsraden läggs till vid bokföringen.</FormHint>
          <Field label="Beskrivning" htmlFor="bankRuleDescription">
            <Input
              id="bankRuleDescription"
              maxLength={255}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <FormHint attached>Texten på kontoradens beskrivning i verifikatet. Lämnas den tom används texten från kontoutdraget.</FormHint>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Checkbox checked={autoBook} onChange={(e) => setAutoBook(e.target.checked)} />
            Bokför direkt
          </label>
          <FormHint attached>
            Poster som regeln träffar bokförs direkt när kontoutdraget importeras. Det gäller bara när regeln är entydig — träffar
            flera regler samma post, eller är kontot inaktivt, lämnas posten till dig.
          </FormHint>
          {rule && (
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Aktiv
            </label>
          )}
        </FormStack>
      </Card>
      <FormActions style={{ marginTop: 16 }}>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara regel"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Avbryt
        </Button>
      </FormActions>
    </form>
  );
}

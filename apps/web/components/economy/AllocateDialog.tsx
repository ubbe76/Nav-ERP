"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { allocationAmounts, allocationMonths } from "../../lib/allocation";
import { formatMoney } from "../../lib/format";
import type { Account, Paged, RecurringVerification } from "../../lib/types";

type Kind = "cost" | "revenue";

const DEFAULT_BALANCE_ACCOUNT: Record<Kind, string> = { cost: "1790", revenue: "2990" };

function currentMonth(): string {
  return new Date().toLocaleDateString("sv-SE").slice(0, 7);
}

// Fördela över perioder: one amount spread over several months as a recurring
// post of its own (POST /recurring-verifications/allocation). Each month moves
// amount / months from the balance account to the result account; the last
// month takes the öre remainder — the preview mirrors the server's arithmetic.
export function AllocateDialog({
  open,
  onClose,
  sourceVerificationId,
  defaultDescription = "",
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  // Set when opened from a booked verification.
  sourceVerificationId?: string;
  defaultDescription?: string;
  // Called with the new post; default is to open Återkommande verifikat.
  onCreated?: (created: RecurringVerification) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Fördela över perioder">
      <AllocateForm
        sourceVerificationId={sourceVerificationId}
        defaultDescription={defaultDescription}
        onCreated={onCreated}
      />
    </Modal>
  );
}

function AllocateForm({
  sourceVerificationId,
  defaultDescription,
  onCreated,
}: {
  sourceVerificationId?: string;
  defaultDescription: string;
  onCreated?: (created: RecurringVerification) => void;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<Kind>("cost");
  const [balanceAccount, setBalanceAccount] = useState(DEFAULT_BALANCE_ACCOUNT.cost);
  const [balanceTouched, setBalanceTouched] = useState(false);
  const [resultAccount, setResultAccount] = useState("");
  const [firstMonth, setFirstMonth] = useState(currentMonth);
  const [months, setMonths] = useState("12");
  const [description, setDescription] = useState(defaultDescription.slice(0, 200));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Paged<Account>>("/api/v1/accounts?limit=1000")
      .then((page) => {
        if (!cancelled) setAccounts(page.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function changeKind(next: Kind) {
    setKind(next);
    if (!balanceTouched) setBalanceAccount(DEFAULT_BALANCE_ACCOUNT[next]);
  }

  const amountNumber = Number(amount);
  const monthCount = Number(months);
  const validPreview =
    amountNumber > 0 && Number.isInteger(monthCount) && monthCount >= 2 && monthCount <= 120 && /^\d{4}-\d{2}$/.test(firstMonth);
  const parts = validPreview ? allocationAmounts(amountNumber, monthCount) : [];
  const partMonths = validPreview ? allocationMonths(firstMonth, monthCount) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!(amountNumber > 0)) return setError("Ange ett belopp större än noll.");
    if (!Number.isInteger(monthCount) || monthCount < 2 || monthCount > 120) {
      return setError("Antal månader måste vara mellan 2 och 120.");
    }
    if (accounts.length > 0) {
      if (!accounts.some((a) => a.number === balanceAccount)) return setError(`Balanskonto ${balanceAccount} finns inte eller är inaktivt.`);
      if (resultAccount === "") return setError("Ange ett resultatkonto.");
      if (!accounts.some((a) => a.number === resultAccount)) return setError(`Resultatkonto ${resultAccount} finns inte eller är inaktivt.`);
    }
    setError(null);
    setPending(true);
    try {
      const created = await apiFetch<RecurringVerification>("/api/v1/recurring-verifications/allocation", {
        method: "POST",
        body: JSON.stringify({
          amount: amountNumber,
          kind,
          balanceAccount,
          resultAccount,
          firstMonth,
          months: monthCount,
          description: description.trim(),
          sourceVerificationId,
        }),
      });
      if (onCreated) onCreated(created);
      else router.push("/ekonomi/aterkommande-verifikat");
    } catch (err) {
      setError(apiErrorMessage(err, "Fördelningen kunde inte skapas"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <FormRow>
        <Field label="Belopp" htmlFor="allocAmount">
          <Input
            id="allocAmount"
            type="number"
            min="0"
            step="0.01"
            required
            size="sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Typ" htmlFor="allocKind">
          <Select id="allocKind" value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            <option value="cost">Kostnad</option>
            <option value="revenue">Intäkt</option>
          </Select>
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Balanskonto" htmlFor="allocBalance">
          <Input
            id="allocBalance"
            list="allocAccounts"
            required
            size="sm"
            value={balanceAccount}
            onChange={(e) => {
              setBalanceAccount(e.target.value.trim());
              setBalanceTouched(true);
            }}
          />
        </Field>
        <Field label="Resultatkonto" htmlFor="allocResult">
          <Input
            id="allocResult"
            list="allocAccounts"
            required
            size="sm"
            value={resultAccount}
            onChange={(e) => setResultAccount(e.target.value.trim())}
          />
        </Field>
      </FormRow>
      <datalist id="allocAccounts">
        {accounts.map((a) => (
          <option key={a.id} value={a.number}>
            {a.name}
          </option>
        ))}
      </datalist>
      <FormHint attached>
        {kind === "cost"
          ? "Förutbetald kostnad: varje månad flyttas en del från balanskontot (förval 1790) till kostnadskontot."
          : "Förutbetald intäkt: varje månad flyttas en del från balanskontot (förval 2990) till intäktskontot."}
      </FormHint>

      <FormRow>
        <Field label="Första månad" htmlFor="allocFirst">
          <Input id="allocFirst" type="month" required size="md" value={firstMonth} onChange={(e) => setFirstMonth(e.target.value)} />
        </Field>
        <Field label="Antal månader" htmlFor="allocMonths">
          <Input
            id="allocMonths"
            type="number"
            min="2"
            max="120"
            step="1"
            required
            size="xs"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
        </Field>
      </FormRow>

      <Field label="Text" htmlFor="allocDescription">
        <Input
          id="allocDescription"
          required
          maxLength={200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      {parts.length > 0 && (
        <div aria-label="Förhandsvisning">
          <strong>Förhandsvisning</strong>
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              marginTop: 6,
              fontFamily: "var(--font-body)",
              fontSize: 13,
              color: "var(--color-text-secondary)",
            }}
          >
            {parts.map((part, i) => (
              <div key={partMonths[i]} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <span>{partMonths[i]}</span>
                <span>{formatMoney(part)}</span>
              </div>
            ))}
          </div>
          <FormHint attached>
            Delbeloppen avrundas till öre och sista månaden tar resten. Posten bokförs direkt varje månad.
          </FormHint>
        </div>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa fördelning"}
        </Button>
      </FormActions>
    </Form>
  );
}

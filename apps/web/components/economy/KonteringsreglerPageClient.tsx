"use client";

import { confirmDelete } from "../../lib/confirm";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow, FormSaved } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { VAT_RATES, postingVatRateLabel } from "../../lib/types";
import type { Account, ArticleGroup, PostingRule, SystemSettings } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";

// The 14 posting-account fields on SystemSettings, in the same order the API
// resolves them (verification-poster.ts's PostingAccountNumbers). label is
// what the account is used for; defaultNumber is only shown on the "reset"
// option — the API decides the real default (posting-settings.ts's
// codeSetting), this is just so the option text isn't a bare blank.
type PostingAccountFieldKey =
  | "postingAccountsReceivable"
  | "postingVatOut25"
  | "postingVatOut12"
  | "postingVatOut6"
  | "postingRevenue25"
  | "postingRevenue12"
  | "postingRevenue6"
  | "postingRevenue0"
  | "postingAccountsPayable"
  | "postingVatIn"
  | "postingDefaultCost"
  | "postingBank"
  | "postingReminderFeeAccount"
  | "postingPaymentWriteOff"
  | "postingVatSettlement"
  | "postingInventory"
  | "postingInventoryChange";

const POSTING_FIELDS: { key: PostingAccountFieldKey; label: string; defaultNumber: string }[] = [
  { key: "postingAccountsReceivable", label: "Kundfordringar", defaultNumber: "1510" },
  { key: "postingVatOut25", label: "Utgående moms 25 %", defaultNumber: "2610" },
  { key: "postingVatOut12", label: "Utgående moms 12 %", defaultNumber: "2620" },
  { key: "postingVatOut6", label: "Utgående moms 6 %", defaultNumber: "2630" },
  { key: "postingRevenue25", label: "Försäljning 25 %", defaultNumber: "3001" },
  { key: "postingRevenue12", label: "Försäljning 12 %", defaultNumber: "3002" },
  { key: "postingRevenue6", label: "Försäljning 6 %", defaultNumber: "3003" },
  { key: "postingRevenue0", label: "Försäljning momsfri", defaultNumber: "3004" },
  { key: "postingAccountsPayable", label: "Leverantörsskulder", defaultNumber: "2440" },
  { key: "postingVatIn", label: "Ingående moms", defaultNumber: "2640" },
  { key: "postingDefaultCost", label: "Kostnad, standard", defaultNumber: "4010" },
  { key: "postingBank", label: "Bank/betalkonto", defaultNumber: "1930" },
  { key: "postingReminderFeeAccount", label: "Påminnelseavgifter", defaultNumber: "3540" },
  { key: "postingPaymentWriteOff", label: "Öres- och kronutjämning", defaultNumber: "3740" },
  { key: "postingVatSettlement", label: "Redovisningskonto för moms", defaultNumber: "2650" },
  { key: "postingInventory", label: "Lager", defaultNumber: "1460" },
  { key: "postingInventoryChange", label: "Lagerförändring", defaultNumber: "4990" },
];

// The 2 kundreskontra kr-amounts (B3) — always required, no "reset to
// default" (unlike the account fields above, an empty amount is not valid).
type PostingAmountFieldKey = "paymentTolerance" | "reminderFee";

const POSTING_AMOUNT_FIELDS: { key: PostingAmountFieldKey; label: string }[] = [
  { key: "paymentTolerance", label: "Betalningstolerans (kr)" },
  { key: "reminderFee", label: "Påminnelseavgift (kr)" },
];

// Derived from the shared VAT_RATES mirror so the web has exactly one
// literal copy of the rate set (B5).
const VAT_RATE_OPTIONS = [
  ...VAT_RATES.map((rate) => ({ value: String(rate), label: `${rate} %` })),
  { value: "all", label: "Alla satser" },
];

// DuplicatePostingRuleError / PostingRuleNoAccountsError translated to fixed
// Swedish copy by the shared error-code dictionary — same idiom as
// kontoplan's formatAccountError.
function formatPostingRuleError(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte spara regeln");
}

export function KonteringsreglerPageClient({
  settings,
  postingRules,
  accounts,
  articleGroups,
}: {
  settings: SystemSettings;
  postingRules: PostingRule[];
  accounts: Account[];
  articleGroups: ArticleGroup[];
}) {
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Konteringsregler</div>
          <div className={shellStyles.meta}>{postingRules.length.toLocaleString("sv-SE")} regler</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="konteringsregler" label="Hjälp om konteringsregler" />
      </div>

      <StandardAccountsSection settings={settings} accounts={accounts} />
      <div style={{ marginTop: 20 }}>
        <KundreskontraSection settings={settings} />
      </div>
      <div style={{ marginTop: 20 }}>
        <PostingRulesSection postingRules={postingRules} accounts={accounts} articleGroups={articleGroups} />
      </div>
    </>
  );
}

// Options for an account select keyed by account NUMBER (the Standardkonton
// fields): the fetched (active) accounts, plus — only when the current value
// isn't among them — an extra option for it, so an account that was later
// deactivated doesn't silently jump the select to a different one, which
// would then quietly overwrite the setting with that different account on
// the next save.
function accountNumberOptions(accounts: Account[], currentValue: string): ReactNode {
  const hasCurrent = currentValue === "" || accounts.some((a) => a.number === currentValue);
  return (
    <>
      {!hasCurrent && <option value={currentValue}>{currentValue} (inaktivt konto)</option>}
      {accounts.map((a) => (
        <option key={a.id} value={a.number}>
          {a.number} {a.name}
        </option>
      ))}
    </>
  );
}

// Same safety net, keyed by account ID (the posting-rule fields) — currentLabel
// comes from the rule row's own joined number/name (economy.repository.ts's
// listPostingRules), since an inactive account isn't in `accounts` to look up.
function accountIdOptions(accounts: Account[], currentId: string, currentLabel: string | null): ReactNode {
  const hasCurrent = currentId === "" || accounts.some((a) => a.id === currentId);
  return (
    <>
      {!hasCurrent && currentLabel && (
        <option value={currentId}>{currentLabel} (inaktivt konto)</option>
      )}
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.number} {a.name}
        </option>
      ))}
    </>
  );
}

function StandardAccountsSection({ settings, accounts }: { settings: SystemSettings; accounts: Account[] }) {
  const initialFromSettings = useMemo(
    () =>
      Object.fromEntries(POSTING_FIELDS.map((f) => [f.key, settings[f.key]])) as Record<PostingAccountFieldKey, string>,
    [settings]
  );
  // The diff baseline. Seeded from the settings prop, but NOT re-derived from
  // it afterwards — it is instead advanced locally on every successful save
  // (below), same "trust the mutation response, not a refetch" idiom as
  // PayrollSettingsForm/CostingSettingsForm. Without that, `changedKeys`
  // would keep diffing against the pre-save snapshot forever: every field
  // saved once stays "changed" for the rest of the session, so the next
  // Spara resends it (never returning to disabled) and risks clobbering a
  // concurrent admin's edit to that same field.
  const [initial, setInitial] = useState<Record<PostingAccountFieldKey, string>>(initialFromSettings);
  const [values, setValues] = useState<Record<PostingAccountFieldKey, string>>(initialFromSettings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const changedKeys = POSTING_FIELDS.map((f) => f.key).filter((key) => values[key] !== initial[key]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (changedKeys.length === 0) return;

    // Only the fields that actually changed go on the wire — an untouched
    // field is left exactly as PATCH /settings/posting last resolved it.
    const body: Partial<Record<PostingAccountFieldKey, string>> = {};
    for (const key of changedKeys) body[key] = values[key];

    setPending(true);
    try {
      const updated = await apiFetch<SystemSettings>("/api/v1/settings/posting", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const resolved = Object.fromEntries(POSTING_FIELDS.map((f) => [f.key, updated[f.key]])) as Record<
        PostingAccountFieldKey,
        string
      >;
      setValues(resolved);
      // Advance the baseline to match — the next diff starts from what the
      // server just confirmed, not from what was loaded at page mount.
      setInitial(resolved);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara standardkontona");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth="none">
      <div style={{ fontWeight: 600, fontSize: 15 }}>Standardkonton</div>
      <FormHint>
        Konton automatkonteringen bokför mot när ingen konteringsregel matchar fakturaraden. Välj &quot;Återställ
        till standard&quot; för att ta bort en egen inställning.
      </FormHint>

      <Form onSubmit={handleSave}>
        <FormError>{error}</FormError>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px 20px" }}>
          {POSTING_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} htmlFor={field.key}>
              <Select
                id={field.key}
                value={values[field.key]}
                onChange={(e) => {
                  setSaved(false);
                  setValues((v) => ({ ...v, [field.key]: e.target.value }));
                }}
              >
                <option value="">Återställ till standard ({field.defaultNumber})</option>
                {accountNumberOptions(accounts, values[field.key])}
              </Select>
            </Field>
          ))}
        </div>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending || changedKeys.length === 0}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

// Kundreskontra (B3): the payment tolerance and reminder fee amounts. Same
// diff-baseline idiom as StandardAccountsSection above (values/initial state,
// changedKeys, baseline advanced from the save response rather than
// re-derived from the settings prop) — see that component's comment for why.
function KundreskontraSection({ settings }: { settings: SystemSettings }) {
  const initialFromSettings = useMemo(
    () =>
      Object.fromEntries(POSTING_AMOUNT_FIELDS.map((f) => [f.key, String(settings[f.key])])) as Record<
        PostingAmountFieldKey,
        string
      >,
    [settings]
  );
  const [initial, setInitial] = useState<Record<PostingAmountFieldKey, string>>(initialFromSettings);
  const [values, setValues] = useState<Record<PostingAmountFieldKey, string>>(initialFromSettings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const changedKeys = POSTING_AMOUNT_FIELDS.map((f) => f.key).filter((key) => values[key] !== initial[key]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (changedKeys.length === 0) return;

    // Unlike the account fields, an empty/invalid amount is not a valid PATCH
    // — there is no "reset to default" for these two.
    const body: Partial<Record<PostingAmountFieldKey, number>> = {};
    for (const key of changedKeys) {
      const parsed = Number(values[key].replace(",", "."));
      if (values[key].trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
        setError("Beloppen måste vara tal som är 0 eller större");
        return;
      }
      body[key] = parsed;
    }

    setPending(true);
    try {
      const updated = await apiFetch<SystemSettings>("/api/v1/settings/posting", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const resolved = Object.fromEntries(
        POSTING_AMOUNT_FIELDS.map((f) => [f.key, String(updated[f.key])])
      ) as Record<PostingAmountFieldKey, string>;
      setValues(resolved);
      // Advance the baseline to match the server's confirmed values — same
      // "trust the mutation response, not a refetch" reasoning as above.
      setInitial(resolved);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara kundreskontrainställningarna");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card maxWidth="none">
      <div style={{ fontWeight: 600, fontSize: 15 }}>Kundreskontra</div>
      <FormHint>
        Styr när en kundbetalning räknas som fullt betald trots en mellanskillnad, och avgiften som läggs på en
        betalningspåminnelse.
      </FormHint>

      <Form onSubmit={handleSave}>
        <FormError>{error}</FormError>

        <FormRow>
          {POSTING_AMOUNT_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} htmlFor={field.key}>
              <Input
                id={field.key}
                type="number"
                min={0}
                step="0.01"
                size="sm"
                value={values[field.key]}
                onChange={(e) => {
                  setSaved(false);
                  setValues((v) => ({ ...v, [field.key]: e.target.value }));
                }}
              />
            </Field>
          ))}
        </FormRow>

        <FormActions>
          <Button type="submit" variant="primary" disabled={pending || changedKeys.length === 0}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </Card>
  );
}

function PostingRulesSection({
  postingRules,
  accounts,
  articleGroups,
}: {
  postingRules: PostingRule[];
  accounts: Account[];
  articleGroups: ArticleGroup[];
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PostingRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(rule: PostingRule) {
    if (!(await confirmDelete(`Ta bort konteringsregeln för ${rule.groupName} (${postingVatRateLabel(rule.vatRate)})?`))) {
      return;
    }
    setError(null);
    try {
      await apiFetch(`/api/v1/posting-rules/${rule.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte ta bort regeln");
    }
  }

  return (
    <Card maxWidth="none">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Konteringsregler</div>
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          + Ny regel
        </Button>
      </div>
      <FormHint>
        Styr vilket intäkts- eller kostnadskonto en fakturarad bokförs mot, per artikelgrupp och momssats. En regel
        med momssats &quot;Alla satser&quot; gäller när ingen regel finns för radens exakta momssats — annars
        används standardkontot.
      </FormHint>

      <FormError margin="below">{error}</FormError>

      <Table<PostingRule>
        columns={[
          { key: "group", label: "Artikelgrupp", width: "1.3fr" },
          { key: "vatRate", label: "Momssats", width: "0.9fr" },
          { key: "revenue", label: "Intäktskonto", width: "1.3fr" },
          { key: "cost", label: "Kostnadskonto", width: "1.3fr" },
          { key: "actions", label: "", width: "170px", align: "right" },
        ]}
        rows={postingRules}
        emptyText="Inga konteringsregler upplagda"
        renderCell={(rule, key) => {
          switch (key) {
            case "group":
              return (
                <strong>
                  {rule.groupCode} · {rule.groupName}
                </strong>
              );
            case "vatRate":
              return postingVatRateLabel(rule.vatRate);
            case "revenue":
              return rule.revenueAccountNumber ? `${rule.revenueAccountNumber} ${rule.revenueAccountName}` : "—";
            case "cost":
              return rule.costAccountNumber ? `${rule.costAccountNumber} ${rule.costAccountName}` : "—";
            case "actions":
              return (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      setEditing(rule);
                      setModalOpen(true);
                    }}
                  >
                    Ändra
                  </Button>
                  <Button type="button" size="small" variant="danger" onClick={() => remove(rule)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Redigera regel — ${editing.groupName}` : "Ny konteringsregel"}
      >
        <PostingRuleForm
          rule={editing}
          accounts={accounts}
          articleGroups={articleGroups}
          onSuccess={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </Card>
  );
}

function PostingRuleForm({
  rule,
  accounts,
  articleGroups,
  onSuccess,
}: {
  rule: PostingRule | null;
  accounts: Account[];
  articleGroups: ArticleGroup[];
  onSuccess: () => void;
}) {
  const [articleGroupId, setArticleGroupId] = useState(rule?.articleGroupId ?? "");
  const [vatRate, setVatRate] = useState(rule ? (rule.vatRate === null ? "all" : String(Number(rule.vatRate))) : "all");
  const [revenueAccountId, setRevenueAccountId] = useState(rule?.revenueAccountId ?? "");
  const [costAccountId, setCostAccountId] = useState(rule?.costAccountId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const revenueCurrentLabel = rule?.revenueAccountId ? `${rule.revenueAccountNumber} ${rule.revenueAccountName}` : null;
  const costCurrentLabel = rule?.costAccountId ? `${rule.costAccountNumber} ${rule.costAccountName}` : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!articleGroupId) {
      setError("Välj en artikelgrupp");
      return;
    }
    if (!revenueAccountId && !costAccountId) {
      setError("Minst ett konto (intäkt eller kostnad) måste anges");
      return;
    }
    setError(null);
    setPending(true);

    const body = {
      articleGroupId,
      vatRate: vatRate === "all" ? null : Number(vatRate),
      revenueAccountId: revenueAccountId || null,
      costAccountId: costAccountId || null,
    };

    try {
      if (rule) {
        await apiFetch(`/api/v1/posting-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiFetch("/api/v1/posting-rules", { method: "POST", body: JSON.stringify(body) });
      }
      onSuccess();
    } catch (err) {
      setError(formatPostingRuleError(err));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <Field label="Artikelgrupp" htmlFor="postingRuleGroup">
        <Select id="postingRuleGroup" value={articleGroupId} onChange={(e) => setArticleGroupId(e.target.value)}>
          <option value="">— Välj artikelgrupp —</option>
          {articleGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.code} · {g.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Momssats" htmlFor="postingRuleVatRate">
        <Select id="postingRuleVatRate" size="sm" value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
          {VAT_RATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>

      <FormRow>
        <Field label="Intäktskonto" htmlFor="postingRuleRevenue">
          <Select id="postingRuleRevenue" value={revenueAccountId} onChange={(e) => setRevenueAccountId(e.target.value)}>
            <option value="">—</option>
            {accountIdOptions(accounts, revenueAccountId, revenueCurrentLabel)}
          </Select>
        </Field>
        <Field label="Kostnadskonto" htmlFor="postingRuleCost">
          <Select id="postingRuleCost" value={costAccountId} onChange={(e) => setCostAccountId(e.target.value)}>
            <option value="">—</option>
            {accountIdOptions(accounts, costAccountId, costCurrentLabel)}
          </Select>
        </Field>
      </FormRow>
      <FormHint attached>
        Minst ett av kontona måste anges — en regel kan styra bara intäkt, bara kostnad, eller båda.
      </FormHint>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : rule ? "Spara" : "Skapa"}
        </Button>
      </FormActions>
    </Form>
  );
}

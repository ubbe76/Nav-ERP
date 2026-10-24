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
import { postingVatCodeLabel } from "../../lib/types";
import type { Account, ArticleGroup, PostingRule, SystemSettings } from "../../lib/types";
import { VAT_CODE_CATALOG, ruleBoxProblemText, ruleBoxProblems, type VatCodeView } from "../../lib/vatCodes";
import type { VatBoxSetting } from "../../lib/vatBoxes";
import shellStyles from "../AppShell.module.css";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import styles from "./Momskoder.module.css";

// The posting-account fields on SystemSettings, in the same order the API
// resolves them (verification-poster.ts's PostingAccountNumbers). label is
// what the account is used for; defaultNumber is only shown on the "reset"
// option — the API decides the real default (posting-settings.ts's
// codeSetting), this is just so the option text isn't a bare blank. The
// revenue and VAT accounts are not here any more: they belong to the
// momskoder (Ekonomi → Momskoder).
type PostingAccountFieldKey =
  | "postingAccountsReceivable"
  | "postingAccountsPayable"
  | "postingDefaultCost"
  | "postingBank"
  | "postingReminderFeeAccount"
  | "postingPaymentWriteOff"
  | "postingVatSettlement"
  | "postingInventory"
  | "postingInventoryChange"
  | "postingFxGain"
  | "postingFxLoss"
  | "postingBankFees";

const POSTING_FIELDS: { key: PostingAccountFieldKey; label: string; defaultNumber: string }[] = [
  { key: "postingAccountsReceivable", label: "Kundfordringar", defaultNumber: "1510" },
  { key: "postingAccountsPayable", label: "Leverantörsskulder", defaultNumber: "2440" },
  { key: "postingDefaultCost", label: "Kostnad, standard", defaultNumber: "4010" },
  { key: "postingBank", label: "Bank/betalkonto", defaultNumber: "1930" },
  { key: "postingReminderFeeAccount", label: "Påminnelseavgifter", defaultNumber: "3540" },
  { key: "postingPaymentWriteOff", label: "Öres- och kronutjämning", defaultNumber: "3740" },
  { key: "postingVatSettlement", label: "Redovisningskonto för moms", defaultNumber: "2650" },
  { key: "postingInventory", label: "Lager", defaultNumber: "1460" },
  { key: "postingInventoryChange", label: "Lagerförändring", defaultNumber: "4990" },
  { key: "postingFxGain", label: "Kursvinst", defaultNumber: "3960" },
  { key: "postingFxLoss", label: "Kursförlust", defaultNumber: "7960" },
  { key: "postingBankFees", label: "Bankkostnader", defaultNumber: "6570" },
];

// The 2 kundreskontra kr-amounts (B3) — always required, no "reset to
// default" (unlike the account fields above, an empty amount is not valid).
type PostingAmountFieldKey = "paymentTolerance" | "reminderFee";

const POSTING_AMOUNT_FIELDS: { key: PostingAmountFieldKey; label: string }[] = [
  { key: "paymentTolerance", label: "Betalningstolerans (kr)" },
  { key: "reminderFee", label: "Påminnelseavgift (kr)" },
];

// The codes a konteringsregel can be for, grouped the way the select shows
// them. Import codes are left out — the importmoms posting has no article
// group, so a rule for one could never apply (the API answers 400
// posting-rule-vat-code).
const RULE_CODE_GROUPS: { label: string; kinds: readonly string[] }[] = [
  { label: "Svensk moms och momsfritt", kinds: ["domestic"] },
  { label: "Försäljning till utlandet och omvänd betalningsskyldighet", kinds: ["eu_sale", "export", "reverse_sale"] },
  { label: "Inköp från utlandet och omvänd moms", kinds: ["reverse_purchase", "non_eu_goods"] },
];

// "ruta 05" / "ingen ruta" / "ingen ruta angiven".
function boxPhrase(box: VatBoxSetting | null): string {
  if (box === null) return "ingen ruta angiven";
  if (box === "none") return "ingen ruta";
  return `ruta ${box}`;
}

// The text under an account of a rule whose momsruta is wrong — the same rules
// the Momsrapport warns about (ruleBoxProblems in lib/vatCodes.ts, pinned
// against vat-report.service.ts's findRuleBoxMismatches): an exact
// utrikes-/omvänd code needs the code's box, MP25/MP12/MP6/MF and "Alla
// momskoder" a revenue account in ruta 05/42, and a cost account for svensk
// moms must not carry an inköpsruta. One text per account.
function ruleBoxProblemTexts(rule: PostingRule): { revenue: string | null; cost: string | null } {
  const texts: { revenue: string | null; cost: string | null } = { revenue: null, cost: null };
  for (const problem of ruleBoxProblems(rule)) {
    const forCode = problem.problem === "box_mismatch" ? ` för ${rule.vatCode ?? "Alla momskoder"}` : "";
    texts[problem.slot] = `Kontot ${ruleBoxProblemText(problem)}${forCode}`;
  }
  return texts;
}

// One account cell of the rules table: number and name, the chart's momsruta
// under it, and the problem line when a utrikes-/omvänd rule's account has the
// wrong box.
function RuleAccount({
  number,
  name,
  box,
  problem,
}: {
  number: string | null;
  name: string | null;
  box: VatBoxSetting | null;
  problem: string | null;
}) {
  if (number === null) return <>—</>;
  return (
    <span>
      {number} {name}
      <span className={styles.sub}>{boxPhrase(box)}</span>
      {problem && (
        <span className={styles.warning}>
          <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: number } }}>{problem}</GatedLink>
        </span>
      )}
    </span>
  );
}

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
  vatCodes,
}: {
  settings: SystemSettings;
  postingRules: PostingRule[];
  accounts: Account[];
  articleGroups: ArticleGroup[];
  vatCodes: VatCodeView[];
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
        <PostingRulesSection
          postingRules={postingRules}
          accounts={accounts}
          articleGroups={articleGroups}
          vatCodes={vatCodes}
        />
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
        Konton automatkonteringen bokför mot: reskontrorna, banken, avgifter, utjämning, momsomföringen, bokslutet,
        kursdifferenser och bankavgifter vid betalning i utländsk valuta och kostnadskontot när ingen konteringsregel
        matchar en leverantörsfakturarad. Välj &quot;Återställ till standard&quot; för att ta bort en egen inställning.
      </FormHint>
      <FormHint style={{ marginTop: 6 }}>
        Intäktskontona och momskontona (utgående och ingående moms) ligger på momskoderna — ändra dem under{" "}
        <GatedLink href="/ekonomi/momskoder">Momskoder</GatedLink>.
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
        betalningspåminnelse. Toleransen gäller även utbetalningar till leverantörer; på en faktura i utländsk valuta
        räknas den om med fakturans kurs.
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
  vatCodes,
}: {
  postingRules: PostingRule[];
  accounts: Account[];
  articleGroups: ArticleGroup[];
  vatCodes: VatCodeView[];
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PostingRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(rule: PostingRule) {
    if (!(await confirmDelete(`Ta bort konteringsregeln för ${rule.groupName} (${postingVatCodeLabel(rule)})?`))) {
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
        Styr vilket intäkts- eller kostnadskonto en fakturarad bokförs mot, per artikelgrupp och momskod. En regel
        med momskod &quot;Alla momskoder&quot; gäller när ingen regel finns för radens exakta momskod — annars
        används kontot på momskoden (intäkter) eller standardkontot Kostnad, standard (kostnader).
      </FormHint>
      <FormHint style={{ marginTop: 6 }}>
        &quot;Alla momskoder&quot; gäller bara svensk moms, momsfritt och Inköp varor utanför EU. Utrikes- och omvända
        koder (till exempel Varor till annat EU-land eller Inköp varor från EU 25 %) tar kodens eget konto om det inte
        finns en regel för exakt den koden — så att en försäljning till ett annat EU-land hamnar i rätt momsruta
        oavsett vad en katalogregel säger.
      </FormHint>
      <FormHint style={{ marginTop: 6 }}>
        Kontot en regel pekar på ersätter momskodens eget konto och måste därför ha rätt momsruta: intäktskontot ruta
        05 för Moms 25/12/6 % (ruta 42 för Momsfri, ruta 05 eller 42 för Alla momskoder) och kodens egen ruta för
        utrikes- och omvända koder, kostnadskontot ingen av inköpsrutorna 20–24, 37 eller 50 för svensk moms. Fel ruta
        markeras under kontot, och Momsrapporten varnar för samma sak.
      </FormHint>

      <FormError margin="below">{error}</FormError>

      <Table<PostingRule>
        columns={[
          { key: "group", label: "Artikelgrupp", width: "1.3fr" },
          { key: "vatCode", label: "Momskod", width: "1.1fr" },
          { key: "revenue", label: "Intäktskonto", width: "1.4fr" },
          { key: "cost", label: "Kostnadskonto", width: "1.4fr" },
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
            case "vatCode":
              return postingVatCodeLabel(rule);
            case "revenue":
              return (
                <RuleAccount
                  number={rule.revenueAccountNumber}
                  name={rule.revenueAccountName}
                  box={rule.revenueAccountVatBox}
                  problem={ruleBoxProblemTexts(rule).revenue}
                />
              );
            case "cost":
              return (
                <RuleAccount
                  number={rule.costAccountNumber}
                  name={rule.costAccountName}
                  box={rule.costAccountVatBox}
                  problem={ruleBoxProblemTexts(rule).cost}
                />
              );
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
          vatCodes={vatCodes}
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
  vatCodes,
  onSuccess,
}: {
  rule: PostingRule | null;
  accounts: Account[];
  articleGroups: ArticleGroup[];
  vatCodes: VatCodeView[];
  onSuccess: () => void;
}) {
  const [articleGroupId, setArticleGroupId] = useState(rule?.articleGroupId ?? "");
  // "" = Alla momskoder (vatCodeId null on the wire).
  const [vatCodeId, setVatCodeId] = useState(rule?.vatCodeId ?? "");
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
      vatCodeId: vatCodeId === "" ? null : vatCodeId,
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

      <Field label="Momskod" htmlFor="postingRuleVatCode">
        <Select id="postingRuleVatCode" value={vatCodeId} onChange={(e) => setVatCodeId(e.target.value)}>
          <option value="">Alla momskoder</option>
          {RULE_CODE_GROUPS.map((group) => {
            // Active codes, plus the rule's own code if it has been
            // deactivated since — so editing does not silently change it.
            const options = VAT_CODE_CATALOG.flatMap((entry) => {
              const code = vatCodes.find((candidate) => candidate.code === entry.code);
              if (!code || !group.kinds.includes(code.kind)) return [];
              if (!code.active && code.id !== rule?.vatCodeId) return [];
              return [code];
            });
            if (options.length === 0) return null;
            return (
              <optgroup key={group.label} label={group.label}>
                {options.map((code) => (
                  <option key={code.id} value={code.id}>
                    {code.code} · {code.name}
                    {code.active ? "" : " (inaktiv)"}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </Field>
      <FormHint attached>
        &quot;Alla momskoder&quot; gäller bara svensk moms, momsfritt och Inköp varor utanför EU — utrikes- och omvända
        koder tar kodens eget konto om ingen regel för exakt koden finns.
      </FormHint>

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

"use client";

import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { HelpLink } from "../ui/HelpLink";
import { Modal } from "../ui/Modal";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Account } from "../../lib/types";
import type { VatBoxSetting } from "../../lib/vatBoxes";
import {
  isDomesticVatCode,
  VAT_CODE_ACCOUNT_FIELDS,
  VAT_CODE_DIRECTION_LABELS,
  VAT_CODE_KIND_LABELS,
  VAT_CODE_SLOT_LABELS,
  VAT_CODE_SLOT_SHORT_LABELS,
  VAT_CODE_SLOTS,
  type VatCodeAccountField,
  type VatCodeAccountView,
  type VatCodeSlot,
  type VatCodeView,
} from "../../lib/vatCodes";
import shellStyles from "../AppShell.module.css";
import styles from "./Momskoder.module.css";

// "ruta 35" / "ingen ruta" / "ingen ruta angiven" — how a box reads in the
// warnings (the API words its own messages the same way).
function boxPhrase(box: VatBoxSetting | null): string {
  if (box === null) return "ingen ruta angiven";
  if (box === "none") return "ingen ruta";
  return `ruta ${box}`;
}

function warningText(account: VatCodeAccountView): string | null {
  switch (account.warning) {
    case "missing":
      return "Kontot finns inte i kontoplanen";
    case "inactive":
      return "Kontot är inaktivt";
    case "box_mismatch":
      return `Kontot har ${boxPhrase(account.actualBox)} men ska ha ${boxPhrase(account.expectedBox)}`;
    default:
      return null;
  }
}

export function MomskoderPageClient({ codes, accounts }: { codes: VatCodeView[]; accounts: Account[] }) {
  const [editing, setEditing] = useState<VatCodeView | null>(null);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Momskoder</div>
          <div className={shellStyles.meta}>{codes.length.toLocaleString("sv-SE")} koder</div>
        </div>
        <HelpLink chapter="ekonomi" anchor="momskoder" label="Hjälp om momskoder" />
      </div>

      <FormHint style={{ marginBottom: 16 }}>
        En momskod avgör hur en rad beskattas: vilka konton den bokförs mot — och därmed vilken ruta i momsdeklarationen
        beloppen hamnar i — och vilken text fakturan ska bära. Koderna är fasta; du anger själv kontonummer, fakturatext
        och om koden är aktiv. En varning på ett konto betyder att kontots momsruta i kontoplanen inte är den som koden
        förväntar sig.
      </FormHint>

      <Table<VatCodeView>
        columns={[
          { key: "code", label: "Kod", width: "70px" },
          { key: "name", label: "Benämning", width: "1.2fr" },
          { key: "kind", label: "Typ", width: "0.9fr" },
          { key: "rate", label: "Sats", width: "55px", align: "right" },
          { key: "accounts", label: "Konton", width: "3fr" },
          { key: "invoiceText", label: "Fakturatext", width: "1.2fr" },
          { key: "active", label: "Status", width: "100px" },
        ]}
        rows={codes}
        emptyText="Inga momskoder"
        renderCell={(code, key) => {
          const dim = code.active ? undefined : styles.dim;
          switch (key) {
            case "code":
              return (
                <strong className={dim}>
                  <span className="num">{code.code}</span>
                </strong>
              );
            case "name":
              return (
                <span className={[styles.wrap, dim].filter(Boolean).join(" ")}>
                  {code.name}
                  {code.ruleCount > 0 && (
                    <span className={styles.sub}>
                      {code.ruleCount} {code.ruleCount === 1 ? "konteringsregel" : "konteringsregler"}
                    </span>
                  )}
                </span>
              );
            case "kind":
              return (
                <span className={[styles.wrap, dim].filter(Boolean).join(" ")}>
                  {VAT_CODE_KIND_LABELS[code.kind]}
                  <span className={styles.sub}>{VAT_CODE_DIRECTION_LABELS[code.direction]}</span>
                </span>
              );
            case "rate":
              return <span className={["num", dim].filter(Boolean).join(" ")}>{code.rate} %</span>;
            case "accounts":
              return code.accounts.length === 0 ? (
                <span className={[styles.wrap, styles.dim].join(" ")}>
                  Inga konton — kostnadskontot följer konteringsreglerna
                </span>
              ) : (
                <ul className={styles.accounts}>
                  {code.accounts.map((account) => (
                    <AccountLine key={account.slot} account={account} dim={!code.active} />
                  ))}
                </ul>
              );
            case "invoiceText":
              return code.invoiceText ? (
                <span className={[styles.wrap, styles.invoiceText].join(" ")}>{code.invoiceText}</span>
              ) : (
                <span className={styles.dim}>—</span>
              );
            case "active":
              return (
                <span className={styles.status}>
                  {code.active ? (
                    <StatusPill status="running" label="Aktiv" compact />
                  ) : (
                    <StatusPill status="draft" label="Inaktiv" compact />
                  )}
                  <Button type="button" size="small" variant="ghost" onClick={() => setEditing(code)}>
                    Ändra
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Ändra momskod ${editing.code}` : ""}
      >
        {editing && <VatCodeForm key={editing.id} code={editing} accounts={accounts} onClose={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

function AccountLine({ account, dim }: { account: VatCodeAccountView; dim: boolean }) {
  const warning = warningText(account);
  const label = account.accountName ? `${account.accountNumber} ${account.accountName}` : account.accountNumber;
  return (
    <li className={[styles.account, styles.wrap].join(" ")} title={VAT_CODE_SLOT_LABELS[account.slot]}>
      <span className={styles.slot}>{VAT_CODE_SLOT_SHORT_LABELS[account.slot]}</span>
      <span className={dim ? styles.dim : undefined}>
        <span className="num">{label}</span> <span className={styles.box}>· {boxPhrase(account.expectedBox)}</span>
      </span>
      {warning && (
        <span className={account.warning === "box_mismatch" ? styles.warning : styles.warningError}>
          {account.warning !== "missing" ? (
            <GatedLink href={{ pathname: "/ekonomi/kontoplan", query: { search: account.accountNumber } }}>
              {warning}
            </GatedLink>
          ) : (
            warning
          )}
        </span>
      )}
    </li>
  );
}

// Options keyed by account NUMBER (same idiom as Standardkonton): the active
// accounts, plus — when the current value is missing from them — an extra
// option for it, so an inactive or missing account does not silently jump the
// select to another one.
function accountNumberOptions(accounts: Account[], currentValue: string, defaultNumber: string): ReactNode {
  const hasCurrent = currentValue === "" || accounts.some((account) => account.number === currentValue);
  return (
    <>
      <option value="">Återställ till standard ({defaultNumber})</option>
      {!hasCurrent && <option value={currentValue}>{currentValue} (inaktivt eller saknat konto)</option>}
      {accounts.map((account) => (
        <option key={account.id} value={account.number}>
          {account.number} {account.name}
        </option>
      ))}
    </>
  );
}

type SlotValues = Record<VatCodeSlot, string>;

function VatCodeForm({ code, accounts, onClose }: { code: VatCodeView; accounts: Account[]; onClose: () => void }) {
  const router = useRouter();
  const slots = useMemo(
    () => VAT_CODE_SLOTS.flatMap((slot) => code.accounts.filter((account) => account.slot === slot)),
    [code]
  );
  const initialAccounts = useMemo(
    () => Object.fromEntries(slots.map((account) => [account.slot, account.accountNumber])) as SlotValues,
    [slots]
  );

  const [name, setName] = useState(code.name);
  const [invoiceText, setInvoiceText] = useState(code.invoiceText ?? "");
  const [active, setActive] = useState(code.active);
  const [accountValues, setAccountValues] = useState<SlotValues>(initialAccounts);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Warnings from the saved code (an inactive code a rule still uses, an
  // account whose box does not match) — the dialog stays open to show them.
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const body = useMemo(() => {
    const patch: Partial<Record<"name" | "invoiceText" | "active" | VatCodeAccountField, string | boolean>> = {};
    if (name.trim() !== code.name) patch.name = name.trim();
    if (invoiceText.trim() !== (code.invoiceText ?? "")) patch.invoiceText = invoiceText.trim();
    if (active !== code.active) patch.active = active;
    for (const account of slots) {
      const chosen = accountValues[account.slot];
      // "" is the reset option: it means the catalog's default account.
      const effective = chosen === "" ? account.defaultAccountNumber : chosen;
      if (effective !== account.accountNumber) patch[VAT_CODE_ACCOUNT_FIELDS[account.slot]] = chosen;
    }
    return patch;
  }, [name, invoiceText, active, accountValues, slots, code]);
  const changed = Object.keys(body).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!changed) return;
    if (name.trim() === "") {
      setError("Benämningen får inte vara tom");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<{ vatCode: VatCodeView; warnings: string[] }>(`/api/v1/vat-codes/${code.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      router.refresh();
      if (result.warnings.length === 0) {
        onClose();
      } else {
        setWarnings(result.warnings);
        setPending(false);
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara momskoden"));
      setPending(false);
    }
  }

  if (warnings) {
    return (
      <Form onSubmit={(event) => event.preventDefault()}>
        <p>Momskoden är sparad. Observera:</p>
        <FormNotice>
          <ul className={styles.warnings}>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </FormNotice>
        <FormActions>
          <Button type="button" variant="primary" onClick={onClose}>
            Stäng
          </Button>
        </FormActions>
      </Form>
    );
  }

  const hasDefaultText = code.defaultInvoiceText !== null;
  // Moms 25/12/6 % and Momsfri are what Nav falls back on whenever it picks a
  // code itself, so an active one cannot be deactivated (400 vat-code-required).
  const domesticInUse = code.active && isDomesticVatCode(code.code);

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>

      <FormHint>
        {VAT_CODE_KIND_LABELS[code.kind]} · {VAT_CODE_DIRECTION_LABELS[code.direction]} · {code.rate} %
        {code.requiresBuyerVatNumber ? " · kräver köparens momsregistreringsnummer" : ""}
      </FormHint>

      <Field label="Benämning" htmlFor="vatCodeName">
        <Input id="vatCodeName" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Fakturatext" htmlFor="vatCodeInvoiceText">
        <Input
          id="vatCodeInvoiceText"
          maxLength={255}
          value={invoiceText}
          placeholder="Ingen text"
          onChange={(e) => setInvoiceText(e.target.value)}
        />
      </Field>
      <FormHint attached>
        Skrivs en gång på fakturan under momssammanställningen när någon rad har koden. Tomt fält = ingen text.
        {hasDefaultText && invoiceText.trim() !== code.defaultInvoiceText && (
          <>
            {" "}
            <Button type="button" size="small" variant="ghost" onClick={() => setInvoiceText(code.defaultInvoiceText ?? "")}>
              Återställ till förvald text
            </Button>
          </>
        )}
      </FormHint>

      <Field label="Aktiv" htmlFor="vatCodeActive">
        <Toggle
          id="vatCodeActive"
          checked={active}
          disabled={domesticInUse}
          onChange={(e) => setActive(e.target.checked)}
        />
      </Field>
      {domesticInUse && (
        <FormHint attached>Används när Nav väljer momskod automatiskt — kan inte inaktiveras.</FormHint>
      )}
      {!active && code.ruleCount > 0 && (
        <FormHint attached>
          {code.ruleCount} {code.ruleCount === 1 ? "konteringsregel används" : "konteringsregler används"} av koden —
          de fortsätter gälla, men du varnas efter sparandet.
        </FormHint>
      )}

      {slots.map((account) => (
        <Fragment key={account.slot}>
          <Field label={VAT_CODE_SLOT_LABELS[account.slot]} htmlFor={`vatCode-${account.slot}`}>
            <Select
              id={`vatCode-${account.slot}`}
              value={accountValues[account.slot]}
              onChange={(e) => setAccountValues((values) => ({ ...values, [account.slot]: e.target.value }))}
            >
              {accountNumberOptions(accounts, accountValues[account.slot], account.defaultAccountNumber)}
            </Select>
          </Field>
          <FormHint attached>Förväntad momsruta: {boxPhrase(account.expectedBox)}.</FormHint>
        </Fragment>
      ))}
      {slots.length === 0 && (
        <FormHint>
          Koden har inga egna konton — kostnadskontot följer konteringsreglerna och standardkontot, och importmomsen
          bokförs separat under Momsrapport.
        </FormHint>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || !changed}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

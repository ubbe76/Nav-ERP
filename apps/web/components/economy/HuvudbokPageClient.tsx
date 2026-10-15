"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormRow } from "../ui/Form";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import buttonStyles from "../ui/Button.module.css";
import type { Account, GeneralLedgerResponse, LedgerResponse } from "../../lib/types";
import { SectionHeading } from "../ui/SectionHeading";

// "1930 · Företagskonto" — same accountLabel idiom as VerificationCard.tsx's
// account picker. Inactive accounts stay selectable (they can carry booked
// history) but say so.
function accountLabel(a: Account): string {
  return `${a.number} · ${a.name}${a.active ? "" : " (inaktivt)"}`;
}

// Translates the ledger endpoint's error via the shared error-code
// dictionary — same idiom as VerificationCard's formatVerificationError. The
// only error this endpoint can realistically raise is a stale accountId from
// the URL (economy service's AccountNotFoundError, 404).
function formatLedgerError(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte hämta huvudboken");
}

// The IB/UB summary rows and the ordinary ledger rows share one Table, with
// `kind` as the discriminant that picks what each column renders (see
// renderCell below). Opening/closing get their own singleton-literal variant
// each — a single variant with kind: "opening" | "closing" would not narrow
// exhaustively in renderCell's if/switch chain.
type LedgerDisplayRow =
  | { id: "opening"; kind: "opening"; balance: number }
  | { id: "closing"; kind: "closing"; balance: number }
  | {
      id: string;
      kind: "row";
      date: string;
      verificationId: string;
      displayNumber: string;
      description: string;
      debit: string;
      credit: string;
      balance: number;
    };

export function HuvudbokPageClient({
  accounts,
  defaultAccountId,
  defaultFrom,
  defaultTo,
}: {
  accounts: Account[];
  // All three are pre-resolved server-side (page.tsx): the URL's own
  // ?accountId=&from=&to= when present, else the latest fiscal year's
  // bounds (or the current calendar year, if there is no fiscal year yet).
  defaultAccountId: string;
  defaultFrom: string;
  defaultTo: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [mode, setMode] = useState<"single" | "range">("single");
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [accountFrom, setAccountFrom] = useState("");
  const [accountTo, setAccountTo] = useState("");
  const [onlyWithMovement, setOnlyWithMovement] = useState(true);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [rangeLedger, setRangeLedger] = useState<GeneralLedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Query string for the multi-account endpoint and its PDF — empty account
  // bounds mean "all accounts" and are simply omitted.
  function rangeParams(): string {
    const params = new URLSearchParams({ from, to, onlyWithMovement: String(onlyWithMovement) });
    if (accountFrom) params.set("accountFrom", accountFrom);
    if (accountTo) params.set("accountTo", accountTo);
    return params.toString();
  }

  useEffect(() => {
    if (mode !== "range" || !from || !to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<GeneralLedgerResponse>(`/api/v1/general-ledger?${rangeParams()}`)
      .then((data) => {
        if (!cancelled) setRangeLedger(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatLedgerError(err));
          setRangeLedger(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeParams is derived from these
  }, [mode, from, to, accountFrom, accountTo, onlyWithMovement]);

  // Fetches on every selection change (account or either date) — the ledger
  // is a pure read with nothing to submit. The URL is kept in sync
  // (router.replace, no history entry) so the view is bookmarkable and
  // survives a refresh, the same intent as the list pages' ?search=&page=.
  useEffect(() => {
    // Also guards against a momentarily-cleared date field (the inputs aren't
    // native-required since nothing here is submitted) — an empty from/to
    // would otherwise fail the API's z.string().date() and surface as a
    // transient error while the user is still typing a new date.
    if (mode !== "single" || !accountId || !from || !to) {
      if (mode === "single") setLedger(null);
      return;
    }
    const params = new URLSearchParams({ accountId, from, to });
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });

    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<LedgerResponse>(`/api/v1/ledger?${params.toString()}`)
      .then((data) => {
        if (!cancelled) setLedger(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatLedgerError(err));
          setLedger(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [mode, accountId, from, to]);

  const displayRows: LedgerDisplayRow[] = ledger
    ? [
        { id: "opening", kind: "opening", balance: ledger.openingBalance },
        ...ledger.rows.map(
          (row, index): LedgerDisplayRow => ({
            id: `${row.verificationId}-${index}`,
            kind: "row",
            date: row.date,
            verificationId: row.verificationId,
            displayNumber: row.displayNumber,
            description: row.description,
            debit: row.debit,
            credit: row.credit,
            balance: row.balance,
          })
        ),
        { id: "closing", kind: "closing", balance: ledger.closingBalance },
      ]
    : [];

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormRow columns={3}>
          <Field label="Visa" htmlFor="ledgerMode">
            <Select
              id="ledgerMode"
              value={mode}
              onChange={(e) => setMode(e.target.value as "single" | "range")}
            >
              <option value="single">Ett konto</option>
              <option value="range">Kontointervall</option>
            </Select>
          </Field>
          <Field label="Från" htmlFor="ledgerFrom">
            <Input id="ledgerFrom" type="date" required size="sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Till" htmlFor="ledgerTo">
            <Input id="ledgerTo" type="date" required size="sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </FormRow>

        {mode === "single" ? (
          <FormRow columns={2}>
            <Field label="Konto" htmlFor="ledgerAccount">
              <Select id="ledgerAccount" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">— Välj konto —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </Select>
            </Field>
            {accountId && (
              <a
                // onlyWithMovement=false on purpose: the endpoint defaults it
                // to true, which would drop an account that has an opening
                // balance but no rows in the range — exactly the account the
                // on-screen view deliberately still shows.
                href={`${API_URL}/api/v1/general-ledger/pdf?from=${from}&to=${to}&onlyWithMovement=false&accountFrom=${
                  accounts.find((a) => a.id === accountId)?.number ?? "0000"
                }&accountTo=${accounts.find((a) => a.id === accountId)?.number ?? "9999"}`}
                download
                className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              >
                Ladda ner PDF
              </a>
            )}
            {accountId && (
              <a
                href={`${API_URL}/api/v1/general-ledger/csv?from=${from}&to=${to}&onlyWithMovement=false&accountFrom=${
                  accounts.find((a) => a.id === accountId)?.number ?? "0000"
                }&accountTo=${accounts.find((a) => a.id === accountId)?.number ?? "9999"}`}
                download
                className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              >
                Ladda ner CSV
              </a>
            )}
          </FormRow>
        ) : (
          <FormRow columns={3}>
            <Field label="Konto från" htmlFor="ledgerAccountFrom">
              <Input
                id="ledgerAccountFrom"
                placeholder="0000"
                size="xs"
                value={accountFrom}
                onChange={(e) => setAccountFrom(e.target.value)}
              />
            </Field>
            <Field label="Konto till" htmlFor="ledgerAccountTo">
              <Input
                id="ledgerAccountTo"
                placeholder="9999"
                size="xs"
                value={accountTo}
                onChange={(e) => setAccountTo(e.target.value)}
              />
            </Field>
            <Field label="Endast konton med rörelse eller saldo" htmlFor="ledgerOnlyMovement">
              <input
                id="ledgerOnlyMovement"
                type="checkbox"
                checked={onlyWithMovement}
                onChange={(e) => setOnlyWithMovement(e.target.checked)}
              />
            </Field>
          </FormRow>
        )}

        {mode === "range" && (
          <a
            href={`${API_URL}/api/v1/general-ledger/pdf?${rangeParams()}`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Ladda ner PDF
          </a>
        )}
        {mode === "range" && (
          <a
            href={`${API_URL}/api/v1/general-ledger/csv?${rangeParams()}`}
            download
            className={`${buttonStyles.button} ${buttonStyles.ghost}`}
          >
            Ladda ner CSV
          </a>
        )}
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar huvudboken…</FormHint>}

      {mode === "single" && !accountId && <p>Välj ett konto för att visa huvudboken.</p>}

      {/* IB/UB are rendered even when the range has no rows: an account with
          an opening balance and no movement is not an empty account, and
          hiding its saldo made it look like one. */}
      {/* Only when there is genuinely nothing to show. With a non-zero
          opening balance the table's Ingående/Utgående saldo already says
          "no movement", and printing both would contradict it. */}
      {mode === "single" &&
        accountId &&
        !loading &&
        !error &&
        ledger &&
        ledger.rows.length === 0 &&
        ledger.openingBalance === 0 &&
        ledger.closingBalance === 0 && <p>Inga bokförda rader på kontot i intervallet.</p>}

      {mode === "single" && accountId && ledger && (
        <Table<LedgerDisplayRow>
          columns={[
            { key: "date", label: "Datum", width: "110px" },
            { key: "verifikat", label: "Verifikat", width: "140px" },
            { key: "text", label: "Text", width: "1.6fr" },
            { key: "debit", label: "Debet", width: "130px", align: "right" },
            { key: "credit", label: "Kredit", width: "130px", align: "right" },
            { key: "saldo", label: "Saldo", width: "130px", align: "right" },
          ]}
          rows={displayRows}
          renderCell={(row, key) => {
            switch (key) {
              case "date":
                return row.kind === "row" ? row.date : "";
              case "verifikat":
                return row.kind === "row" ? (
                  <Link href={`/ekonomi/verifikat/${row.verificationId}`}>{row.displayNumber}</Link>
                ) : (
                  ""
                );
              case "text":
                if (row.kind === "opening") return <strong>Ingående saldo</strong>;
                if (row.kind === "closing") return <strong>Utgående saldo</strong>;
                return row.description;
              case "debit":
                return row.kind === "row" ? <span className="num">{formatMoney(row.debit)}</span> : "";
              case "credit":
                return row.kind === "row" ? <span className="num">{formatMoney(row.credit)}</span> : "";
              case "saldo":
                return (
                  <span className="num" style={row.kind !== "row" ? { fontWeight: 600 } : undefined}>
                    {formatMoney(row.balance)}
                  </span>
                );
              default:
                return null;
            }
          }}
        />
      )}

      {mode === "range" && !loading && !error && rangeLedger && rangeLedger.accounts.length === 0 && (
        <p>Inga konton med bokförda rader i intervallet.</p>
      )}

      {mode === "range" &&
        rangeLedger &&
        rangeLedger.accounts.map((account) => (
          <div key={account.accountId} style={{ marginBottom: 28 }}>
            <SectionHeading>
              {account.accountNumber} · {account.accountName}
            </SectionHeading>
            <Table<LedgerDisplayRow>
              columns={[
                { key: "date", label: "Datum", width: "110px" },
                { key: "verifikat", label: "Verifikat", width: "140px" },
                { key: "text", label: "Text", width: "1.6fr" },
                { key: "debit", label: "Debet", width: "130px", align: "right" },
                { key: "credit", label: "Kredit", width: "130px", align: "right" },
                { key: "saldo", label: "Saldo", width: "130px", align: "right" },
              ]}
              rows={[
                { id: "opening", kind: "opening", balance: account.openingBalance },
                ...account.rows.map(
                  (row, index): LedgerDisplayRow => ({
                    id: `${row.verificationId}-${index}`,
                    kind: "row",
                    date: row.date,
                    verificationId: row.verificationId,
                    displayNumber: row.displayNumber,
                    description: row.description,
                    debit: row.debit,
                    credit: row.credit,
                    balance: row.balance,
                  })
                ),
                { id: "closing", kind: "closing", balance: account.closingBalance },
              ]}
              renderCell={(row, key) => {
                switch (key) {
                  case "date":
                    return row.kind === "row" ? row.date : "";
                  case "verifikat":
                    return row.kind === "row" ? (
                      <Link href={`/ekonomi/verifikat/${row.verificationId}`}>{row.displayNumber}</Link>
                    ) : (
                      ""
                    );
                  case "text":
                    if (row.kind === "opening") return <strong>Ingående saldo</strong>;
                    if (row.kind === "closing") return <strong>Utgående saldo</strong>;
                    return row.description;
                  case "debit":
                    return row.kind === "row" ? <span className="num">{formatMoney(row.debit)}</span> : "";
                  case "credit":
                    return row.kind === "row" ? <span className="num">{formatMoney(row.credit)}</span> : "";
                  case "saldo":
                    return (
                      <span className="num" style={row.kind !== "row" ? { fontWeight: 600 } : undefined}>
                        {formatMoney(row.balance)}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            />
          </div>
        ))}
    </>
  );
}

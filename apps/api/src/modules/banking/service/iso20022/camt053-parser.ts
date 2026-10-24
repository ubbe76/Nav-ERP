import { createHash } from "node:crypto";
import type { BankStatementEntryDetails } from "@navet/db";
import { normalizeBankIdentifier, round2 } from "@navet/shared";
import { BankFileParseError, BankStatementFormatError } from "../banking.errors.js";
import { amountOf, dateOf } from "./camt054-parser.js";
import { child, children, parseXml, path, textAt, type XmlNode } from "./xml-reader.js";

export const CAMT053_NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.02";

// Bankavstämning: the account statement (kontoutdrag). Pure — reads a
// camt.053.001.02 on the same linear reader as camt.054 (DOCTYPE/ENTITY
// refused, node budget) and returns one statement per Stmt with its
// balances and one entry per Ntry. A collective entry (several TxDtls) stays
// ONE entry with the transactions listed in `details`: that is what the
// bank booked, and the matching compares it with the bookkeeping as a whole
// (several payments booked from a camt.054 can be matched against it).

export interface ParsedStatementEntry {
  bookingDate: string;
  valueDate: string | null;
  // Signed in the account's currency: + = money in (CRDT).
  amount: number;
  currency: string;
  text: string;
  reference: string | null;
  counterparty: string | null;
  reversal: boolean;
  // Every bank reference the camt.054 side can carry too (Ntry/AcctSvcrRef,
  // TxDtls/Refs/AcctSvcrRef, EndToEndId) — the reference matching's key set.
  references: string[];
  details: BankStatementEntryDetails;
  dedupeKey: string;
  position: number;
}

export interface ParsedStatement {
  statementId: string | null;
  // Acct/Id as written and normalised (IBAN or Othr/Id).
  accountRaw: string | null;
  accountIdentifier: string | null;
  currency: string | null;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  closingBalanceDate: string | null;
  entries: ParsedStatementEntry[];
}

export interface ParsedCamt053 {
  messageId: string;
  createdAt: string | null;
  statements: ParsedStatement[];
  warnings: string[];
}

// bank_statement_entries.dedupe_key varchar(160).
export const STATEMENT_DEDUPE_KEY_MAX = 160;
const TEXT_MAX = 255;
const REFERENCE_MAX = 140;

const clip = (value: string) => (value.length > 40 ? `${value.slice(0, 40)}…` : value);
const cut = (value: string | null, max: number) => (value === null ? null : value.length > max ? value.slice(0, max) : value);

// Is the text an identifier the camt.054 side would repeat? "NOTPROVIDED"
// is ISO's own "nothing here".
const usable = (value: string | null): value is string => value !== null && value.toUpperCase() !== "NOTPROVIDED";

function balanceOf(bal: XmlNode): { code: string | null; amount: number; date: string | null } | null {
  const money = amountOf(child(bal, "Amt"));
  if (!money) return null;
  const debit = textAt(bal, "CdtDbtInd") === "DBIT";
  return {
    code: textAt(bal, "Tp", "CdOrPrtry", "Cd"),
    amount: round2(debit ? -money.amount : money.amount),
    date: dateOf(child(bal, "Dt"), "saldodag"),
  };
}

// The statement's opening/closing BOOKED balances (OPBD/CLBD); the available
// ones (OPAV/CLAV) only when a bank reports no booked balance. A statement
// over several days may carry one CLBD per day — the latest wins.
function balances(stmt: XmlNode) {
  const all = children(stmt, "Bal")
    .map(balanceOf)
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const pick = (codes: string[], latest: boolean) => {
    for (const code of codes) {
      const candidates = all.filter((b) => b.code === code);
      if (candidates.length === 0) continue;
      const sorted = [...candidates].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
      return latest ? sorted[sorted.length - 1]! : sorted[0]!;
    }
    return null;
  };
  return { opening: pick(["OPBD", "OPAV"], false), closing: pick(["CLBD", "CLAV"], true) };
}

function referencesOf(strd: XmlNode | null): { type: string; value: string }[] {
  const refs: { type: string; value: string }[] = [];
  if (!strd) return refs;
  for (const doc of children(strd, "RfrdDocInf")) {
    const type = textAt(doc, "Tp", "CdOrPrtry", "Cd");
    const value = textAt(doc, "Nb");
    if (type && value) refs.push({ type, value });
  }
  const creditorRef = textAt(strd, "CdtrRefInf", "Ref");
  if (creditorRef) refs.push({ type: "SCOR", value: creditorRef });
  return refs;
}

// The date part of FrDtTm/ToDtTm — "2026-09-30T23:59:59+02:00" → 2026-09-30.
function dateTimeDate(node: XmlNode | null): string | null {
  const value = node?.text.trim();
  if (!value) return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BankFileParseError(`Ogiltig periodangivelse i filen: "${clip(value)}"`);
  return date;
}

function parseStatement(stmt: XmlNode, fileDate: string | null, warnings: string[], usedKeys: Set<string>, counter: { position: number }): ParsedStatement {
  const acct = child(stmt, "Acct");
  const accountRaw = textAt(acct, "Id", "IBAN") ?? textAt(acct, "Id", "Othr", "Id");
  const accountIdentifier = accountRaw ? normalizeBankIdentifier(accountRaw) : null;
  const account = accountIdentifier ?? "okänt-konto";
  const currency = textAt(acct, "Ccy");
  const period = child(stmt, "FrToDt");
  const { opening, closing } = balances(stmt);
  const hashCounts = new Map<string, number>();
  const entries: ParsedStatementEntry[] = [];

  children(stmt, "Ntry").forEach((ntry, ntryIndex) => {
    const status = textAt(ntry, "Sts");
    if (status !== "BOOK") {
      warnings.push(`Post ${ntryIndex + 1} med status ${status ? status.slice(0, 10) : "?"} hoppades över (bara bokförda poster läses)`);
      return;
    }
    const money = amountOf(child(ntry, "Amt"));
    if (!money) {
      warnings.push(`Post ${ntryIndex + 1} saknar belopp och hoppades över`);
      return;
    }
    const debit = textAt(ntry, "CdtDbtInd") === "DBIT";
    const amount = round2(debit ? -money.amount : money.amount);
    if (amount === 0) {
      warnings.push(`Post ${ntryIndex + 1} har belopp 0 och hoppades över`);
      return;
    }
    const reversalFlag = textAt(ntry, "RvslInd");
    const reversal = reversalFlag === "true" || reversalFlag === "1";
    const valueDate = dateOf(child(ntry, "ValDt"), "valutadag");
    const bookingDate = dateOf(child(ntry, "BookgDt"), "bokföringsdag") ?? valueDate ?? fileDate;
    if (!bookingDate) {
      warnings.push(`Post ${ntryIndex + 1} saknar bokföringsdag och hoppades över`);
      return;
    }
    const ntryRef = textAt(ntry, "NtryRef");
    const ntryAcctSvcrRef = textAt(ntry, "AcctSvcrRef");
    const additionalInfo = textAt(ntry, "AddtlNtryInf");
    const bankTransactionCode = textAt(ntry, "BkTxCd", "Prtry", "Cd") ?? textAt(ntry, "BkTxCd", "Domn", "Fmly", "SubFmlyCd") ?? textAt(ntry, "BkTxCd", "Domn", "Fmly", "Cd");

    // Money in and not a reversal: the other party is the debtor; money out
    // (or a credit that reverses our payment): the creditor. Banks are not
    // consistent, so the other role is the fallback.
    const [party, otherParty] = !debit !== reversal ? ["Dbtr", "Cdtr"] : ["Cdtr", "Dbtr"];
    const txs = children(ntry, "NtryDtls").flatMap((details) => children(details, "TxDtls"));
    const transactions = txs.map((tx) => {
      const refs = child(tx, "Refs");
      const rawEndToEnd = textAt(refs, "EndToEndId");
      const ustrd = children(child(tx, "RmtInf"), "Ustrd")
        .map((u) => u.text.trim())
        .filter(Boolean);
      const strdRefs = children(child(tx, "RmtInf"), "Strd").flatMap((s) => referencesOf(s));
      return {
        acctSvcrRef: textAt(refs, "AcctSvcrRef"),
        endToEndId: usable(rawEndToEnd) ? rawEndToEnd : null,
        amount: amountOf(path(tx, "AmtDtls", "TxAmt", "Amt"))?.amount ?? null,
        counterparty: textAt(tx, "RltdPties", party, "Nm") ?? textAt(tx, "RltdPties", otherParty, "Nm"),
        references: [...strdRefs, ...ustrd.map((value) => ({ type: "USTRD", value }))],
        additionalInfo: textAt(tx, "AddtlTxInf"),
      };
    });
    const single = transactions.length === 1 ? transactions[0]! : null;

    // What the user sees in the list: the bank's own line text, else the
    // one transaction's free text / party, else the transaction code.
    const text =
      additionalInfo ??
      single?.additionalInfo ??
      single?.references.find((r) => r.type === "USTRD")?.value ??
      single?.counterparty ??
      (transactions.length > 1 ? `Samlingspost (${transactions.length} transaktioner)` : null) ??
      bankTransactionCode ??
      "Bankpost";
    const reference = single
      ? single.references.find((r) => r.type === "SCOR")?.value ?? single.references.find((r) => r.type === "CINV" || r.type === "CREN")?.value ?? single.endToEndId
      : null;
    const counterparty = single?.counterparty ?? (transactions.length > 1 && transactions.every((t) => t.counterparty === transactions[0]!.counterparty) ? transactions[0]!.counterparty : null);

    const references = [
      ...(usable(ntryAcctSvcrRef) ? [ntryAcctSvcrRef] : []),
      ...transactions.flatMap((t) => [...(usable(t.acctSvcrRef) ? [t.acctSvcrRef] : []), ...(t.endToEndId ? [t.endToEndId] : [])]),
    ];

    // dedupe_key: the bank's reference for the entry (Ntry/AcctSvcrRef, or
    // the one transaction's) prefixed with the account; otherwise a hash of
    // day, amount and text with a per-file counter. NtryRef is never used:
    // Nordea's is a per-file counter.
    const bankRef = usable(ntryAcctSvcrRef) ? ntryAcctSvcrRef : single && usable(single.acctSvcrRef) ? single.acctSvcrRef : null;
    let dedupeKey: string;
    if (bankRef) dedupeKey = `${account}|ntry:${bankRef}`;
    else {
      const base = createHash("sha256").update(JSON.stringify([account, bookingDate, amount.toFixed(2), text])).digest("hex");
      const n = (hashCounts.get(base) ?? 0) + 1;
      hashCounts.set(base, n);
      dedupeKey = `${account}|hash:${base}#${n}`;
    }
    if (usedKeys.has(dedupeKey)) {
      const first = dedupeKey;
      for (let n = 2; usedKeys.has(dedupeKey); n++) dedupeKey = `${first}#${n}`;
      warnings.push(`Post ${ntryIndex + 1} har samma bankreferens som en tidigare post i filen — den läses in som en egen post. Kontrollera att den inte är dubblerad.`);
    }
    if (dedupeKey.length > STATEMENT_DEDUPE_KEY_MAX) throw new BankFileParseError(`Bankreferensen för post ${ntryIndex + 1} är för lång: "${clip(dedupeKey)}"`);
    usedKeys.add(dedupeKey);

    entries.push({
      bookingDate,
      valueDate,
      amount,
      currency: money.currency.slice(0, 3),
      text: text.slice(0, TEXT_MAX),
      reference: cut(reference, REFERENCE_MAX),
      counterparty: cut(counterparty, REFERENCE_MAX),
      reversal,
      references: [...new Set(references)],
      details: {
        ntryRef,
        acctSvcrRef: ntryAcctSvcrRef,
        bankTransactionCode,
        additionalInfo,
        transactions,
      },
      dedupeKey,
      position: counter.position++,
    });
  });

  const dates = entries.map((e) => e.bookingDate).sort();
  return {
    statementId: textAt(stmt, "Id"),
    accountRaw,
    accountIdentifier,
    currency,
    fromDate: dateTimeDate(child(period, "FrDtTm")) ?? dates[0] ?? null,
    toDate: dateTimeDate(child(period, "ToDtTm")) ?? dates[dates.length - 1] ?? null,
    openingBalance: opening?.amount ?? null,
    closingBalance: closing?.amount ?? null,
    closingBalanceDate: closing ? closing.date ?? dateTimeDate(child(period, "ToDtTm")) ?? dates[dates.length - 1] ?? null : null,
    entries,
  };
}

export function parseCamt053(xml: string): ParsedCamt053 {
  const { root, namespace } = parseXml(xml);
  const message = child(root, "BkToCstmrStmt");
  if (root.name !== "Document" || namespace !== CAMT053_NAMESPACE || !message) throw new BankStatementFormatError(namespace);
  const messageId = textAt(message, "GrpHdr", "MsgId");
  if (!messageId) throw new BankFileParseError("Filen saknar GrpHdr/MsgId");
  const createdAt = textAt(message, "GrpHdr", "CreDtTm");
  const fileDate = createdAt && /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : null;
  const warnings: string[] = [];
  const usedKeys = new Set<string>();
  const counter = { position: 0 };
  const statements = children(message, "Stmt").map((stmt) => parseStatement(stmt, fileDate, warnings, usedKeys, counter));
  if (statements.length === 0) throw new BankFileParseError("Filen innehåller inget kontoutdrag (Stmt)");
  return { messageId, createdAt, statements, warnings };
}

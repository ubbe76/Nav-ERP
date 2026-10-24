import { createHash } from "node:crypto";
import type { BankEntryCurrencyExchange, BankEntryReference } from "@navet/db";
import { round2 } from "@navet/shared";
import { addDays } from "../banking-dates.js";
import { BankFileParseError, UnsupportedBankMessageError } from "../banking.errors.js";
import { child, children, parseXml, path, textAt, type XmlNode } from "./xml-reader.js";

export const CAMT054_NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:camt.054.001.02";

export type DedupeSource = "tx_acct_svcr_ref" | "clr_sys_ref" | "entry_ref" | "content_hash";

export interface ParsedEntry {
  account: string;
  direction: "credit" | "debit";
  reversal: boolean;
  amount: number;
  currency: string;
  bookingDate: string;
  valueDate: string | null;
  endToEndId: string | null;
  msgId: string | null;
  pmtInfId: string | null;
  counterpartyName: string | null;
  remittance: BankEntryReference[];
  returnReason: string | null;
  dedupeKey: string;
  dedupeSource: DedupeSource;
  position: number;
  // Valuta steg 2. `amount`/`currency` are always the entry's own amount in
  // the account's currency (TxAmt — for a payment in EUR from a SEK account,
  // the SEK that left it). The instructed amount (InstdAmt) is kept when it
  // is in another currency, with the bank's exchange details, and the
  // charges the bank reports as included in the entry amount.
  instructedAmount: number | null;
  instructedCurrency: string | null;
  currencyExchange: BankEntryCurrencyExchange | null;
  chargesAmount: number | null;
}

export interface ParsedCamt054 {
  messageId: string;
  createdAt: string | null;
  entries: ParsedEntry[];
  warnings: string[];
}

// What the database columns take — anything else is refused up front as a
// 400 parse error instead of failing the INSERT with a 500.
const DEDUPE_KEY_MAX = 120; // bank_file_entries.dedupe_key varchar(120)
const AMOUNT_MAX = 999_999_999_999.99; // numeric(14,2)
// xs:decimal: digits with an optional point and sign — no exponent, no hex
// (Number() would read "0x64" as 100 and "1e2" as 100).
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Values from the upload are echoed in the 400 — clipped like the reader's.
const clip = (value: string) => (value.length > 40 ? `${value.slice(0, 40)}…` : value);

// xs:date's own rules: 2024-02-30 and 2024-13-01 are no dates (the pattern
// alone would pass them), and Postgres has no year 0.
const isCalendarDate = (date: string) =>
  ISO_DATE.test(date) && !date.startsWith("0000") && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && addDays(date, 0) === date;

function amountOf(node: XmlNode | null): { amount: number; currency: string } | null {
  if (!node) return null;
  const raw = node.text.trim();
  if (!DECIMAL.test(raw)) throw new BankFileParseError(`Ogiltigt belopp i filen: "${clip(raw)}"`);
  const amount = round2(Number(raw));
  if (Math.abs(amount) > AMOUNT_MAX) throw new BankFileParseError(`Beloppet ${clip(raw)} är för stort`);
  return { amount, currency: node.attrs.Ccy ?? "SEK" };
}

// The date part of Dt or DtTm; `what` names it in the error.
function dateOf(node: XmlNode | null, what: string): string | null {
  const value = textAt(node, "Dt") ?? textAt(node, "DtTm");
  if (!value) return null;
  const date = value.slice(0, 10);
  if (!isCalendarDate(date)) throw new BankFileParseError(`Ogiltig ${what} i filen: "${clip(value)}"`);
  return date;
}

function accountOf(acct: XmlNode | null): string {
  return textAt(acct, "Id", "IBAN") ?? textAt(acct, "Id", "Othr", "Id") ?? "okänt-konto";
}

function remittanceOf(rmtInf: XmlNode | null): BankEntryReference[] {
  const refs: BankEntryReference[] = [];
  for (const ustrd of children(rmtInf, "Ustrd")) {
    const value = ustrd.text.trim();
    if (value) refs.push({ type: "USTRD", value, amount: null });
  }
  for (const strd of children(rmtInf, "Strd")) {
    const strdAmount = amountOf(path(strd, "RfrdDocAmt", "RmtdAmt")) ?? amountOf(path(strd, "RfrdDocAmt", "CdtNoteAmt"));
    const docs = children(strd, "RfrdDocInf");
    for (const doc of docs) {
      const type = textAt(doc, "Tp", "CdOrPrtry", "Cd");
      const value = textAt(doc, "Nb");
      if ((type === "CINV" || type === "CREN") && value) {
        refs.push({ type, value, amount: docs.length === 1 && strdAmount ? strdAmount.amount : null });
      }
    }
    const creditorRef = textAt(strd, "CdtrRefInf", "Ref");
    if (creditorRef) refs.push({ type: "SCOR", value: creditorRef, amount: docs.length === 0 && strdAmount ? strdAmount.amount : null });
    for (const addtl of children(strd, "AddtlRmtInf")) {
      const value = addtl.text.trim();
      if (value) refs.push({ type: "ADDTL", value, amount: null });
    }
  }
  return refs;
}

// TxAmt/CcyXchg (or InstdAmt/CcyXchg) as the bank wrote it — display only,
// the booking never computes with the rate. A rate that is no decimal is
// left out rather than failing the file.
function currencyExchangeOf(...amountDetails: (XmlNode | null)[]): BankEntryCurrencyExchange | null {
  for (const details of amountDetails) {
    const xchg = child(details, "CcyXchg");
    if (!xchg) continue;
    const sourceCurrency = textAt(xchg, "SrcCcy");
    const rate = textAt(xchg, "XchgRate");
    if (!sourceCurrency || !rate || !DECIMAL.test(rate)) continue;
    return { sourceCurrency: sourceCurrency.slice(0, 3), targetCurrency: textAt(xchg, "TrgtCcy")?.slice(0, 3) ?? null, unitCurrency: textAt(xchg, "UnitCcy")?.slice(0, 3) ?? null, rate: rate.slice(0, 20) };
  }
  return null;
}

// Charges debited separately (Handelsbanken's proprietary MCOM/QCOM/YCOM/
// SCOM: "These code is used when the charges are debited separately") are
// not part of the entry; everything else the bank reports in the entry's
// TxDtls is (SEB: TxAmt is "the net amount of the underlying transaction
// including charges expressed in the currency of the posting account";
// Handelsbanken: Cd COMM "Used when charges is included in the entry
// amount"; Swedbank: Chrgs "included in the credited amount or booked
// separately", Br DEBT/SHAR). Only charges in the account's currency,
// debited, and borne by US count — and who we are depends on the entry's
// direction (ISO 20022 ChargeBearerType1Code: DEBT = "borne by the debtor",
// CRED = "borne by the creditor", SHAR = each party its own bank's): on a
// debit (our payment) we are the debtor, so creditor-borne charges (CRED)
// are the payee's; on a credit (money in) we are the creditor, so
// debtor-borne charges (DEBT) are the payer's — while CRED charges there
// are ours, taken from what came in (a bank fee, not a kursförlust).
const SEPARATELY_DEBITED_CHARGES = new Set(["MCOM", "QCOM", "YCOM", "SCOM"]);
function includedCharges(nodes: XmlNode[], accountCurrency: string, direction: "credit" | "debit"): number | null {
  const othersBearer = direction === "credit" ? "DEBT" : "CRED";
  let total = 0;
  let found = false;
  for (const charge of nodes) {
    const money = amountOf(child(charge, "Amt"));
    if (!money || money.currency !== accountCurrency || money.amount <= 0) continue;
    const indicator = textAt(charge, "CdtDbtInd");
    if (indicator && indicator !== "DBIT") continue;
    if (textAt(charge, "Br") === othersBearer) continue;
    const proprietary = textAt(charge, "Tp", "Prtry", "Id");
    if (proprietary && SEPARATELY_DEBITED_CHARGES.has(proprietary.toUpperCase())) continue;
    total += money.amount;
    found = true;
  }
  return found ? round2(total) : null;
}

// Spec §3.5: one ParsedEntry per TxDtls (an Ntry without TxDtls becomes one
// entry). dedupe_key, first available: TxDtls/Refs/AcctSvcrRef → ClrSysRef →
// Ntry/AcctSvcrRef#index → content hash #n. Always prefixed with the account.
// NtryRef is never used: Nordea's is a per-file counter.
export function parseCamt054(xml: string): ParsedCamt054 {
  const { root, namespace } = parseXml(xml);
  const message = child(root, "BkToCstmrDbtCdtNtfctn");
  if (root.name !== "Document" || namespace !== CAMT054_NAMESPACE || !message) throw new UnsupportedBankMessageError(namespace);
  const messageId = textAt(message, "GrpHdr", "MsgId");
  if (!messageId) throw new BankFileParseError("Filen saknar GrpHdr/MsgId");
  const createdAt = textAt(message, "GrpHdr", "CreDtTm");
  // The file's date is only a fallback booking day — an unreadable one is
  // simply not used (the entry then carries its own or is skipped).
  const fileDate = createdAt && isCalendarDate(createdAt.slice(0, 10)) ? createdAt.slice(0, 10) : null;

  const warnings: string[] = [];
  const entries: ParsedEntry[] = [];
  const hashCounts = new Map<string, number>();
  // Every key this file has handed out, to keep a repeated bank reference
  // from silently collapsing two transactions into one (the unique index
  // would drop the second).
  const usedKeys = new Set<string>();
  let position = 0;

  for (const notification of children(message, "Ntfctn")) {
    const account = accountOf(child(notification, "Acct"));
    children(notification, "Ntry").forEach((ntry, ntryIndex) => {
      const status = textAt(ntry, "Sts");
      if (status !== "BOOK") {
        warnings.push(`Post med status ${status ? status.slice(0, 10) : "?"} hoppades över (bara bokförda poster läses)`);
        return;
      }
      const direction = textAt(ntry, "CdtDbtInd") === "DBIT" ? "debit" : "credit";
      // xs:boolean: "true" or "1".
      const reversalFlag = textAt(ntry, "RvslInd");
      const reversal = reversalFlag === "true" || reversalFlag === "1";
      const valueDate = dateOf(child(ntry, "ValDt"), "valutadag");
      const bookingDate = dateOf(child(ntry, "BookgDt"), "bokföringsdag") ?? valueDate ?? fileDate;
      const ntryRef = textAt(ntry, "AcctSvcrRef");
      const ntryAmount = amountOf(child(ntry, "Amt"));
      if (!bookingDate) {
        warnings.push(`Post ${ntryIndex + 1} saknar bokföringsdag och hoppades över`);
        return;
      }
      const txs = children(ntry, "NtryDtls").flatMap((details) => children(details, "TxDtls"));
      const units: (XmlNode | null)[] = txs.length > 0 ? txs : [null];
      const single = units.length === 1;
      units.forEach((tx, txIndex) => {
        // The amount details: the transaction's own, and — for an entry with
        // one transaction — the entry's (Ntry/AmtDtls) as the fallback.
        const txDetails = tx ? child(tx, "AmtDtls") : null;
        const ntryDetails = single ? child(ntry, "AmtDtls") : null;
        const txAmount = amountOf(path(txDetails, "TxAmt", "Amt")) ?? amountOf(path(ntryDetails, "TxAmt", "Amt"));
        const instructed = amountOf(path(txDetails, "InstdAmt", "Amt")) ?? amountOf(path(ntryDetails, "InstdAmt", "Amt"));
        // The entry's own amount is in the account's currency: TxAmt; the
        // instructed amount only when it is in that same currency (a SEK
        // payment); else the entry amount of a one-transaction entry. A
        // multi-transaction entry with nothing but a foreign InstdAmt keeps
        // that amount in its own currency (Annan valuta).
        let money: { amount: number; currency: string } | null;
        if (txAmount) money = txAmount;
        else if (instructed && (!ntryAmount || instructed.currency === ntryAmount.currency)) money = instructed;
        else if (single) money = ntryAmount;
        else money = instructed;
        if (!money) {
          warnings.push(`Belopp saknas för transaktion ${txIndex + 1} i post ${ntryIndex + 1}`);
          return;
        }
        const foreignInstructed = instructed && instructed.currency !== money.currency && instructed.amount > 0 ? instructed : null;
        // The amount the content hash is taken over is the one the parser
        // read before Valuta (the transaction's TxAmt, else its InstdAmt in
        // whatever currency, else a one-transaction entry's Ntry/Amt) — not
        // `money`, which now prefers the entry's own amount in the account's
        // currency. A file read before the upgrade and read again after it
        // must give the same key, or every hash-keyed entry would come in
        // twice.
        const legacyAmount =
          (tx ? amountOf(path(txDetails, "TxAmt", "Amt")) ?? amountOf(path(txDetails, "InstdAmt", "Amt")) : null) ?? (single ? ntryAmount : null) ?? money;
        if (money.amount <= 0) {
          // Nordea (Sweden): "Zero amount is possible" — unexplained, so the
          // transaction is noted and skipped like any other zero.
          warnings.push(
            foreignInstructed
              ? `Transaktion ${txIndex + 1} i post ${ntryIndex + 1} har belopp 0 i kontots valuta (instruerat ${foreignInstructed.amount.toFixed(2)} ${foreignInstructed.currency}) och hoppades över — kontrollera betalningen i internetbanken`
              : `Transaktion ${txIndex + 1} i post ${ntryIndex + 1} har ett belopp som är negativt eller 0 och hoppades över`
          );
          return;
        }
        const refs = tx ? child(tx, "Refs") : null;
        const rawEndToEnd = textAt(refs, "EndToEndId");
        const endToEndId = rawEndToEnd && rawEndToEnd.toUpperCase() !== "NOTPROVIDED" ? rawEndToEnd : null;
        const remittance = tx ? remittanceOf(child(tx, "RmtInf")) : [];
        // The other party: the payer on money in, the payee on money out. A
        // return (credit + reversal) is our own payment coming back, so its
        // party is the original Cdtr. Banks are not consistent here, so the
        // other role is the fallback.
        const [party, otherParty] = (direction === "credit") !== reversal ? ["Dbtr", "Cdtr"] : ["Cdtr", "Dbtr"];
        const counterpartyName = tx ? textAt(tx, "RltdPties", party, "Nm") ?? textAt(tx, "RltdPties", otherParty, "Nm") : null;
        const txRef = textAt(refs, "AcctSvcrRef");
        const clrRef = textAt(refs, "ClrSysRef");
        let dedupeKey: string;
        let dedupeSource: DedupeSource;
        if (txRef) [dedupeKey, dedupeSource] = [`${account}|tx:${txRef}`, "tx_acct_svcr_ref"];
        else if (clrRef) [dedupeKey, dedupeSource] = [`${account}|clr:${clrRef}`, "clr_sys_ref"];
        else if (ntryRef) [dedupeKey, dedupeSource] = [`${account}|ntry:${ntryRef}#${txIndex}`, "entry_ref"];
        else {
          const base = createHash("sha256")
            .update(JSON.stringify([account, bookingDate, direction, reversal, legacyAmount.amount.toFixed(2), endToEndId, counterpartyName, remittance]))
            .digest("hex");
          const n = (hashCounts.get(base) ?? 0) + 1;
          hashCounts.set(base, n);
          [dedupeKey, dedupeSource] = [`${account}|hash:${base}#${n}`, "content_hash"];
        }
        // The same reference twice in one file: the repeat gets #2 (#3, …),
        // deterministic from file order, so re-reading the file — or an
        // overlapping one with the same repeat — yields the same keys.
        if (usedKeys.has(dedupeKey)) {
          const first = dedupeKey;
          for (let n = 2; usedKeys.has(dedupeKey); n++) dedupeKey = `${first}#${n}`;
          warnings.push(
            `Transaktion ${txIndex + 1} i post ${ntryIndex + 1} har samma bankreferens som en tidigare transaktion i filen — den läses in som en egen post. Kontrollera att den inte är dubblerad.`
          );
        }
        if (dedupeKey.length > DEDUPE_KEY_MAX) throw new BankFileParseError(`Bankreferensen för transaktion ${txIndex + 1} i post ${ntryIndex + 1} är för lång: "${clip(dedupeKey)}"`);
        usedKeys.add(dedupeKey);
        entries.push({
          account,
          direction,
          reversal,
          amount: money.amount,
          currency: money.currency,
          bookingDate,
          valueDate,
          endToEndId,
          msgId: textAt(refs, "MsgId"),
          pmtInfId: textAt(refs, "PmtInfId"),
          counterpartyName,
          remittance,
          returnReason: tx ? textAt(tx, "RtrInf", "Rsn", "Cd") : null,
          dedupeKey,
          dedupeSource,
          position: position++,
          instructedAmount: foreignInstructed?.amount ?? null,
          instructedCurrency: foreignInstructed?.currency.slice(0, 3) ?? null,
          currencyExchange: currencyExchangeOf(child(txDetails, "TxAmt"), child(txDetails, "InstdAmt"), child(ntryDetails, "TxAmt"), child(ntryDetails, "InstdAmt")),
          // The transaction's charges; the entry's only for a one-transaction
          // entry that reports none of its own (never both — no double count).
          chargesAmount: includedCharges(tx && children(tx, "Chrgs").length > 0 ? children(tx, "Chrgs") : single ? children(ntry, "Chrgs") : [], money.currency, direction),
        });
      });
    });
  }
  return { messageId, createdAt, entries, warnings };
}

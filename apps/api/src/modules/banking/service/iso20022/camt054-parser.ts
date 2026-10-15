import { createHash } from "node:crypto";
import type { BankEntryReference } from "@navet/db";
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
      units.forEach((tx, txIndex) => {
        const own = tx ? amountOf(path(tx, "AmtDtls", "TxAmt", "Amt")) ?? amountOf(path(tx, "AmtDtls", "InstdAmt", "Amt")) : null;
        const money = own ?? (units.length === 1 ? ntryAmount : null);
        if (!money) {
          warnings.push(`Belopp saknas för transaktion ${txIndex + 1} i post ${ntryIndex + 1}`);
          return;
        }
        if (money.amount <= 0) {
          warnings.push(`Transaktion ${txIndex + 1} i post ${ntryIndex + 1} har ett belopp som är negativt eller 0 och hoppades över`);
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
            .update(JSON.stringify([account, bookingDate, direction, reversal, money.amount.toFixed(2), endToEndId, counterpartyName, remittance]))
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
        });
      });
    });
  }
  return { messageId, createdAt, entries, warnings };
}
